import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse, compileScript } from '@vue/compiler-sfc';
import { createRenderer, h, nextTick, ref } from 'vue';

test('mounted charts have independent routes, ranges and history controls while sharing automatic updates', async () => {
  const filename = new URL('../src/frontend/components/LatencyDetailCharts.vue', import.meta.url);
  const { descriptor } = parse(await readFile(filename, 'utf8'), { filename: filename.pathname });
  const vueURL = import.meta.resolve('vue');
  let source = compileScript(descriptor, { id: 'latency-ui-test', inlineTemplate: true }).content;
  source = source.replaceAll("from 'vue'", `from '${vueURL}'`).replaceAll('from "vue"', `from '${vueURL}'`)
    .replace("import Chart from 'chart.js/auto'", 'const Chart=globalThis.__latencyTestChart')
    .replace("import { http } from '../utils/http'", 'const http=globalThis.__latencyTestHttp')
    .replace("import { currentLang } from '../utils/i18n'", "const currentLang=ref('zh')");
  for (const module of ['latencyDetail', 'latencyHistory', 'chartWindow']) {
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
    const routeSamples=q.has('after')
      ? Array.from({length:15},(_,i)=>({p:0,t:to-300000+i*20000,r:allFailed||i===14?null:45,k:'0123456789abcdef'}))
      : [{p:0,t:to-20000,r:45,k:'0123456789abcdef'}];
    const samples=routeSamples.flatMap(sample=>[sample,{...sample,p:1,r:50,k:'fedcba9876543210'}]);
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
  const nodesIn=rootNode=>{const nodes=[];const visit=node=>{nodes.push(node);for(const child of node.children||[])visit(child);};visit(rootNode);return nodes;};
  const all=()=>nodesIn(root);
  const sectionNodes=index=>nodesIn(all().filter(node=>node.type==='section')[index]);
  const text=node=>node.type==='#comment'?'':(node.text||'')+(node.children||[]).map(text).join('');
  const settle=async()=>{await nextTick();await new Promise(resolve=>setTimeout(resolve,5));await nextTick();};
  const button=(label,section)=> (section===undefined?all():sectionNodes(section)).find(node=>node.type==='button'&&text(node)===label);
  const slider=section=>sectionNodes(section).find(node=>node.type==='input'&&node.props.type==='range');
  const bounds=index=>({...charts[index].options.scales.x});
  const rangeHours=ref(24);
  try {
    const Component=(await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)).default;
    app=renderer.createApp({render:()=>h(Component,{serverId:'ui-node',labels:['测试线路','备用线路'],rangeHours:rangeHours.value})});
    app.mount(root);
    for(let i=0;i<60&&!text(root).includes('历史尚未加载完整');i++)await settle();
    assert.match(text(root),/历史尚未加载完整/);
    assert.match(text(root),/阴影区域尚未读取/);
    assert.match(text(root),/不能据此判定测量中断/);
    assert.equal(charts.length,2);
    assert.equal(charts[1].data.datasets.length,2); // one loss line per route; no artificial 100% scatter series
    assert.ok(charts[1].data.datasets.every(dataset=>dataset.showLine!==false&&dataset.spanGaps===false));
    assert.equal(charts[1].options.scales.y.max,10); // zero loss does not force a 0..100% axis
    assert.doesNotMatch(text(root),/顶部圆点/);
    assert.equal(charts[0].data.datasets[0].data.filter(point=>point.y!==null).length,2);
    button('继续加载').props.onClick();
    for(let i=0;i<60&&!text(root).includes('每分钟刷新 · 最新');i++)await settle();
    assert.match(text(root),/每分钟刷新 · 最新/);
    assert.equal(queries.length,9);
    assert.equal(charts.length,2);
    assert.equal(all().filter(node=>node.type==='input'&&node.props.type==='range').length,0);
    assert.match(text(root),/每分钟刷新/);
    const visibility=()=>charts.map(chart=>chart.data.datasets.map(dataset=>!dataset.hidden));
    assert.deepEqual(visibility(),[[true,true],[true,true]]);
    button('测试线路',0).props.onClick();await settle();
    assert.deepEqual(visibility(),[[false,true],[true,true]]);
    assert.equal(button('测试线路',0).props['aria-pressed'],false);
    assert.equal(button('测试线路',1).props['aria-pressed'],true);
    button('备用线路',1).props.onClick();await settle();
    assert.deepEqual(visibility(),[[false,true],[true,false]]);
    assert.equal(button('备用线路',1).props.style.opacity,.4);
    assert.equal(button('备用线路',0).props.style.opacity,1);
    assert.equal(queries.length,9); // chart visibility is local and never re-fetches history
    // Both dense charts follow the page's single range selector; they have no range buttons of their own.
    assert.equal(all().filter(node=>node.type==='button'&&/^(10M|30M|1H|6H|12H|24H)$/.test(text(node))).length,0);
    for(const [hours,minutes] of [[0.167,10],[0.5,30],[1,60],[6,360],[12,720],[24,1440]]) {
      rangeHours.value=hours;await settle();
      for(const index of [0,1]) assert.equal(charts[index].options.scales.x.max-charts[index].options.scales.x.min,minutes*60000);
      if(minutes<1440){assert.equal(slider(0).props.max,1440-minutes);assert.equal(slider(1).props.max,1440-minutes);}
      else{assert.equal(slider(0),undefined);assert.equal(slider(1),undefined);}
    }
    rangeHours.value=0.5;await settle();
    assert.equal(slider(0).props.max,1410);
    // History sliders stay independent per chart.
    slider(0).props.onInput({target:{value:'60'}});await settle();
    assert.match(text(root),/正在回看固定历史时段/);
    const reviewEnd=charts[0].options.scales.x.max;
    assert.equal(intervals[0].delay,60000);
    clock+=60000;
    await intervals[0].callback();await settle();
    assert.equal(queries.length,10);
    assert.deepEqual(visibility(),[[false,true],[true,false]]); // sliders, visibility and automatic refresh retain each chart's choices
    assert.equal(charts[0].options.scales.x.max,reviewEnd);
    assert.equal(charts[1].options.scales.x.max,clock); // loss follows while latency reviews history
    button('回到最新').props.onClick();await settle();
    assert.equal(charts[0].options.scales.x.max,clock);
    assert.equal(charts[0].data.datasets[0].data.at(-1).x,clock-20000);
    const lossPoint=charts[1].data.datasets[0].data.at(-1);
    assert.equal(lossPoint.y,100/15);
    assert.equal(charts[1].options.scales.y.max,10);
    assert.match(charts[1].options.plugins.tooltip.callbacks.label({parsed:{y:lossPoint.y},raw:lossPoint,dataset:{label:'测试线路'}}),/15 次中失败 1 次/);
    assert.equal(queries.length,10); // range/slider operations are local
    slider(1).props.onInput({target:{value:'120'}});await settle();
    const fixedLossEnd=charts[1].options.scales.x.max;
    assert.equal(charts[0].options.scales.x.max,clock);
    clock+=60000;
    await intervals[0].callback();await settle();
    assert.equal(queries.length,11);
    assert.equal(charts[0].options.scales.x.max,clock); // latency follows while loss reviews history
    assert.equal(charts[1].options.scales.x.max,fixedLossEnd);
    button('回到最新',1).props.onClick();await settle();
    assert.equal(charts[1].options.scales.x.max,clock);
    rangeHours.value=24;await settle(); // a page range change resets both charts to follow the latest
    assert.equal(all().filter(node=>node.type==='input'&&node.props.type==='range').length,0);
    document.hidden=true;
    await intervals[0].callback();
    assert.equal(queries.length,11);
    document.hidden=false;clock+=6*60000;allFailed=true;listeners.get('visibilitychange')();
    for(let i=0;i<20&&queries.length<12;i++)await settle();
    assert.equal(queries.length,12);
    await settle();
    assert.equal(charts[0].options.scales.x.max,clock);
    assert.equal(charts[1].data.datasets[0].data.at(-1).y,100); // actual all-failed windows remain 100%
    assert.equal(charts[1].options.scales.y.max,100);
    button('测试线路',0).props.onClick();await settle();
    assert.deepEqual(visibility(),[[true,true],[true,false]]);
    assert.equal(charts[1].options.scales.y.max,100); // latency visibility cannot change the loss axis
    button('备用线路',1).props.onClick();await settle();
    button('测试线路',1).props.onClick();await settle();
    assert.deepEqual(visibility(),[[true,true],[false,true]]);
    assert.equal(charts[1].options.scales.y.max,10); // only visible loss routes determine its axis
    assert.equal(button('测试线路',0).props['aria-pressed'],true);
    assert.equal(button('测试线路',1).props['aria-pressed'],false);
    button('备用线路',1).props.onClick();await settle();
    assert.deepEqual(visibility(),[[true,true],[false,false]]); // hiding every route is allowed
    button('测试线路',1).props.onClick();await settle();
    button('备用线路',1).props.onClick();await settle();
    assert.deepEqual(visibility(),[[true,true],[true,true]]);
    assert.equal(charts[1].options.scales.y.max,100);
    assert.equal(queries.length,12);
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
