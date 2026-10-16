const DAY = 86400000;
export function mergeLatencySamples(previous, incoming, now = Date.now()) {
  const map = new Map();
  for (const s of [...previous, ...incoming]) {
    if (s.t >= now - DAY && s.t <= now) map.set(`${s.p}:${s.t}:${s.k}`, s);
  }
  return [...map.values()].sort((a, b) => a.t - b.t || a.p - b.p);
}

// Five-minute *attempt* failure rate, never count missing measurements as losses.
export function latencySeries(samples, index) {
  return seriesForRows(samples.filter(s => s.p === index));
}

function seriesForRows(rows) {
  const ping = [], loss = [], failures = [];
  let start = 0, lost = 0, previous;
  for (let i = 0; i < rows.length; i++) {
    const s = rows[i];
    if (previous && (previous.k !== s.k || s.t - previous.t > 45000)) {
      ping.push({ x: previous.t + 1, y: null });
      loss.push({ x: previous.t + 1, y: null });
      start = i; lost = 0;
    }
    if (s.r === null) { lost++; failures.push({ x: s.t, y: 100 }); }
    while (start < i && rows[start].t < s.t - 300000) { if (rows[start].r === null) lost--; start++; }
    ping.push({ x: s.t, y: s.r });
    loss.push({ x: s.t, y: 100 * lost / (i - start + 1), attempts: i - start + 1 });
    previous = s;
  }
  return { ping, loss, failures };
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
    return [index, { ping: clip(series.ping), loss: clip(series.loss), failures: series.failures.filter(point => point.x >= start) }];
  }));
}
