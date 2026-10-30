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
