// Offline review harness: compiles the actual Vue component, uses labeled synthetic data.
// This is not a production build or an alternative backend.
import fs from 'node:fs';
import path from 'node:path';
import { parse, compileScript, compileStyle } from '@vue/compiler-sfc';
const out = path.resolve(process.argv[2] || '../../outputs/latency-preview');
fs.mkdirSync(out, { recursive: true });
const filename='src/frontend/components/LatencyDetailCharts.vue';
const {descriptor}=parse(fs.readFileSync(filename,'utf8'),{filename});
let script=compileScript(descriptor,{id:'latency-review',inlineTemplate:true}).content;
script=script.replaceAll("from 'vue'","from './vue.js'").replaceAll('from "vue"','from "./vue.js"');
script=script.replace("import Chart from 'chart.js/auto'",'const Chart=window.Chart');
script=script.replace("import { http } from '../utils/http'",'const http={getByIndex:(...args)=>window.demoHttp.getByIndex(...args)}');
script=script.replace("import { currentLang } from '../utils/i18n'",'const currentLang=ref("zh")');
script=script.replace("'../utils/latencyDetail.js'","'./series.js'");
fs.writeFileSync(path.join(out,'component.js'),script);
fs.copyFileSync('node_modules/vue/dist/vue.esm-browser.prod.js',path.join(out,'vue.js'));
fs.copyFileSync('node_modules/chart.js/dist/chart.umd.js',path.join(out,'chart.js'));
fs.copyFileSync('src/frontend/utils/latencyDetail.js',path.join(out,'series.js'));
fs.copyFileSync('src/frontend/styles/main.css',path.join(out,'main.css'));
fs.copyFileSync('src/frontend/styles/light.css',path.join(out,'light.css'));
const styles=descriptor.styles.map(s=>compileStyle({source:s.content,filename,id:'latency-review',scoped:false}).code).join('\n');
fs.writeFileSync(path.join(out,'component.css'),styles);
fs.writeFileSync(path.join(out,'index.html'),`<!doctype html><html lang="zh" data-theme="light"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CFM 延迟改造 · 模拟数据预览</title><link rel="stylesheet" href="main.css"><link rel="stylesheet" href="light.css"><link rel="stylesheet" href="component.css"><style>body{padding:24px}.charts-grid{display:grid;grid-template-columns:1fr;gap:20px;max-width:1500px;margin:auto}h2{font-size:18px;margin:12px auto;max-width:1500px} .chart-card{width:100%} .btn{cursor:pointer} @media(max-width:600px){body{padding:8px}}</style><body class="light"><h2>CFMonitor · 延迟与失败率改造预览</h2><p style="max-width:1500px;margin:12px auto">模拟数据，仅验证图表交互：8 条线路、每 20 秒采样、24h、短时尖峰及失败。不是你的服务器数据。</p><div id="app" class="charts-grid"></div><script src="chart.js"></script><script type="module">
import {createApp,h} from './vue.js';import Component from './component.js';
const now=Date.now(),samples=[];for(let n=0;n<4320;n++)for(let p=0;p<8;p++){const t=now-86400000+n*20000;const r=(n>=4200&&n<4205&&p===0)?null:Math.round(45+p*12+Math.sin(n*.17+p)*6+Math.cos(n*.07)*4+(n===4175&&p===0?180:0));samples.push({t,p,r,k:'0123456789abcdef'})}
window.demoHttp={async getByIndex(url){const after=Number(new URL(url,'https://demo').searchParams.get('after')||0);return {data:{enabled:true,samples:samples.filter(s=>s.t>=after),cursor:samples.at(-1).t,as_of:now,has_more:false}}}};
createApp({render:()=>h(Component,{serverId:'demo',labels:['广东电信 v4','广东联通 v4','广东移动 v4','广东移动 v6','上海电信 v4','上海联通 v4','上海移动 v4','上海移动 v6']})}).mount('#app');
</script></html>`);
console.log(`Review harness: ${out}`);
