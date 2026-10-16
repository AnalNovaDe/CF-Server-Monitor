import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse, compileScript } from '@vue/compiler-sfc';
import { createRenderer, h, nextTick } from 'vue';

test('mounted charts update automatically; 24H hides the slider and history review stays fixed', async () => {
  const filename = new URL('../src/frontend/components/LatencyDetailCharts.vue', import.meta.url);
  const { descriptor } = parse(await readFile(filename, 'utf8'), { filename: filename.pathname });
  const vueURL = import.meta.resolve('vue');
  let source = compileScript(descriptor, { id: 'latency-ui-test', inlineTemplate: true }).content;
  source = source.replaceAll("from 'vue'", `from '${vueURL}'`).replaceAll('from "vue"', `from '${vueURL}'`)
    .replace("import Chart from 'chart.js/auto'", 'const Chart=globalThis.__latencyTestChart')
    .replace("import { http } from '../utils/http'", 'const http=globalThis.__latencyTestHttp')
    .replace("import { currentLang } from '../utils/i18n'", "const currentLang=ref('zh')");
  for (const module of ['latencyDetail', 'latencyHistory']) {
    source = source.replace(`'../utils/${module}.js'`, `'${new URL(`../src/frontend/utils/${module}.js`, import.meta.url).href}'`);
  }
  const saved = Object.fromEntries(['document', 'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'setInterval', 'clearInterval'].map(key => [key, globalThis[key]]));
  const oldNow = Date.now;
  let clock = Math.floor(1800000000000 / 60000) * 60000, app, allFailed = false;
  const intervals = [], listeners = new Map(), charts = [], queries = [];
  class FakeChart {
    constructor(canvas, config) { this.canvas=canvas; this.data=config.data; this.options=config.options; charts.push(this); }
    update() {}
    destroy() { this.destroyed=true; }
  }
  globalThis.__latencyTestChart = FakeChart;
  globalThis.__latencyTestHttp = { async getByIndex(url) {
    const q = new URL(url, 'https://test').searchParams;
    queries.push(q);
    if (queries.length === 3) return {error:'timeout'};
    const asOf=Math.floor(clock/60000)*60000,earliest=asOf-86400000;
    const to=q.has('before')?(Number(q.get('before'))||asOf):Math.min(asOf,Number(q.get('after'))+10800000);
    const from=q.has('before')?Math.max(earliest,to-10800000):Math.max(earliest,Number(q.get('after')));
    const samples=q.has('after')
      ? Array.from({length:15},(_,i)=>({p:0,t:to-300000+i*20000,r:allFailed||i===14?null:45,k:'0123456789abcdef'}))
      : [{p:0,t:to-20000,r:45,k:'0123456789abcdef'}];
    return {data:{enabled:true,as_of:asOf,range_from:from,range_to:to,next_before:from,has_previous:from>earliest,next_after:to,has_more:to<asOf,samples}};
  } };
  globalThis.document = { hidden: false, body: { classList: { contains: () => true } }, addEventListener: (name,callback) => listeners.set(name,callback), removeEventListener: name => listeners.delete(name) };
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  globalThis.requestAnimationFrame = callback => setTimeout(callback, 0);
  globalThis.cancelAnimationFrame = clearTimeout;
  globalThis.setInterval = (callback, delay) => { const timer={callback,delay}; intervals.push(timer); return timer; };
  globalThis.clearInterval = timer => { timer.cleared=true; };
  Date.now = () => clock;
  const detach = child => { if (child.parent) { const children=child.parent.children; children.splice(children.indexOf(child),1); child.parent=null; } };
  const renderer=createRenderer({
    createElement: type => ({type,props:{},children:[]}), createText: text => ({type:'#text',text}), createComment: text => ({type:'#comment',text}),
    insert(child,parent,anchor) { detach(child); const index=anchor?parent.children.indexOf(anchor):-1; parent.children.splice(index<0?parent.children.length:index,0,child); child.parent=parent; },
    remove: detach, setText: (node,text) => {node.text=text;}, setElementText: (node,text) => {node.children=[];node.text=text;},
    patchProp: (node,key,previous,value) => {node.props[key]=value;}, parentNode: node => node.parent,
    nextSibling(node) { return node.parent?.children[node.parent.children.indexOf(node)+1]||null; }
  });
  const root={type:'root',children:[]};
  const all=()=>{const nodes=[];const visit=node=>{nodes.push(node);for(const child of node.children||[])visit(child);};visit(root);return nodes;};
  const text=node=>node.type==='#comment'?'':(node.text||'')+(node.children||[]).map(text).join('');
  const settle=async()=>{await nextTick();await new Promise(resolve=>setTimeout(resolve,5));await nextTick();};
  const button=label=>all().find(node=>node.type==='button'&&text(node)===label);
  try {
    const Component=(await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)).default;
    app=renderer.createApp({render:()=>h(Component,{serverId:'ui-node',labels:['测试线路'],selectedHours:24})});
    app.mount(root);
    for(let i=0;i<60&&!text(root).includes('历史尚未加载完整');i++)await settle();
    assert.match(text(root),/历史尚未加载完整/);
    assert.match(text(root),/阴影区域尚未读取/);
    assert.match(text(root),/不能据此判定测量中断/);
    assert.equal(charts.length,2);
    assert.equal(charts[1].data.datasets.length,1); // one loss line per route; no artificial 100% scatter series
    assert.ok(charts[1].data.datasets.every(dataset=>dataset.showLine!==false&&dataset.spanGaps===false));
    assert.equal(charts[1].options.scales.y.max,10); // zero loss does not force a 0..100% axis
    assert.doesNotMatch(text(root),/顶部圆点/);
    assert.equal(charts[0].data.datasets[0].data.filter(point=>point.y!==null).length,2);
    button('继续加载').props.onClick();
    for(let i=0;i<60&&!text(root).includes('最近 24h 历史已读取完整');i++)await settle();
    assert.match(text(root),/最近 24h 历史已读取完整/);
    assert.equal(queries.length,9);
    assert.equal(charts.length,2);
    assert.equal(all().filter(node=>node.type==='input'&&node.props.type==='range').length,0);
    assert.match(text(root),/每分钟自动刷新/);
    for(const [label,minutes] of [['10M',10],['30M',30],['1H',60],['6H',360],['12H',720]]) {
      button(label).props.onClick();await settle();
      assert.equal(charts[0].options.scales.x.max-charts[0].options.scales.x.min,minutes*60000);
      assert.equal(all().find(node=>node.type==='input'&&node.props.type==='range').props.max,1440-minutes);
    }
    button('10M').props.onClick();await settle();
    const slider=all().find(node=>node.type==='input'&&node.props.type==='range');
    assert.equal(slider.props.max,1430);
    slider.props.onInput({target:{value:'60'}});await settle();
    assert.match(text(root),/正在回看固定历史时段/);
    const reviewEnd=charts[0].options.scales.x.max;
    assert.equal(intervals[0].delay,60000);
    clock+=60000;
    await intervals[0].callback();await settle();
    assert.equal(queries.length,10);
    assert.equal(charts[0].options.scales.x.max,reviewEnd);
    assert.match(text(root),/历史刷新于/);
    button('回到最新').props.onClick();await settle();
    assert.equal(charts[0].options.scales.x.max,clock);
    assert.equal(charts[0].data.datasets[0].data.at(-1).x,clock-20000);
    const lossPoint=charts[1].data.datasets[0].data.at(-1);
    assert.equal(lossPoint.y,100/15);
    assert.equal(charts[1].options.scales.y.max,10);
    assert.match(charts[1].options.plugins.tooltip.callbacks.label({parsed:{y:lossPoint.y},raw:lossPoint,dataset:{label:'测试线路'}}),/15 次中失败 1 次/);
    assert.equal(queries.length,10); // range/slider operations are local
    button('24H').props.onClick();await settle();
    assert.equal(all().filter(node=>node.type==='input'&&node.props.type==='range').length,0);
    document.hidden=true;
    await intervals[0].callback();
    assert.equal(queries.length,10);
    document.hidden=false;clock+=6*60000;allFailed=true;listeners.get('visibilitychange')();
    for(let i=0;i<20&&queries.length<11;i++)await settle();
    assert.equal(queries.length,11);
    await settle();
    assert.equal(charts[0].options.scales.x.max,clock);
    assert.equal(charts[1].data.datasets[0].data.at(-1).y,100); // actual all-failed windows remain 100%
    assert.equal(charts[1].options.scales.y.max,100);
    app.unmount();app=null;
    assert.ok(charts.every(chart=>chart.destroyed));
    assert.ok(intervals[0].cleared);
    assert.equal(listeners.size,0);
  } finally {
    app?.unmount();Date.now=oldNow;
    for(const [key,value] of Object.entries(saved)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}
    delete globalThis.__latencyTestChart;delete globalThis.__latencyTestHttp;
  }
});
