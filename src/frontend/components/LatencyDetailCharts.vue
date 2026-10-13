<template>
  <section v-if="enabled || error" class="chart-card full-width latency-detail">
    <div class="chart-card-header">
      <span class="chart-title">▸ {{ en ? 'Latency · raw samples' : '延迟 · 逐次测量' }}</span>
      <div class="range-buttons">
        <button v-for="option in timeOptions" :key="option.hours" class="btn" :class="{ active: hours === option.hours }" :aria-pressed="hours === option.hours" @click="setRange(option.hours)">{{ option.label }}</button>
      </div>
    </div>
    <p v-if="error" class="detail-note" role="alert">{{ error }} <button class="btn" :disabled="busy" @click="load">{{ en ? 'Retry' : '重试' }}</button></p>
    <template v-if="enabled">
      <p class="detail-note">{{ en ? '20s target interval · minute uploads · last 24h retained. Click a route to hide it.' : '目标间隔 20 秒 · 按分钟上传 · 保留最近 24h；点击线路名称可隐藏。' }}
        {{ en ? 'Samples' : '有效记录（含失败）' }}: {{ samples.length }} · {{ en ? 'Newest' : '最新测量' }}: {{ newest }}</p>
      <div class="route-buttons">
        <button v-for="i in available" :key="i" class="btn" :style="{ color: colors[i], opacity: hidden.includes(i) ? .4 : 1 }" :aria-pressed="!hidden.includes(i)" @click="toggle(i)">{{ labels[i] }}</button>
      </div>
      <p v-if="!samples.length" class="detail-note">{{ en ? 'Waiting for the custom Agent. Earlier detailed samples cannot be reconstructed.' : '等待自定义 Agent 上报；高精度历史从启用后开始积累。' }}</p>
      <div class="dense-chart"><canvas ref="pingCanvas" :aria-label="en ? 'Raw latency chart' : '逐次延迟图'" role="img"></canvas></div>
      <div class="time-slider"><label>{{ en ? 'View ending' : '查看截至时间' }} <input aria-label="历史偏移分钟 / History offset in minutes" type="range" min="0" :max="1440-hours*60" step="5" v-model.number="offsetMinutes" /></label><span>{{ endLabel }}</span></div>
    </template>
  </section>
  <section v-if="enabled" class="chart-card full-width latency-detail">
    <div class="chart-card-header"><span class="chart-title">▸ {{ en ? 'Probe failure rate' : '探测失败率' }}</span></div>
    <p class="detail-note">{{ en ? 'Rolling 5-minute failure rate; dots at 100% mark individual failed attempts. Missing data is a gap, not 0%.' : '折线：最近 5 分钟已执行探测的失败比例；顶部圆点：单次失败。缺测留空，不按 0% 处理。TCP 失败率不等于 ICMP 丢包率。' }}</p>
    <div class="dense-chart loss"><canvas ref="lossCanvas" :aria-label="en ? 'Failure rate chart' : '探测失败率图'" role="img"></canvas></div>
  </section>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import Chart from 'chart.js/auto'
import { http } from '../utils/http'
import { currentLang } from '../utils/i18n'
import { mergeLatencySamples, latencySeries } from '../utils/latencyDetail.js'
const props = defineProps({ serverId: String, apiIndex: { type: Number, default: 0 }, labels: { type: Array, default: () => [] }, selectedHours: { type: Number, default: 24 } })
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
const enabled = ref(false), error = ref(''), busy = ref(false), samples = ref([]), hidden = ref([])
const hours = ref(24), offsetMinutes = ref(0), clock = ref(Date.now()), pingCanvas = ref(null), lossCanvas = ref(null)
const colors = ['#00a58b','#e49b40','#4da6ff','#b392f0','#ff7b72','#79c0ff','#60ba66','#fa8a44']
const available = computed(() => [...new Set(samples.value.map(s => s.p))].sort())
const newest = computed(() => samples.value.length ? new Date(samples.value.at(-1).t).toLocaleString() : '—')
const endLabel = computed(() => new Date(clock.value - offsetMinutes.value*60000).toLocaleString())
let ping, loss, timer, cursor = 0, disposed = false, observer
function toggle(i) { hidden.value = hidden.value.includes(i) ? hidden.value.filter(n=>n!==i) : [...hidden.value,i] }
function setRange(n) { hours.value=n; offsetMinutes.value=0; emit('update:selectedHours',n) }
watch(() => props.selectedHours, value => {
  // The existing page uses 0.167 for its 10-minute realtime range.
  const option=timeOptions.find(option => Math.abs(option.hours-value)<0.001)
  if (option) { hours.value=option.hours; offsetMinutes.value=0 }
}, { immediate:true })
function destroyCharts() { ping?.destroy(); loss?.destroy(); ping=undefined; loss=undefined }
function draw() {
  if (!pingCanvas.value || !lossCanvas.value) return
  const dark = !document.body.classList.contains('light')
  const text = dark ? '#ced5df' : '#435063', grid = dark ? '#ffffff18' : '#00000015'
  const end = clock.value-offsetMinutes.value*60000, start=end-hours.value*3600000
  const options = (isLoss) => ({ responsive:true, maintainAspectRatio:false, animation:false, parsing:false,
    interaction:{ mode:'nearest',intersect:false }, plugins:{ legend:{display:false}, tooltip:{ callbacks:{ title: items=>items.length ? new Date(items[0].parsed.x).toLocaleString() : '', label:item=> `${item.dataset.label}: ${Number(item.parsed.y).toFixed(isLoss?1:0)}${isLoss?'%':' ms'}${item.raw.attempts ? ` (${item.raw.attempts} attempts)` : ''}` } } },
    scales:{ x:{ type:'linear',min:start,max:end,grid:{color:grid},ticks:{color:text,maxTicksLimit:8,callback:v=>new Date(v).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})} },y:{min:isLoss?0:undefined,max:isLoss?100:undefined,grid:{color:grid},ticks:{color:text},title:{display:true,text:isLoss?'%':'ms',color:text}} }
  })
  const p=[],l=[]
  for (const i of available.value) {
    const series=latencySeries(samples.value,i)
    const common={label:props.labels[i]||`Node ${i+1}`,borderColor:colors[i],backgroundColor:colors[i],borderWidth:1,pointRadius:0,tension:0,spanGaps:false,hidden:hidden.value.includes(i)}
    p.push({...common,data:series.ping})
    l.push({...common,data:series.loss})
    l.push({...common,label:`${common.label} ${en.value?'failed':'单次失败'}`,data:series.failures,showLine:false,pointRadius:2,pointHoverRadius:4})
  }
  if (!ping) ping=new Chart(pingCanvas.value,{type:'line',data:{datasets:p},options:options(false)})
  else {ping.data.datasets=p;ping.options=options(false);ping.update('none')}
  if (!loss) loss=new Chart(lossCanvas.value,{type:'line',data:{datasets:l},options:options(true)})
  else {loss.data.datasets=l;loss.options=options(true);loss.update('none')}
}
async function load() {
  if (busy.value || disposed || document.hidden) return
  busy.value=true
  try {
    let after=enabled.value ? cursor : 0, result
    do {
      result=await http.getByIndex(`/api/history/latency?id=${encodeURIComponent(props.serverId)}&after=${after}`,props.apiIndex,{autoRedirect:false,timeoutMs:15000})
      if (disposed || document.hidden) return
      if (result.error) throw new Error(result.message || result.error)
      if (typeof result.data?.enabled !== 'boolean') throw new Error(en.value ? 'Invalid history response' : '历史响应格式异常')
      enabled.value=result.data?.enabled===true
      emit('active',enabled.value)
      if (!enabled.value) { samples.value=[]; cursor=0; destroyCharts(); break }
      clock.value=Date.now()
      samples.value=mergeLatencySamples(samples.value,result.data?.samples||[],clock.value)
      after=result.data?.next_after||after
    } while(result.data?.has_more)
    // Re-read 31 minutes to include late retry blocks; bounded by Agent's 30min queue.
    if (enabled.value) cursor=Math.max(0,(result.data?.as_of||Date.now())-31*60000)
    error.value=''
    await nextTick();draw()
  } catch(e) { if (!disposed) error.value=(en.value?'Detailed latency unavailable: ':'高精度延迟暂不可用：')+e.message }
  finally {busy.value=false}
}
watch([hours,offsetMinutes,hidden,()=>props.labels,currentLang],draw)
onMounted(()=>{load();timer=setInterval(load,60000);observer=new MutationObserver(draw);observer.observe(document.body,{attributes:true,attributeFilter:['class']})})
onUnmounted(()=>{disposed=true;clearInterval(timer);observer?.disconnect();destroyCharts()})
</script>

<style scoped>
.latency-detail{grid-column:1 / -1;min-width:0}.dense-chart{position:relative;height:350px;padding:12px 18px}.dense-chart.loss{height:230px}.detail-note{font-size:12px;line-height:1.7;padding:4px 18px;opacity:.85;overflow-wrap:anywhere}.range-buttons,.route-buttons{display:flex;gap:8px;flex-wrap:wrap}.route-buttons{padding:0 18px}.btn.active{background:var(--accent-color,#158064);color:white}.time-slider{display:flex;gap:12px;align-items:center;flex-wrap:wrap;padding:12px 18px;font-size:12px}.time-slider label{display:flex;align-items:center;gap:12px;flex:1}.time-slider input{flex:1;min-width:80px}@media(max-width:600px){.dense-chart{height:280px;padding:8px}.chart-card-header{flex-wrap:wrap;gap:8px}.detail-note{padding:4px 12px}}
</style>
