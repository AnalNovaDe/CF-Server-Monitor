import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse, compileScript } from '@vue/compiler-sfc';
import { createRenderer, h, nextTick, ref } from 'vue';

// Live raw samples (latency.3 agents), adaptive latency axis with spike markers,
// and the SYN-retransmit toggle on the loss chart.
test('live samples draw within seconds, merge with history and the axis keeps spikes visible', async () => {
  const filename = new URL('../src/frontend/components/LatencyDetailCharts.vue', import.meta.url);
  const { descriptor } = parse(await readFile(filename, 'utf8'), { filename: filename.pathname });
  const vueURL = import.meta.resolve('vue');
  let source = compileScript(descriptor, { id: 'latency-live-test', inlineTemplate: true }).content;
  source = source.replaceAll("from 'vue'", `from '${vueURL}'`).replaceAll('from "vue"', `from '${vueURL}'`)
    .replace("import Chart from 'chart.js/auto'", 'const Chart=globalThis.__liveTestChart')
    .replace("import { http } from '../utils/http'", 'const http=globalThis.__liveTestHttp')
    .replace("import { currentLang } from '../utils/i18n'", "const currentLang=ref('zh')");
  for (const module of ['latencyDetail', 'latencyHistory']) {
    source = source.replace(`'../utils/${module}.js'`, `'${new URL(`../src/frontend/utils/${module}.js`, import.meta.url).href}'`);
  }
  const saved = Object.fromEntries(['document', 'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'setInterval', 'clearInterval'].map(key => [key, globalThis[key]]));
  const oldNow = Date.now;
  let clock = Math.floor(1800000000000 / 60000) * 60000 + 30000, app;
  const k = '0123456789abcdef', charts = [], intervals = [];
  const asOf = () => Math.floor(clock / 60000) * 60000;
  // 40 normal samples at ~50 ms on route 0, one 1100 ms SYN retransmit, one failure.
  const historySamples = Array.from({ length: 40 }, (_, i) => ({ p: 0, t: asOf() - 60000 - (40 - i) * 20000, r: 48 + (i % 5), k }));
  historySamples[30] = { ...historySamples[30], r: 1100 };
  historySamples[35] = { ...historySamples[35], r: null };
  class FakeChart {
    constructor(canvas, config) { this.canvas = canvas; this.data = config.data; this.options = config.options; charts.push(this); }
    update() {}
    destroy() { this.destroyed = true; }
  }
  globalThis.__liveTestChart = FakeChart;
  globalThis.__liveTestHttp = { async getByIndex(url) {
    const q = new URL(url, 'https://test').searchParams;
    const to = q.has('before') ? (Number(q.get('before')) || asOf()) : asOf();
    const from = q.has('before') ? asOf() - 86400000 : Number(q.get('after'));
    return { data: { enabled: true, as_of: asOf(), range_from: Math.max(from, to - 10800000), range_to: to, next_before: Math.max(from, to - 10800000), has_previous: false, next_after: to, has_more: false, samples: historySamples.filter(s => s.t >= from && s.t < to) } };
  } };
  globalThis.document = { hidden: false, body: { classList: { contains: () => true } }, addEventListener() {}, removeEventListener() {} };
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  globalThis.requestAnimationFrame = callback => setTimeout(callback, 0);
  globalThis.cancelAnimationFrame = clearTimeout;
  globalThis.setInterval = (callback, delay) => { const timer = { callback, delay }; intervals.push(timer); return timer; };
  globalThis.clearInterval = timer => { timer.cleared = true; };
  Date.now = () => clock;
  const detach = child => { if (child.parent) { const children = child.parent.children; children.splice(children.indexOf(child), 1); child.parent = null; } };
  const renderer = createRenderer({
    createElement: type => ({ type, props: {}, children: [] }), createText: text => ({ type: '#text', text }), createComment: text => ({ type: '#comment', text }),
    insert(child, parent, anchor) { detach(child); const index = anchor ? parent.children.indexOf(anchor) : -1; parent.children.splice(index < 0 ? parent.children.length : index, 0, child); child.parent = parent; },
    remove: detach, setText: (node, text) => { node.text = text; }, setElementText: (node, text) => { node.children = []; node.text = text; },
    patchProp: (node, key, previous, value) => { node.props[key] = value; }, parentNode: node => node.parent,
    nextSibling(node) { return node.parent?.children[node.parent.children.indexOf(node) + 1] || null; }
  });
  const root = { type: 'root', children: [] };
  const all = () => { const nodes = []; const visit = node => { nodes.push(node); for (const child of node.children || []) visit(child); }; visit(root); return nodes; };
  const text = node => node.type === '#comment' ? '' : (node.text || '') + (node.children || []).map(text).join('');
  const settle = async () => { await nextTick(); await new Promise(resolve => setTimeout(resolve, 5)); await nextTick(); };
  const button = label => all().find(node => node.type === 'button' && text(node) === label);
  const live = ref(null);
  const pingLine = () => charts[0].data.datasets.find(d => !d.isMarker && d.label === '测试线路');
  const markers = () => charts[0].data.datasets.filter(d => d.isMarker);
  try {
    const Component = (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)).default;
    app = renderer.createApp({ render: () => h(Component, { serverId: 'live-node', labels: ['测试线路'], selectedHours: 24, probeMode: 'tcp', liveSamples: live.value }) });
    app.mount(root);
    for (let i = 0; i < 60 && !text(root).includes('已读取完整'); i++) await settle();
    assert.match(text(root), /已读取完整/);
    await settle();

    // Adaptive axis: capped near the baseline, spike kept as a marker with its real value.
    assert.equal(charts[0].options.scales.y.max, 100);
    assert.match(text(root), /纵轴封顶 100 ms/);
    assert.match(text(root), /SYN/);
    assert.equal(markers().length, 1);
    assert.deepEqual(markers()[0].data.map(p => p.raw), [1100]);
    assert.equal(pingLine().data.find(p => p.raw === 1100).y, 100);
    const label = charts[0].options.plugins.tooltip.callbacks.label({ dataset: pingLine(), raw: pingLine().data.find(p => p.raw === 1100), parsed: { y: 100 } });
    assert.match(label, /1100 ms（疑似 SYN 重传）/);
    assert.equal(charts[0].options.plugins.tooltip.filter({ dataset: markers()[0] }), false, 'markers do not duplicate tooltips');
    button('自适应纵轴').props.onClick();
    await settle();
    assert.equal(charts[0].options.scales.y.max, undefined);
    assert.equal(markers().length, 0);
    button('完整纵轴').props.onClick();
    await settle();

    // Retransmit toggle: loss line adds SYN retransmits to failures.
    const lastLoss = () => charts[1].data.datasets[0].data.filter(p => p.y !== null).at(-1);
    const before = lastLoss();
    assert.equal(before.failed, 1);
    assert.equal(before.retrans, 1, 'the 1100 ms spike is still inside the 5-minute window');
    const atSpike = () => charts[1].data.datasets[0].data.find(p => p.x === historySamples[31].t);
    assert.equal(atSpike().y, 0);
    button('计入 SYN 重传').props.onClick();
    await settle();
    assert.equal(atSpike().retrans, 1);
    assert.equal(atSpike().failed, 0);
    assert.equal(atSpike().y, 100 / atSpike().attempts, 'retransmit counted as loss');
    button('计入 SYN 重传').props.onClick();
    await settle();

    // Live samples: appear immediately at the right edge, without waiting for the minute upload.
    assert.match(text(root), /每分钟自动刷新/);
    clock += 10000;
    const fresh = { p: 0, t: clock - 2000, r: 77, k };
    live.value = [fresh];
    await settle();
    assert.ok(pingLine().data.some(p => p.x === fresh.t && p.y === 77), 'live sample drawn');
    assert.ok(charts[0].options.scales.x.max >= fresh.t, 'view follows the live edge');
    assert.match(text(root), /实时（原始测量数秒内上图）/);
    const count = () => pingLine().data.filter(p => p.y !== null).length;
    const drawn = count();
    live.value = [fresh];
    await settle();
    assert.equal(count(), drawn, 'repeated echo is not duplicated');

    // Later the same sample arrives in a minute block: identical p:t:k, no duplicate.
    historySamples.push(fresh);
    clock += 60000;
    await intervals[0].callback();
    for (let i = 0; i < 10; i++) await settle();
    assert.equal(pingLine().data.filter(p => p.x === fresh.t).length, 1);
  } finally {
    app?.unmount(); Date.now = oldNow;
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
    delete globalThis.__liveTestChart; delete globalThis.__liveTestHttp;
  }
});
