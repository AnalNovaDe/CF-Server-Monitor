const DAY = 86400000;
// Agent timestamps follow the Worker clock; tolerate a browser clock that runs slightly behind.
const FUTURE_TOLERANCE = 120000;
// A TCP connect that takes >= 1s almost always means the first SYN was lost and retransmitted
// after Linux's 1s initial RTO: it is packet loss that the probe recovered from.
export const RETRANSMIT_MS = 1000;
export const sampleKey = s => `${s.p}:${s.t}:${s.k}`;
export function mergeLatencySamples(previous, incoming, now = Date.now()) {
  const map = new Map();
  for (const s of [...previous, ...incoming]) {
    if (s.t >= now - DAY && s.t <= now + FUTURE_TOLERANCE) map.set(sampleKey(s), s);
  }
  return [...map.values()].sort((a, b) => a.t - b.t || a.p - b.p);
}

// Five-minute *attempt* failure rate, never count missing measurements as losses.
export function latencySeries(samples, index) {
  return seriesForRows(samples.filter(s => s.p === index));
}

const isRetransmit = s => s.r !== null && s.r >= RETRANSMIT_MS;

function seriesForRows(rows) {
  const ping = [], loss = [];
  let start = 0, lost = 0, slow = 0, previous;
  for (let i = 0; i < rows.length; i++) {
    const s = rows[i];
    if (previous && (previous.k !== s.k || s.t - previous.t > 45000)) {
      ping.push({ x: previous.t + 1, y: null });
      loss.push({ x: previous.t + 1, y: null });
      start = i; lost = 0; slow = 0;
    }
    if (s.r === null) lost++;
    if (isRetransmit(s)) slow++;
    while (start < i && rows[start].t < s.t - 300000) {
      if (rows[start].r === null) lost--;
      if (isRetransmit(rows[start])) slow--;
      start++;
    }
    const attempts = i - start + 1;
    ping.push({ x: s.t, y: s.r });
    loss.push({ x: s.t, y: 100 * lost / attempts, attempts, failed: lost, retrans: slow });
    previous = s;
  }
  return { ping, loss };
}

// Keep the 5-minute failure-rate context, but only give the chart the selected range.
// Group once, rather than filtering all 24h eight times on every interaction.
export function latencyChartSeries(samples, start, end) {
  const routes = new Map();
  for (const sample of samples) {
    if (sample.t < start - 300000 || sample.t > end) continue;
    if (!routes.has(sample.p)) routes.set(sample.p, []);
    routes.get(sample.p).push(sample);
  }
  return new Map([...routes].map(([index, rows]) => {
    const series = seriesForRows(rows);
    const clip = points => {
      const first = points.findIndex(point => point.x >= start);
      if (first < 0) return [];
      // Retain one preceding point so clipping does not change a boundary segment.
      return points.slice(Math.max(0, first - 1));
    };
    return [index, { ping: clip(series.ping), loss: clip(series.loss) }];
  }));
}

// Adaptive latency axis: scale to the normal baseline so it stays readable; values above the
// cap are drawn as markers at the top edge, never discarded. The baseline excludes >=1s
// samples (retransmits), which can be several percent of all samples at peak hours.
export function latencyAxisCap(values) {
  const finite = values.filter(Number.isFinite);
  const base = finite.filter(v => v < RETRANSMIT_MS);
  const source = Float64Array.from(base.length >= 20 ? base : finite).sort();
  if (source.length < 20) return null;
  const p95 = source[Math.floor((source.length - 1) * 0.95)];
  const cap = Math.max(100, Math.ceil(p95 * 1.5 / 50) * 50);
  return Math.max(...finite) > cap ? cap : null;
}
