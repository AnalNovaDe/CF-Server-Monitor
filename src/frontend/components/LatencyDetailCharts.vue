<template>
  <section v-if="enabled || error || history.enabled === null" class="chart-card full-width latency-detail" :aria-busy="history.busy">
    <div class="chart-card-header">
      <span class="chart-title">▸ {{ en ? 'Latency · raw samples' : '延迟 · 逐次测量' }}</span>
      <div class="range-buttons">
        <button v-for="option in timeOptions" :key="option.hours" class="btn" :class="{ active: hours === option.hours }" :aria-pressed="hours === option.hours" @click="setRange(option.hours)">{{ option.label }}</button>
      </div>
    </div>
    <div class="history-status detail-note" role="status" aria-live="polite">
      <span>{{ statusText }}</span>
      <progress v-if="enabled && !history.complete" :value="loadedMinutes" max="1440" :aria-label="en ? 'History loading progress' : '历史加载进度'"></progress>
    </div>
    <p v-if="error" class="detail-note" role="alert">{{ error }} <button class="btn" :disabled="history.busy" @click="load">{{ en ? 'Resume loading' : '继续加载' }}</button></p>
    <template v-if="enabled">
      <p class="detail-note">{{ en ? '20s target interval · minute uploads · last 24h retained. Click a route to hide it.' : '目标间隔 20 秒 · 按分钟上传 · 保留最近 24h；点击线路名称可隐藏。' }}
        {{ en ? 'Loaded samples' : '已加载记录（含失败）' }}: {{ samples.length }} · {{ en ? 'Newest' : '最新测量' }}: {{ newest }} · {{ en ? 'History refreshed' : '历史刷新于' }}: {{ refreshedAt }}</p>
      <div class="route-buttons">
        <button v-for="i in available" :key="i" class="btn" :style="{ color: colors[i], opacity: hidden.includes(i) ? .4 : 1 }" :aria-pressed="!hidden.includes(i)" @click="toggle(i)">{{ labels[i] }}</button>
      </div>
      <p v-if="!samples.length && history.complete" class="detail-note">{{ en ? 'No measurements in the loaded 24h. Check Agent uploads; earlier detailed samples cannot be reconstructed.' : '最近 24h 已读取完毕，未找到测量记录；请检查 Agent 上报。启用前的高精度历史无法补回。' }}</p>
      <div class="dense-chart"><canvas ref="pingCanvas" :aria-label="en ? 'Raw latency chart' : '逐次延迟图'" role="img"></canvas></div>
      <div class="time-slider">
        <span class="follow-state">{{ offsetMinutes === 0 ? (en ? 'Following latest · refreshes every minute' : '跟随最新 · 每分钟自动刷新') : (en ? 'Reviewing a fixed history window' : '正在回看固定历史时段') }}</span>
        <template v-if="hours < 24">
          <label>{{ en ? 'History offset' : '向前回看' }} <input aria-label="历史偏移分钟 / History offset in minutes" type="range" min="0" :max="1440-hours*60" step="5" :value="offsetMinutes" @input="setOffset($event.target.value)" /></label>
          <button v-if="offsetMinutes > 0" class="btn" @click="setOffset(0)">{{ en ? 'Back to latest' : '回到最新' }}</button>
        </template>
        <span v-else>{{ en ? 'Full 24h shown. Select a shorter range to scroll through history.' : '已显示全部 24h；选择较短范围后可拖动回看。' }}</span>
        <span>{{ en ? 'View ending' : '截至' }} {{ endLabel }}</span>
      </div>
    </template>
  </section>
  <section v-if="enabled" class="chart-card full-width latency-detail">
    <div class="chart-card-header"><span class="chart-title">▸ {{ lossTitle }}</span></div>
    <p class="detail-note">{{ lossNote }}</p>
    <div class="dense-chart loss"><canvas ref="lossCanvas" :aria-label="lossTitle" role="img"></canvas></div>
  </section>
</template>

<script setup>
import { ref, shallowRef, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import Chart from 'chart.js/auto'
import { http } from '../utils/http'
import { currentLang } from '../utils/i18n'
import { latencyChartSeries } from '../utils/latencyDetail.js'
import { createLatencyHistoryLoader } from '../utils/latencyHistory.js'
const props = defineProps({ serverId: String, apiIndex: { type: Number, default: 0 }, labels: { type: Array, default: () => [] }, selectedHours: { type: Number, default: 24 }, probeMode: { type: String, default: 'tcp' } })
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
const lossNote = computed(() => {
  const basis = protocol.value === 'TCP'
    ? (en.value ? 'Fraction of failed TCP connection attempts in the last 5 minutes; this is not a TCP packet retransmission rate.' : '折线：最近 5 分钟已执行 TCP 连接探测的失败比例，并非 TCP 数据包重传率。')
    : (en.value ? 'Fraction of failed ICMP probe attempts in the last 5 minutes, including probe errors.' : '折线：最近 5 分钟已执行 ICMP 探测的失败比例，包含探测错误。')
  return basis + (en.value ? ' Dots at 100% mark individual failed attempts. Missing measurements remain gaps.' : '顶部圆点：单次探测失败。缺测留空，不按 0% 处理。')
})
const hidden = ref([])
const hours = ref(24), offsetMinutes = ref(0), historyAnchor = ref(null), clock = ref(Date.now()), pingCanvas = ref(null), lossCanvas = ref(null)
const lastRefresh = ref(null)
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
const newest = computed(() => samples.value.length ? new Date(samples.value.at(-1).t).toLocaleString() : '—')
const refreshedAt = computed(() => lastRefresh.value ? new Date(lastRefresh.value).toLocaleTimeString() : '—')
const endLabel = computed(() => new Date(viewEnd.value).toLocaleString())
const viewEnd = computed(() => (historyAnchor.value ?? clock.value) - offsetMinutes.value * 60000)
const viewStart = computed(() => viewEnd.value - hours.value * 3600000)
const chartSeries = computed(() => latencyChartSeries(samples.value, viewStart.value, viewEnd.value))
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
    ? `24h history loaded${history.value.busy ? ' · refreshing recent measurements…' : ''}. Empty areas contain no records; the latest minute appears after upload.`
    : `最近 24h 历史已读取完整${history.value.busy ? '，正在刷新近期记录…' : '。'}空白处表示没有测量记录；最新一分钟需等待上传。`
})
function toggle(i) { hidden.value = hidden.value.includes(i) ? hidden.value.filter(n=>n!==i) : [...hidden.value,i] }
function setOffset(value) {
  const offset = Math.max(0, Math.min(1440 - hours.value * 60, Number(value) || 0))
  if (offset > 0 && historyAnchor.value === null) historyAnchor.value = clock.value
  if (offset === 0) historyAnchor.value = null
  offsetMinutes.value = offset
}
function setRange(n) { hours.value=n; setOffset(0); emit('update:selectedHours',n) }
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
  const options = (isLoss) => ({ responsive:true, maintainAspectRatio:false, animation:false, parsing:false,
    interaction:{ mode:'nearest',intersect:false }, plugins:{ legend:{display:false}, tooltip:{ callbacks:{ title: items=>items.length ? new Date(items[0].parsed.x).toLocaleString() : '', label:item=> `${item.dataset.label}: ${Number(item.parsed.y).toFixed(isLoss?1:0)}${isLoss?'%':' ms'}${item.raw.attempts ? ` (${item.raw.attempts} attempts)` : ''}` } } },
    scales:{ x:{ type:'linear',min:start,max:end,grid:{color:grid},ticks:{color:text,maxTicksLimit:8,minRotation:0,maxRotation:0,callback:v=>new Date(v).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})} },y:{min:isLoss?0:undefined,max:isLoss?100:undefined,grid:{color:grid},ticks:{color:text},title:{display:true,text:isLoss?'%':'ms',color:text}} }
  })
  const p=[],l=[]
  for (const i of available.value) {
    const series=chartSeries.value.get(i) || {ping:[],loss:[],failures:[]}
    const common={label:props.labels[i]||`Node ${i+1}`,borderColor:colors[i],backgroundColor:colors[i],borderWidth:1,pointRadius:0,tension:0,spanGaps:false,hidden:hidden.value.includes(i)}
    p.push({...common,data:series.ping})
    l.push({...common,data:series.loss})
    l.push({...common,label:`${common.label} ${en.value?'failed':'单次失败'}`,data:series.failures,showLine:false,pointRadius:2,pointHoverRadius:4})
  }
  if (!ping) ping=new Chart(pingCanvas.value,{type:'line',data:{datasets:p},options:options(false),plugins:[pendingHistory]})
  else {ping.data.datasets=p;ping.options=options(false);ping.update('none')}
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
watch(enabled, active => { emit('active', active); if (!active) destroyCharts() })
watch([hours,offsetMinutes,historyAnchor,hidden,()=>props.labels,protocol,currentLang], scheduleDraw, { flush:'post' })
onMounted(()=>{load();timer=setInterval(load,60000);document.addEventListener('visibilitychange',onVisibility);observer=new MutationObserver(scheduleDraw);observer.observe(document.body,{attributes:true,attributeFilter:['class']})})
onUnmounted(()=>{disposed=true;loader.dispose();clearInterval(timer);cancelAnimationFrame(drawFrame);document.removeEventListener('visibilitychange',onVisibility);observer?.disconnect();destroyCharts()})
</script>

<style scoped>
.latency-detail{grid-column:1 / -1;min-width:0}.dense-chart{position:relative;height:350px;padding:12px 18px}.dense-chart.loss{height:230px}.detail-note{font-size:12px;line-height:1.7;padding:4px 18px;opacity:.85;overflow-wrap:anywhere}.range-buttons,.route-buttons{display:flex;gap:8px;flex-wrap:wrap}.route-buttons{padding:0 18px}.btn.active{background:var(--accent-color,#158064);color:white}.time-slider{display:flex;gap:12px;align-items:center;flex-wrap:wrap;padding:12px 18px;font-size:12px}.time-slider label{display:flex;align-items:center;gap:12px;flex:1}.time-slider input{flex:1;min-width:80px}@media(max-width:600px){.dense-chart{height:280px;padding:8px}.chart-card-header{flex-wrap:wrap;gap:8px}.detail-note{padding:4px 12px}}
.history-status{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.history-status progress{width:140px;height:8px;accent-color:var(--accent-color,#158064)}
</style>
