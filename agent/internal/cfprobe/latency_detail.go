package cfprobe

// Custom v1: reuse existing network probes, keep raw samples separately.
// Upload minute blocks over HTTPS; resource WSS cadence does not change.
import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"
)

type latencySample struct {
	T int64  `json:"t"`
	P int    `json:"p"`
	R *int   `json:"r"` // null = failed attempt, never 0ms or cached successful RTT
	K string `json:"k"` // protocol/target identity; no target addresses exposed in history
}
type latencyBlock struct {
	Minute  int64           `json:"minute"`
	Samples []latencySample `json:"samples"`
}
type latencyBuffer struct {
	mu     sync.Mutex
	blocks map[int64][]latencySample
	sealed int64
	live   []latencySample // latency.3: recent accepted samples, echoed in realtime reports
}

// latency.3: recent raw samples ride along in every existing report (WSS/POST) as
// metrics.latency_live, so the dashboard can draw them within seconds. They are the
// exact samples later uploaded in minute blocks; no extra request is made.
// latency.5: the echo covers 150s, longer than the newest minute block can take
// to reach the Worker, so a page opened at any moment has no gap between the
// stored history and the live samples (8 routes x 7.5 samples <= 72).
const (
	latencyLiveWindow = 150 * time.Second
	latencyLiveKeep   = 180 * time.Second
	latencyLiveMax    = 72
)

// latency.5: upload each minute block shortly after the minute closes instead of
// on a ticker with an arbitrary phase, so stored history lags by ~1 minute at most.
const latencyUploadDelay = 3 * time.Second

func nextLatencyUpload(now time.Time) time.Duration {
	wait := now.Truncate(time.Minute).Add(latencyUploadDelay).Sub(now)
	if wait <= 0 {
		wait += time.Minute
	}
	return wait
}

func (b *latencyBuffer) add(s latencySample) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	minute := s.T / 60000
	if minute <= b.sealed {
		return false
	} // closed blocks are immutable, including clock rollback
	if b.blocks == nil {
		b.blocks = make(map[int64][]latencySample)
	}
	for m := range b.blocks {
		if m < minute-30 {
			delete(b.blocks, m)
		}
	}
	existing := b.blocks[minute]
	if len(existing) >= 32 {
		return false
	}
	for i := len(existing) - 1; i >= 0; i-- {
		if existing[i].P == s.P {
			if s.T-existing[i].T < 15000 {
				return false
			}
			break
		}
	}
	b.blocks[minute] = append(existing, s)
	b.live = append(b.live, s)
	keepFrom := 0
	for keepFrom < len(b.live) && (b.live[keepFrom].T < s.T-latencyLiveKeep.Milliseconds() || len(b.live)-keepFrom > latencyLiveMax) {
		keepFrom++
	}
	b.live = append([]latencySample(nil), b.live[keepFrom:]...)
	return true
}

func (b *latencyBuffer) liveSince(since int64) []latencySample {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := []latencySample{}
	for _, s := range b.live {
		if s.T >= since {
			out = append(out, s)
		}
	}
	return out
}

func (a *Agent) attachLatencyLive(metrics map[string]any, reportAt time.Time) {
	stamp, calibrated := a.clock.timestamp(reportAt)
	if !calibrated {
		return
	}
	if live := a.latency.liveSince(stamp - latencyLiveWindow.Milliseconds()); len(live) > 0 {
		metrics["latency_live"] = live
	}
}

func (b *latencyBuffer) pending(now int64) []latencyBlock {
	b.mu.Lock()
	defer b.mu.Unlock()
	cutoff := now / 60000
	if cutoff-1 > b.sealed {
		b.sealed = cutoff - 1
	}
	keys := []int64{}
	for m := range b.blocks {
		if m < cutoff-30 {
			delete(b.blocks, m)
			continue
		}
		if m < cutoff {
			keys = append(keys, m)
		}
	}
	sort.Slice(keys, func(i, j int) bool { return keys[i] < keys[j] })
	if len(keys) > 5 {
		keys = keys[:5]
	}
	out := make([]latencyBlock, 0, len(keys))
	for _, m := range keys {
		out = append(out, latencyBlock{m, append([]latencySample(nil), b.blocks[m]...)})
	}
	return out
}
func (b *latencyBuffer) ack(minutes []int64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, m := range minutes {
		delete(b.blocks, m)
	}
}

func (a *Agent) measureWithDetail(cfg Config, index int, target string) ProbeResult {
	result := measureProbe(cfg.PingMode, target, metricsProbeSampleCount, defaultMetricsTCPPort, a.log)
	if !cfg.LatencyDetail || strings.TrimSpace(target) == "" {
		return result
	}
	stamp, calibrated := a.clock.timestamp(time.Now())
	if !calibrated {
		return result
	} // wait for Worker Date calibration before recording raw timestamps
	digest := sha256.Sum256([]byte(cfg.PingMode + "|" + target))
	sample := latencySample{T: stamp, P: index, K: hex.EncodeToString(digest[:8])}
	if result.OK && result.RTTMs >= 0 {
		r := result.RTTMs
		sample.R = &r
	}
	a.latency.add(sample)
	return result
}

func latencyEndpoint(workerURL string) (string, error) {
	u, err := url.Parse(workerURL)
	if err != nil {
		return "", err
	}
	if u.Scheme != "https" {
		return "", fmt.Errorf("latency upload requires HTTPS")
	}
	if u.User != nil {
		return "", fmt.Errorf("credentials in URL are not supported")
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/latency"
	u.RawQuery = ""
	u.Fragment = ""
	return u.String(), nil
}

// A healthy WSS session may outlive the clock calibration's 24-hour validity.
// Reuse the existing minute upload response to renew it without extra requests.
// Within the upstream correction threshold, preserve the calibrated timeline
// instead of introducing jumps from the HTTP Date header's one-second precision.
func (a *Agent) observeLatencyUploadResponse(status int, headers http.Header, started, received time.Time) bool {
	if status != http.StatusOK {
		return false
	}
	dateTime, ok := responseDateTime(headers)
	if !ok {
		return false
	}
	calibration := newDateCalibration(dateTime, received.Sub(started), received)
	a.clock.mu.Lock()
	defer a.clock.mu.Unlock()
	if current := a.clock.calibrationAt(received, false); current != nil {
		if absoluteDifference(current.timestamp(received), calibration.accurateAtAnchor) <= uint64(dateCalibrationThreshold/time.Millisecond) {
			calibration = *current
			calibration.accurateAtAnchor = current.timestamp(received)
			calibration.anchor = received
		}
	}
	a.clock.calibration = &calibration
	return true
}

func (a *Agent) latencyUploadWorker(ctx context.Context) {
	timer := time.NewTimer(nextLatencyUpload(time.Now()))
	defer timer.Stop()
	a.log.info("custom latency enabled: 20s probes, minute blocks, 30min in-memory retry buffer; upstream auto-update disabled")
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			timer.Reset(nextLatencyUpload(time.Now()))
			cfg := a.configSnapshot()
			if !cfg.LatencyDetail {
				continue
			}
			stamp, _ := a.clock.timestamp(time.Now())
			blocks := a.latency.pending(stamp)
			if len(blocks) == 0 {
				continue
			}
			endpoint, err := latencyEndpoint(cfg.WorkerURL)
			if err != nil {
				a.log.info("custom latency endpoint invalid: %v", err)
				continue
			}
			body, err := json.Marshal(struct {
				ID     string         `json:"id"`
				Blocks []latencyBlock `json:"blocks"`
			}{cfg.ServerID, blocks})
			if err != nil {
				continue
			}
			req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
			if err != nil {
				continue
			}
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Authorization", "Bearer "+cfg.Secret)
			req.Header.Set("X-Agent-Version", a.version)
			// Clone the shared client: never follow a redirect carrying the probe secret.
			client := *sharedReportHTTPClient(8*time.Second, usePublicDNSResolver(cfg))
			client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
			started := time.Now()
			resp, err := client.Do(req)
			received := time.Now()
			if err != nil {
				a.log.info("custom latency upload failed; retaining samples: %v", err)
				continue
			}
			var ack struct {
				OK      bool    `json:"ok"`
				Minutes []int64 `json:"minutes"`
			}
			decodeErr := json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&ack)
			resp.Body.Close()
			if resp.StatusCode != 200 || decodeErr != nil || !ack.OK {
				a.log.info("custom latency upload rejected HTTP %d; retaining samples", resp.StatusCode)
				continue
			}
			a.observeLatencyUploadResponse(resp.StatusCode, resp.Header, started, received)
			sent := make(map[int64]bool)
			for _, b := range blocks {
				sent[b.Minute] = true
			}
			valid := []int64{}
			for _, m := range ack.Minutes {
				if sent[m] {
					valid = append(valid, m)
				}
			}
			a.latency.ack(valid)
		}
	}
}
