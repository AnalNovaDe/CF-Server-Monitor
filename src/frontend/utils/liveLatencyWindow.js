// Custom: keep the dashboard card's latency buckets moving with live WebSocket samples.
// The server sends a fixed-width bucket window once at page load; without this the bars
// only change after a reload. The newest bucket follows the latest live value, and the
// window shifts left by one bucket each time a live sample crosses the bucket boundary.
const KEYS = ['ct', 'cu', 'cm', 'bd', 'node_1', 'node_2', 'node_3', 'node_4']

export function applyLiveLatencySample(series, data, ts, metric) {
  if (!Array.isArray(series) || series.length < 2 || !data || !Number.isFinite(ts)) return series
  const last = series[series.length - 1]
  const width = last.ts - series[series.length - 2].ts
  if (!(width > 0) || ts < last.ts) return series

  const values = {}
  let found = false
  for (const key of KEYS) {
    const field = `${metric}_${key}`
    if (Object.prototype.hasOwnProperty.call(data, field)) {
      values[key] = data[field]
      found = true
    }
  }
  if (!found) return series

  if (ts < last.ts + width) {
    return [...series.slice(0, -1), { ...last, ...values }]
  }

  // Buckets skipped without any live sample stay empty (shown as missing, never interpolated).
  const steps = Math.floor((ts - last.ts) / width)
  const newestTs = last.ts + steps * width
  const kept = series.slice(Math.min(series.length, steps))
  const empty = []
  for (let bucketTs = newestTs - (series.length - kept.length - 1) * width; bucketTs < newestTs; bucketTs += width) {
    empty.push({ ts: bucketTs })
  }
  return [...kept, ...empty, { ts: newestTs, ...values }].slice(-series.length)
}
