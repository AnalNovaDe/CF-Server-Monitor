<template>
  <section v-if="enabled || error || history.enabled === null" class="chart-card full-width latency-detail" :aria-busy="history.busy">
    <div class="chart-card-header">
      <span class="chart-title">▸ {{ en ? 'Latency · raw samples' : '延迟 · 逐次测量' }}</span>
      <div class="range-buttons" role="group" :aria-label="en ? 'Latency time range' : '延迟时间范围'">
        <button v-for="option in timeOptions" :key="option.hours" class="btn" :class="{ active: hours === option.hours }" :aria-pressed="hours === option.hours" @click="setRange(option.hours)">{{ option.label }}</button>
      </div>
    </div>
    <div class="history-status detail-note" role="status" aria-live="polite">
      <span>{{ statusText }}</span>
      <progress v-if="enabled && !history.complete" :value="loadedMinutes" max="1440" :aria-label="en ? 'History loading progress' : '历史加载进度'"></progress>
    </div>
    <p v-if="error" class="detail-note" role="alert">{{ error }} <button class="btn" :disabled="history.busy" @click="load">{{ en ? 'Resume loading' : '继续加载' }}</button></p>
    <template v-if="enabled">
      <div class="route-buttons" role="group" :aria-label="en ? 'Latency route visibility' : '延迟线路显示'">
        <button v-for="i in available" :key="i" class="btn" :style="{ color: colors[i], opacity: pingHidden.includes(i) ? .4 : 1 }" :aria-pressed="!pingHidden.includes(i)" @click="toggleRoute(i)">{{ labels[i] || `Node ${i+1}` }}</button>
        <button class="btn axis-toggle" :class="{ active: fullAxis }" :aria-pressed="fullAxis" @click="fullAxis = !fullAxis">{{ fullAxis ? (en ? 'Full axis' : '完整纵轴') : (en ? 'Adaptive axis' : '自适应纵轴') }}</button>
      </div>
      <p v-if="pingCap" class="detail-note">{{ en ? `Axis capped at ${pingCap} ms; ▲ marks higher values (hover for the real value).` : `纵轴封顶 ${pingCap} ms，▲ 为超出值，悬停看实际值。` }}</p>
      <p v-if="!samples.length && history.complete" class="detail-note">{{ en ? 'No measurements in the loaded 24h. Check Agent uploads; earlier detailed samples cannot be reconstructed.' : '最近 24h 已读取完毕，未找到测量记录；请检查 Agent 上报。启用前的高精度历史无法补回。' }}</p>
      <div class="dense-chart"><canvas ref="pingCanvas" :aria-label="en ? 'Raw latency chart' : '逐次延迟图'" role="img"></canvas></div>
      <div v-if="hours < 24" class="time-slider">
        <label>{{ en ? 'History offset' : '向前回看' }} <input :aria-label="en ? 'Latency history offset in minutes' : '延迟回看偏移分钟'" type="range" min="0" :max="1440-hours*60" step="5" :value="offsetMinutes" @input="setOffset($event.target.value)" /></label>
        <template v-if="offsetMinutes > 0">
          <span class="follow-state">{{ en ? 'Reviewing a fixed history window' : '正在回看固定历史时段' }} · {{ en ? 'until' : '截至' }} {{ endLabel }}</span>
          <button class="btn" @click="setOffset(0)">{{ en ? 'Back to latest' : '回到最新' }}</button>
        </template>
      </div>
    </template>
  </section>
  <section v-if="enabled" class="chart-card full-width latency-detail">
    <div class="chart-card-header">
      <span class="chart-title">▸ {{ lossTitle }}</span>
      <div class="range-buttons" role="group" :aria-label="en ? 'Loss time range' : '丢包率时间范围'">
        <button v-for="option in timeOptions" :key="option.hours" class="btn" :class="{ active: lossHours === option.hours }" :aria-pressed="lossHours === option.hours" @click="setLossRange(option.hours)">{{ option.label }}</button>
      </div>
    </div>
    <p class="detail-note">{{ lossNote }}</p>
    <div class="route-buttons" role="group" :aria-label="en ? 'Loss route visibility' : '丢包率线路显示'">
      <button v-for="i in available" :key="i" class="btn" :style="{ color: colors[i], opacity: lossHidden.includes(i) ? .4 : 1 }" :aria-pressed="!lossHidden.includes(i)" @click="toggleRoute(i, true)">{{ labels[i] || `Node ${i+1}` }}</button>
    </div>
    <div class="dense-chart loss"><canvas ref="lossCanvas" :aria-label="lossTitle" role="img"></canvas></div>
    <div v-if="lossHours < 24" class="time-slider">
      <label>{{ en ? 'History offset' : '向前回看' }} <input :aria-label="en ? 'Loss history offset in minutes' : '丢包率回看偏移分钟'" type="range" min="0" :max="1440-lossHours*60" step="5" :value="lossOffsetMinutes" @input="setLossOffset($event.target.value)" /></label>
      <template v-if="lossOffsetMinutes > 0">
        <span class="follow-state">{{ en ? 'Reviewing a fixed history window' : '正在回看固定历史时段' }} · {{ en ? 'until' : '截至' }} {{ lossEndLabel }}</span>
        <button class="btn" @click="setLossOffset(0)">{{ en ? 'Back to latest' : '回到最新' }}</button>
      </template>
    </div>
  </section>
</template>

<script setup>
import { ref, shallowRef, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import Chart from 'chart.js/auto'
import { http } from '../utils/http'
import { currentLang } from '../utils/i18n'
import { latencyChartSeries, latencyAxisCap, RETRANSMIT_MS } from '../utils/latencyDetail.js'
import { createLatencyHistoryLoader } from '../utils/latencyHistory.js'
const props = defineProps({ serverId: String, apiIndex: { type: Number, default: 0 }, labels: { type: Array, default: () => [] }, selectedHours: { type: Number, default: 24 }, probeMode: { type: String, default: 'tcp' }, liveSamples: { type: Array, default: null } })
const emit = defineEmits(['active', 'update:selectedHours'])
const timeOptions = [
  { hours: 1/6, label: '10M' },
  { hours: 0.5, label: '30M' },
  { hours: 1, label: '1H' },
  { hours: 6, label: '6H' },
  { hours: 12, label: '12H' },
  { hours: 24, label: '24H' },
]
const en = computed(() => currentLang.value === 'en')
const protocol = computed(() => props.probeMode === 'icmp' ? 'ICMP' : 'TCP')
const lossTitle = computed(() => en.value ? `${protocol.value} probe loss rate` : `${protocol.value} 探测丢包率`)
const lossNote = computed(() => protocol.value === 'TCP'
  ? (en.value ? 'Share of probes in the last 5 minutes that hit packet loss (failed or SYN retransmit).' : '最近 5 分钟内遇到丢包（失败或 SYN 重传）的探测比例')
  : (en.value ? 'Share of probes in the last 5 minutes that failed.' : '最近 5 分钟内探测失败的比例'))
const pingHidden = ref([]), lossHidden = ref([])
const hours = ref(24), offsetMinutes = ref(0), historyAnchor = ref(null), clock = ref(Date.now()), pingCanvas = ref(null), lossCanvas = ref(null)
const lossHours = ref(24), lossOffsetMinutes = ref(0), lossHistoryAnchor = ref(null)
const lastRefresh = ref(null)
const fullAxis = ref(false), pingCap = ref(null)
const colors = ['#00a58b','#e49b40','#4da6ff','#b392f0','#ff7b72','#79c0ff','#60ba66','#fa8a44']
let ping, loss, timer, disposed = false, observer, drawFrame
const history = shallowRef({})
const loader = createLatencyHistoryLoader({
  request: query => http.getByIndex(`/api/history/latency?id=${encodeURIComponent(props.serverId)}&${new URLSearchParams(query)}`, props.apiIndex, { autoRedirect: false, timeoutMs: 15000 }),
  paused: () => document.hidden,
  onChange: state => { history.value = state },
  onPage: async () => {
    clock.value = Date.now()
    lastRefresh.value = clock.value
    await nextTick()
    if (disposed) return
    draw()
    await new Promise(resolve => requestAnimationFrame(resolve))
  }
})
history.value = loader.state
const enabled = computed(() => history.value.enabled === true)
const samples = computed(() => history.value.samples)
const error = computed(() => history.value.error ? (en.value ? 'History loading failed; this does not establish a measurement outage: ' : '历史加载失败，不能据此判定测量中断：') + history.value.error : '')
const available = computed(() => [...new Set(samples.value.map(s => s.p))].sort())
const liveActive = computed(() => !!history.value.liveAt && clock.value - history.value.liveAt < 90000)
const newestTime = computed(() => samples.value.length ? new Date(samples.value.at(-1).t).toLocaleTimeString() : '—')
const endLabel = computed(() => new Date(viewEnd.value).toLocaleString())
const viewEnd = computed(() => (historyAnchor.value ?? clock.value) - offsetMinutes.value * 60000)
const viewStart = computed(() => viewEnd.value - hours.value * 3600000)
const chartSeries = computed(() => latencyChartSeries(samples.value, viewStart.value, viewEnd.value))
const lossViewEnd = computed(() => (lossHistoryAnchor.value ?? clock.value) - lossOffsetMinutes.value * 60000)
const lossViewStart = computed(() => lossViewEnd.value - lossHours.value * 3600000)
const lossEndLabel = computed(() => new Date(lossViewEnd.value).toLocaleString())
const lossChartSeries = computed(() => lossViewStart.value === viewStart.value && lossViewEnd.value === viewEnd.value
  ? chartSeries.value
  : latencyChartSeries(samples.value, lossViewStart.value, lossViewEnd.value))
const loadedMinutes = computed(() => history.value.loadedFrom === null ? 0 : Math.min(1440, Math.round((history.value.asOf - history.value.loadedFrom) / 60000)))
const statusText = computed(() => {
  if (!history.value.asOf) {
    if (history.value.error) return en.value ? 'History has not loaded. Resume to try again.' : '尚未读到历史记录，请点击“继续加载”重试。'
    return en.value ? 'Loading recent measurements…' : '正在读取最近的测量记录…'
  }
  if (!history.value.complete) {
    const span = `${(loadedMinutes.value / 60).toFixed(1)} / 24h`
    return en.value
      ? `History ${history.value.error ? 'incomplete' : history.value.busy ? 'loading' : 'paused'} (${span}). Shaded areas have not loaded yet; loaded empty areas contain no records.`
      : `历史${history.value.error ? '尚未加载完整' : history.value.busy ? '加载中' : '加载已暂停'}（${span}）。阴影区域尚未读取；已读取区域的空白表示没有测量记录。`
  }
  return en.value
    ? `${liveActive.value ? 'Live' : 'Refreshes every minute'} · newest ${newestTime.value}`
    : `${liveActive.value ? '实时' : '每分钟刷新'} · 最新 ${newestTime.value}`
})
function toggleRoute(i, isLoss = false) {
  const hidden = isLoss ? lossHidden : pingHidden
  hidden.value = hidden.value.includes(i) ? hidden.value.filter(n=>n!==i) : [...hidden.value,i]
}
function setOffset(value) {
  const offset = Math.max(0, Math.min(1440 - hours.value * 60, Number(value) || 0))
  if (offset > 0 && historyAnchor.value === null) historyAnchor.value = clock.value
  if (offset === 0) historyAnchor.value = null
  offsetMinutes.value = offset
}
function setRange(n) { hours.value=n; setOffset(0); emit('update:selectedHours',n) }
function setLossOffset(value) {
  const offset = Math.max(0, Math.min(1440 - lossHours.value * 60, Number(value) || 0))
  if (offset > 0 && lossHistoryAnchor.value === null) lossHistoryAnchor.value = clock.value
  if (offset === 0) lossHistoryAnchor.value = null
  lossOffsetMinutes.value = offset
}
function setLossRange(n) { lossHours.value=n; setLossOffset(0) }
watch(() => props.selectedHours, value => {
  // The existing page uses 0.167 for its 10-minute realtime range.
  const option=timeOptions.find(option => Math.abs(option.hours-value)<0.001)
  if (option) { hours.value=option.hours; setOffset(0) }
}, { immediate:true })
function destroyCharts() { ping?.destroy(); loss?.destroy(); ping=undefined; loss=undefined }
// Mark unread history on the actual plot area, rather than displaying it as a measurement gap.
const pendingHistory = {
  id: 'pendingHistory',
  afterDraw(chart) {
    if (history.value.complete || history.value.loadedFrom === null) return
    const { ctx, chartArea: area, scales } = chart
    if (!area) return
    const until = history.value.loadedFrom + (chart.canvas === lossCanvas.value ? 300000 : 0)
    const right = Math.min(area.right, Math.max(area.left, scales.x.getPixelForValue(until)))
    if (right <= area.left) return
    ctx.save()
    ctx.beginPath(); ctx.rect(area.left, area.top, right-area.left, area.bottom-area.top); ctx.clip()
    ctx.fillStyle = document.body.classList.contains('light') ? '#87919b26' : '#87919b36'
    ctx.fillRect(area.left, area.top, right-area.left, area.bottom-area.top)
    ctx.strokeStyle = '#87919b45'; ctx.lineWidth = 1
    for (let x = area.left - area.height; x < right; x += 18) {
      ctx.beginPath(); ctx.moveTo(x, area.bottom); ctx.lineTo(x+area.height, area.top); ctx.stroke()
    }
    if (right - area.left > 120) {
      ctx.fillStyle = document.body.classList.contains('light') ? '#435063' : '#ced5df'
      ctx.font = '12px sans-serif'; ctx.textAlign = 'center'
      ctx.fillText(en.value ? 'History not loaded yet' : '此区域历史尚未加载', (area.left+right)/2, (area.top+area.bottom)/2)
    }
    ctx.restore()
  }
}
function draw() {
  if (!pingCanvas.value || !lossCanvas.value) return
  const dark = !document.body.classList.contains('light')
  const text = dark ? '#ced5df' : '#435063', grid = dark ? '#ffffff18' : '#00000015'
  const end = viewEnd.value, start = viewStart.value
  const lossEnd = lossViewEnd.value, lossStart = lossViewStart.value
  let maxLoss = 0
  const options = (isLoss) => ({ responsive:true, maintainAspectRatio:false, animation:false, parsing:false,
    interaction:{ mode:'nearest',intersect:false }, plugins:{ legend:{display:false}, tooltip:{ filter: item => !item.dataset.isMarker, callbacks:{ title: items=>items.length ? new Date(items[0].parsed.x).toLocaleString() : '', label:item=> {
      const value = item.raw.raw ?? item.parsed.y
      let label = `${item.dataset.label}: ${Number(value).toFixed(isLoss?1:0)}${isLoss?'%':' ms'}`
      if (!isLoss && protocol.value === 'TCP' && value >= RETRANSMIT_MS) label += en.value ? ' (likely SYN retransmit)' : '（疑似 SYN 重传）'
      if (isLoss && item.raw.attempts) {
        label += en.value ? ` (${item.raw.failed}/${item.raw.attempts} failed` : `（${item.raw.attempts} 次中失败 ${item.raw.failed} 次`
        if (protocol.value === 'TCP') label += en.value ? `, ${item.raw.retrans} retransmitted)` : `，重传 ${item.raw.retrans} 次）`
        else label += en.value ? ')' : '）'
      }
      return label
    } } } },
    scales:{ x:{ type:'linear',min:isLoss?lossStart:start,max:isLoss?lossEnd:end,grid:{color:grid},ticks:{color:text,maxTicksLimit:8,minRotation:0,maxRotation:0,callback:v=>new Date(v).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})} },y:{min:isLoss?0:undefined,max:isLoss?Math.min(100,Math.max(10,Math.ceil(maxLoss*1.1/5)*5)):(cap ?? undefined),grid:{color:grid},ticks:{color:text},title:{display:true,text:isLoss?'%':'ms',color:text}} }
  })
  const p=[],l=[],markers=[]
  // Adaptive axis from the visible routes in the visible range.
  const visibleValues = []
  for (const i of available.value) {
    if (pingHidden.value.includes(i)) continue
    for (const point of chartSeries.value.get(i)?.ping || []) if (point.x >= start && point.x <= end && point.y !== null) visibleValues.push(point.y)
  }
  const cap = fullAxis.value ? null : latencyAxisCap(visibleValues)
  pingCap.value = cap
  for (const i of available.value) {
    const rawPing=chartSeries.value.get(i)?.ping || []
    const pingPoints=cap === null ? rawPing : rawPing.map(point => point.y !== null && point.y > cap ? { x: point.x, y: cap, raw: point.y } : point)
    const rawLoss=lossChartSeries.value.get(i)?.loss || []
    // TCP: loss = failed + SYN retransmits (>=1s connects from pre-latency.4 agents).
    const lossPoints=protocol.value === 'TCP'
      ? rawLoss.map(point => point.attempts ? { ...point, y: 100 * (point.failed + point.retrans) / point.attempts } : point)
      : rawLoss
    const common={label:props.labels[i]||`Node ${i+1}`,borderColor:colors[i],backgroundColor:colors[i],borderWidth:1,pointRadius:0,tension:0,spanGaps:false}
    p.push({...common,data:pingPoints,hidden:pingHidden.value.includes(i)})
    if (cap !== null) {
      const over = pingPoints.filter(point => point.raw !== undefined)
      if (over.length) markers.push({...common,type:'scatter',isMarker:true,data:over,pointStyle:'triangle',pointRadius:3.5,pointHoverRadius:5,borderWidth:0,showLine:false,hidden:pingHidden.value.includes(i)})
    }
    l.push({...common,borderWidth:1.5,data:lossPoints,hidden:lossHidden.value.includes(i)})
    if (!lossHidden.value.includes(i)) {
      for (const point of lossPoints) {
        if (point.x >= lossStart && point.x <= lossEnd && Number.isFinite(point.y)) maxLoss = Math.max(maxLoss, point.y)
      }
    }
  }
  const pingSets=[...p,...markers]
  if (!ping) ping=new Chart(pingCanvas.value,{type:'line',data:{datasets:pingSets},options:options(false),plugins:[pendingHistory]})
  else {ping.data.datasets=pingSets;ping.options=options(false);ping.update('none')}
  if (!loss) loss=new Chart(lossCanvas.value,{type:'line',data:{datasets:l},options:options(true),plugins:[pendingHistory]})
  else {loss.data.datasets=l;loss.options=options(true);loss.update('none')}
}
function scheduleDraw() {
  if (drawFrame || disposed) return
  drawFrame = requestAnimationFrame(() => { drawFrame = undefined; if (!disposed) draw() })
}
const load = () => loader.load()
const onVisibility = () => {
  if (!document.hidden && (!history.value.complete || lastRefresh.value === null || Date.now() - lastRefresh.value >= 60000)) load()
}
watch(() => props.liveSamples, live => {
  if (!loader.addLive(live)) return
  const newest = Math.max(...live.map(s => s.t))
  // Advance the "following latest" window so new points are not clipped at the old edge.
  clock.value = Math.max(Date.now(), Number.isFinite(newest) ? newest : 0)
  scheduleDraw()
})
watch(enabled, active => { emit('active', active); if (!active) destroyCharts() })
watch([hours,offsetMinutes,historyAnchor,lossHours,lossOffsetMinutes,lossHistoryAnchor,pingHidden,lossHidden,fullAxis,()=>props.labels,protocol,currentLang], scheduleDraw, { flush:'post' })
onMounted(()=>{load();timer=setInterval(load,60000);document.addEventListener('visibilitychange',onVisibility);observer=new MutationObserver(scheduleDraw);observer.observe(document.body,{attributes:true,attributeFilter:['class']})})
onUnmounted(()=>{disposed=true;loader.dispose();clearInterval(timer);cancelAnimationFrame(drawFrame);document.removeEventListener('visibilitychange',onVisibility);observer?.disconnect();destroyCharts()})
</script>

<style scoped>
.latency-detail{grid-column:1 / -1;min-width:0}.dense-chart{position:relative;height:350px;padding:12px 18px}.dense-chart.loss{height:230px}.detail-note{font-size:12px;line-height:1.7;padding:4px 18px;opacity:.85;overflow-wrap:anywhere}.range-buttons,.route-buttons{display:flex;gap:8px;flex-wrap:wrap}.route-buttons{padding:0 18px}.btn.active{background:var(--accent-color,#158064);color:white}.axis-toggle{margin-left:auto}.time-slider{display:flex;gap:12px;align-items:center;flex-wrap:wrap;padding:12px 18px;font-size:12px}.time-slider label{display:flex;align-items:center;gap:12px;flex:1}.time-slider input{flex:1;min-width:80px}@media(max-width:600px){.dense-chart{height:280px;padding:8px}.chart-card-header{flex-wrap:wrap;gap:8px}.detail-note{padding:4px 12px}}
.history-status{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.history-status progress{width:140px;height:8px;accent-color:var(--accent-color,#158064)}
</style>
