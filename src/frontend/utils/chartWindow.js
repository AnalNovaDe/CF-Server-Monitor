// Custom: helpers for the detail page's fixed-width realtime charts.
const ts = point => {
  const value = Number(point?.x ?? point)
  return Number.isFinite(value) ? value : 0
}

// Keep points inside the window plus the last one before it, so a line enters the
// plot from the left edge instead of starting a gap's width inside it.
export function trimToWindow(data, startTime) {
  if (!Array.isArray(data)) return []
  const first = data.findIndex(point => ts(point) >= startTime)
  return data.slice(Math.max(0, (first < 0 ? data.length : first) - 1))
}

// Tick spacing that lands on whole minutes/hours: the smallest step from the ladder that
// keeps the tick count within `maxTicks` (otherwise Chart.js picks e.g. 100 s itself).
// Whole-hour time zones such as UTC+8 see local whole hours.
const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440].map(m => m * 60000)
export function timeTickStep(hours, maxTicks = 6) {
  const range = hours * 3600000
  return STEPS.find(step => range / step <= Math.max(2, maxTicks - 1)) || STEPS[STEPS.length - 1]
}

// Tick positions at whole multiples of `step` inside [min, max]. Chart.js starts ticks at the
// axis minimum when min, max and stepSize are all set, so the positions are built here and
// assigned in an afterBuildTicks hook.
export function alignedTicks(min, max, step) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || !(step > 0) || max <= min) return []
  const ticks = []
  for (let value = Math.ceil(min / step) * step; value <= max; value += step) ticks.push({ value })
  return ticks
}

// The in-progress minute of the realtime resource charts, aggregated exactly as the Worker
// aggregates samples into each stored history row (HISTORY_METRIC_AGGREGATION_POLICY):
// averages for CPU/memory/probes, maxima for rates, counts and disk IO; anything else is
// the latest value. Once the row is stored, the next history fetch replaces this point.
const AVG_FIELDS = ['cpu', 'ram_used', 'swap_used', 'ping_ct', 'ping_cu', 'ping_cm', 'ping_bd', 'loss_ct', 'loss_cu', 'loss_cm', 'loss_bd']
const MAX_FIELDS = ['net_in_speed', 'net_out_speed', 'processes', 'tcp_conn', 'udp_conn']
const MAX_DISK_FIELDS = ['read_bps', 'write_bps', 'read_iops', 'write_iops', 'await_ms', 'util']
const finite = value => {
  if (value === null || value === undefined || value === '' || value === false) return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export function aggregateLiveRow(samples) {
  if (!Array.isArray(samples) || samples.length === 0) return null
  const ordered = [...samples].sort((a, b) => a.ts - b.ts)
  const row = Object.assign({}, ...ordered.map(sample => sample.data))
  const pick = (get, reduce) => {
    const values = ordered.map(sample => finite(get(sample.data))).filter(value => value !== null)
    return values.length ? reduce(values) : undefined
  }
  for (const field of AVG_FIELDS) {
    const value = pick(data => data?.[field], values => values.reduce((sum, v) => sum + v, 0) / values.length)
    if (value !== undefined) row[field] = value
  }
  for (const field of MAX_FIELDS) {
    const value = pick(data => data?.[field], values => Math.max(...values))
    if (value !== undefined) row[field] = value
  }
  const disk = {}
  for (const field of MAX_DISK_FIELDS) {
    const value = pick(data => data?.disk && typeof data.disk === 'object' ? data.disk[field] : null, values => Math.max(...values))
    if (value !== undefined) disk[field] = value
  }
  if (Object.keys(disk).length) row.disk = { ...(row.disk && typeof row.disk === 'object' ? row.disk : {}), ...disk }
  row.timestamp = ordered[ordered.length - 1].ts
  return row
}
