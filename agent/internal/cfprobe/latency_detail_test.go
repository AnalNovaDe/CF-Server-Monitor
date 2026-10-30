package cfprobe

import (
	"bytes"
	"net/http"
	"path/filepath"
	"testing"
	"time"
)

func TestLatencyBufferRetryAndSealing(t *testing.T) {
	var b latencyBuffer
	r := 300
	b.add(latencySample{T: 60001000, P: 0, R: &r, K: "0123456789abcdef"})
	b.add(latencySample{T: 60021000, P: 0, R: nil, K: "0123456789abcdef"})
	blocks := b.pending(60061000)
	if len(blocks) != 1 || len(blocks[0].Samples) != 2 || *blocks[0].Samples[0].R != 300 || blocks[0].Samples[1].R != nil {
		t.Fatalf("raw spike/failure lost: %+v", blocks)
	}
	b.add(latencySample{T: 60041000, P: 0, R: &r})
	retry := b.pending(60121000)
	if len(retry) != 1 || len(retry[0].Samples) != 2 {
		t.Fatal("closed minute changed on retry")
	}
	b.ack([]int64{blocks[0].Minute})
	if len(b.pending(60121000)) != 0 {
		t.Fatal("ACK did not clear buffer")
	}
}

func TestLatencyBufferBoundedCatchup(t *testing.T) {
	var b latencyBuffer
	for m := int64(1000); m < 1060; m++ {
		b.add(latencySample{T: m*60000 + 1000, P: 0})
	}
	if len(b.blocks) > 31 {
		t.Fatal("retry buffer unbounded")
	}
	batch := b.pending(1060 * 60000)
	if len(batch) != 5 || batch[0].Minute != 1030 {
		t.Fatalf("unexpected ordered catchup: %+v", batch)
	}
	if len(b.pending(1100*60000)) != 0 {
		t.Fatal("expired samples retained")
	}
}

func TestLatencyLocalConfigSurvivesWrite(t *testing.T) {
	p := filepath.Join(t.TempDir(), "config.conf")
	cfg := Config{ServerID: "node", Secret: "test", WorkerURL: "https://example.com/update", LatencyDetail: true}
	if err := writeConfig(p, cfg); err != nil {
		t.Fatal(err)
	}
	read, err := readConfig(p)
	if err != nil || !read.LatencyDetail {
		t.Fatalf("local opt-in lost: %+v %v", read, err)
	}
}

func TestLatencyEndpoint(t *testing.T) {
	u, err := latencyEndpoint("https://example.com/update?private=value")
	if err != nil || u != "https://example.com/update/latency" {
		t.Fatal(u, err)
	}
	if _, err := latencyEndpoint("http://example.com/update"); err == nil {
		t.Fatal("plaintext secret upload allowed")
	}
}

func TestLatencyUploadsKeepCalibratedSamplesPast24Hours(t *testing.T) {
	base := time.Now().Add(-26 * time.Hour).Truncate(time.Second)
	agent := Agent{}
	agent.clock.updateDate(base.UnixMilli(), 0, base)
	for minute := 1; minute <= 26*60; minute++ {
		received := base.Add(time.Duration(minute) * time.Minute)
		// Alternating Date quantization/jitter must not shift the sample timeline.
		date := received.Add(time.Duration(minute%2) * time.Second)
		headers := http.Header{"Date": []string{date.UTC().Format(http.TimeFormat)}}
		if !agent.observeLatencyUploadResponse(http.StatusOK, headers, received, received) {
			t.Fatalf("minute %d: upload Date was not observed", minute)
		}
		observed := received.Add(59 * time.Second)
		stamp, calibrated := agent.clock.timestamp(observed)
		if !calibrated || stamp != observed.UnixMilli() {
			t.Fatalf("minute %d: timestamp=(%d,%v), want (%d,true)", minute, stamp, calibrated, observed.UnixMilli())
		}
	}
	last := base.Add(26 * time.Hour)
	if _, calibrated := agent.clock.timestamp(last.Add(maxCalibrationAge + time.Second)); calibrated {
		t.Fatal("calibration stayed valid without further trusted responses")
	}
}

func TestLatencyUploadClockRejectsUntrustedOrMissingDate(t *testing.T) {
	base := time.Now().Truncate(time.Second)
	cases := []struct {
		name   string
		status int
		header string
	}{
		{"missing", http.StatusOK, ""},
		{"invalid", http.StatusOK, "not-an-http-date"},
		{"failed upload", http.StatusServiceUnavailable, base.UTC().Format(http.TimeFormat)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			agent := Agent{}
			agent.clock.updateDate(base.UnixMilli(), 0, base)
			later := base.Add(time.Hour)
			if agent.observeLatencyUploadResponse(tc.status, http.Header{"Date": []string{tc.header}}, later, later) {
				t.Fatal("unusable response renewed calibration")
			}
			if _, calibrated := agent.clock.timestamp(base.Add(maxCalibrationAge + time.Second)); calibrated {
				t.Fatal("unusable response extended calibration lifetime")
			}
		})
	}
}

func TestLatencyUploadClockRecoversExpiredCalibrationAndCorrectsDrift(t *testing.T) {
	base := time.Now().Add(-25 * time.Hour).Truncate(time.Second)
	agent := Agent{}
	agent.clock.updateDate(base.UnixMilli(), 0, base)
	received := base.Add(25 * time.Hour)
	if _, calibrated := agent.clock.timestamp(received); calibrated {
		t.Fatal("expected the old calibration to have expired")
	}
	for _, correction := range []time.Duration{0, 30 * time.Second} {
		server := received.Add(correction)
		headers := http.Header{"Date": []string{server.UTC().Format(http.TimeFormat)}}
		if !agent.observeLatencyUploadResponse(http.StatusOK, headers, received.Add(-80*time.Millisecond), received) {
			t.Fatal("valid response did not renew calibration")
		}
		stamp, calibrated := agent.clock.timestamp(received)
		if want := server.UnixMilli() + 40; !calibrated || stamp != want {
			t.Fatalf("timestamp=(%d,%v), want (%d,true)", stamp, calibrated, want)
		}
	}
}

func TestLatencyLiveEchoesAcceptedSamplesOnly(t *testing.T) {
	var b latencyBuffer
	r := 1080
	k := "0123456789abcdef"
	if !b.add(latencySample{T: 60001000, P: 0, R: &r, K: k}) {
		t.Fatal("first sample rejected")
	}
	if b.add(latencySample{T: 60005000, P: 0, R: &r, K: k}) {
		t.Fatal("sample closer than 15s accepted")
	}
	b.add(latencySample{T: 60021000, P: 0, R: nil, K: k})
	b.add(latencySample{T: 60021000, P: 1, R: &r, K: k})
	live := b.liveSince(60010000)
	if len(live) != 2 || live[0].R != nil || *live[1].R != 1080 || live[1].P != 1 {
		t.Fatalf("live window wrong: %+v", live)
	}
	// Live samples are exactly the uploaded ones, so the dashboard can merge them by p:t:k.
	block := b.pending(60061000)[0]
	if len(block.Samples) != 3 || block.Samples[0] != b.liveSince(0)[0] {
		t.Fatal("live sample differs from minute block sample")
	}
	b.pending(60121000)
	if b.add(latencySample{T: 60030000, P: 2, K: k}) || len(b.liveSince(0)) != 3 {
		t.Fatal("sealed minute must not reach live echo")
	}
}

func TestLatencyLiveIsBounded(t *testing.T) {
	var b latencyBuffer
	for i := 0; i < 400; i++ {
		b.add(latencySample{T: int64(60000000 + i*1000), P: i % 8, K: "0123456789abcdef"})
	}
	if len(b.live) > latencyLiveMax {
		t.Fatalf("live buffer unbounded: %d", len(b.live))
	}
	for _, s := range b.live {
		if s.T < int64(60000000+399*1000)-latencyLiveKeep.Milliseconds() {
			t.Fatal("old live sample retained")
		}
	}
}

func TestReportBodyCarriesLatencyLiveWhenEnabled(t *testing.T) {
	now := time.Now().Truncate(time.Second)
	agent := Agent{}
	agent.clock.updateDate(now.UnixMilli(), 0, now)
	r := 42
	agent.latency.add(latencySample{T: now.UnixMilli() - 3000, P: 3, R: &r, K: "0123456789abcdef"})
	body, _, err := agent.buildReportBodyForConfig(Config{LatencyDetail: true}, Metrics{}, now)
	if err != nil || !bytes.Contains(body, []byte(`"latency_live":[{"t":`)) {
		t.Fatalf("latency_live missing: %s %v", body, err)
	}
	body, _, _ = agent.buildReportBodyForConfig(Config{}, Metrics{}, now)
	if bytes.Contains(body, []byte("latency_live")) {
		t.Fatal("latency_live sent while LATENCY_DETAIL is off")
	}
}

func TestLatencyUploadRunsJustAfterEachMinute(t *testing.T) {
	base := time.Date(2026, 10, 30, 23, 44, 0, 0, time.UTC)
	for _, c := range []struct{ at, want time.Duration }{
		{0, 3 * time.Second},
		{2 * time.Second, time.Second},
		{3 * time.Second, time.Minute},
		{10 * time.Second, 53 * time.Second},
		{59 * time.Second, 4 * time.Second},
	} {
		if got := nextLatencyUpload(base.Add(c.at)); got != c.want {
			t.Fatalf("at +%v: wait %v, want %v", c.at, got, c.want)
		}
	}
}

func TestLatencyLiveCoversUploadLag(t *testing.T) {
	if latencyLiveWindow < 2*time.Minute || latencyLiveKeep < latencyLiveWindow {
		t.Fatal("live echo must outlast the newest minute block's upload delay")
	}
	if int(latencyLiveWindow/(20*time.Second))*8 > latencyLiveMax+8 {
		t.Fatal("live buffer cannot hold 8 routes over the window")
	}
}
