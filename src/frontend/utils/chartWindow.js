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

// Merge cached high-resolution points into a dataset: inside the span the cache covers,
// the cache wins; outside it the current (history/live) points stay.
export function mergeCachedPoints(current, cached) {
  if (!Array.isArray(cached) || cached.length === 0) return Array.isArray(current) ? current : []
  const from = ts(cached[0])
  const to = ts(cached[cached.length - 1])
  const outside = (current || []).filter(point => {
    const t = ts(point)
    return t < from || t > to
  })
  return [...outside, ...cached].sort((a, b) => ts(a) - ts(b))
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
