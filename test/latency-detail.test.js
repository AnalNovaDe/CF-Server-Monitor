import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { BLOCK_SQL, MINUTE, SLOTS, validateBlock, detailNodes, slotRanges, handleLatencyUpload, handleLatencyHistory } from '../src/handlers/latencyDetail.js';
import { mergeLatencySamples, latencySeries } from '../src/frontend/utils/latencyDetail.js';

const key='0123456789abcdef';
test('bounded opt-in and sample validation',()=>{
 assert.deepEqual(detailNodes({}),[]);
 assert.deepEqual(detailNodes({LATENCY_DETAIL_SERVER_IDS:'1,2,3,4,5,6,7'}),[]);
 const minute=10000,now=(minute+1)*MINUTE;
 const s={t:minute*MINUTE+10,p:0,r:999,k:key};
 assert.equal(validateBlock({minute,samples:[s]},now).samples[0].r,999);
 assert.throws(()=>validateBlock({minute:minute+1,samples:[s]},now));
 assert.throws(()=>validateBlock({minute,samples:[s,{...s,t:s.t+1000}]},now));
 assert.throws(()=>validateBlock({minute,samples:[{...s,r:false}]},now));
 assert.equal(validateBlock({minute,samples:[{...s,r:null}]},now).samples[0].r,null);
 assert.deepEqual(slotRanges(1438,1442),[[1438,1439],[0,2]]);
});

test('charts preserve spike, missing span, timeout, target switch and bounded data',()=>{
 const now=200000000,base={p:0,k:key};
 const samples=[{...base,t:now-120000,r:50},{...base,t:now-100000,r:1200},{...base,t:now-80000,r:null},{...base,t:now-10000,r:60}];
 const rows=latencySeries(samples,0);
 assert.ok(rows.ping.some(p=>p.y===1200));
 assert.equal(rows.loss[2].y,100/3);
 assert.equal(rows.loss.at(-1).y,0);
 assert.ok(rows.ping.some(p=>p.x===now-79999 && p.y===null));
 assert.equal(rows.loss[2].failed,1);
 assert.equal(rows.loss[2].retrans,1,'1200ms TCP connect counts as a SYN retransmission');
 assert.equal(rows.loss.at(-1).retrans,0,'gap resets the window');
 assert.equal(mergeLatencySamples(samples,samples,now).length,4);
 assert.equal(mergeLatencySamples(samples,[],now+86400001).length,0);
 const changed=latencySeries([...samples,{...base,k:'ffffffffffffffff',t:now,r:70}],0);
 assert.equal(changed.loss.at(-1).attempts,1);
});

test(`${process.env.LATENCY_TEST_SQLITE ? 'SQLite compatibility' : 'D1 runtime'}: ring, retries, ACL, raw roundtrip`,async()=>{
 const originalCaches=globalThis.caches;
 let mf;
 if (process.env.LATENCY_TEST_SQLITE) {
  const {DatabaseSync}=await import('node:sqlite');const sql=new DatabaseSync(':memory:');
  const prepare=(text)=>({bind(...args){return {async first(){return sql.prepare(text).get(...args)||null},async all(){return {results:sql.prepare(text).all(...args)}},async run(){const r=sql.prepare(text).run(...args);return {meta:{rows_written:Number(r.changes)}}}}},async first(){return sql.prepare(text).get()||null},async run(){const r=sql.prepare(text).run();return {meta:{rows_written:Number(r.changes)}}}});
  const db={prepare,async exec(text){sql.exec(text)},async batch(statements){const out=[];sql.exec('BEGIN');try{for(const s of statements)out.push(s.all ? await s.all():await s.run());sql.exec('COMMIT');return out}catch(e){sql.exec('ROLLBACK');throw e}}};
  // SELECTs need .all(), mutations need .run(), matching the D1 batch API.
  const oldPrepare=db.prepare;db.prepare=text=>{const stmt=oldPrepare(text);const bind=stmt.bind;stmt.bind=(...args)=>{const out=bind(...args);if(!/^SELECT/i.test(text.trim()))delete out.all;return out};return stmt};
  mf={async getD1Database(){return db},async dispose(){sql.close()}};
 } else mf=new Miniflare({modules:true,script:'export default { fetch(){return new Response("ok")} }',compatibilityDate:'2024-12-01',d1Databases:{DB:'latency-test'}});
 try {
  const db=await mf.getD1Database('DB');
  await db.prepare(await readFile(new URL('../migrations-custom/001_latency_detail.sql',import.meta.url),'utf8')).run();
  await db.exec('CREATE TABLE servers(id TEXT PRIMARY KEY, is_hidden INTEGER); INSERT INTO servers VALUES (\'detail-test-node\',0),(\'detail-hidden-node\',1);');
  const env={DB:db,API_SECRET:'test-secret',LATENCY_DETAIL_SERVER_IDS:'detail-test-node,detail-hidden-node'};
  const minute=Math.floor(Date.now()/MINUTE)-1;
  const samples=[{t:minute*MINUTE+1000,p:0,r:1200,k:key},{t:minute*MINUTE+21000,p:0,r:null,k:key}];
  const upload=(secret='test-secret',block={minute,samples})=>new Request('https://test/update/latency',{method:'POST',headers:{Authorization:`Bearer ${secret}`},body:JSON.stringify({id:'detail-test-node',blocks:[block]})});
  assert.equal((await handleLatencyUpload(upload('wrong'),env)).status,401);
  assert.equal((await handleLatencyUpload(upload(),env)).status,200);
  const retry=await handleLatencyUpload(upload('test-secret',{minute,samples:[{...samples[0],r:1}]}),env);
  assert.equal((await retry.json()).rows_written,0);
  const req=new Request(`https://test/api/history/latency?id=detail-test-node&after=${minute*MINUTE}`);
  assert.equal((await handleLatencyHistory(req,env,{is_public:'false'},{})).status,401);
  assert.equal((await handleLatencyHistory(new Request('https://test/api/history/latency?id=detail-hidden-node'),env,{is_public:'true'},{})).status,404);
  const history=await (await handleLatencyHistory(req,env,{is_public:'true'},{})).json();
  assert.deepEqual(history.samples,samples);
  assert.equal(history.cursor,samples[1].t);
  const entries=new Map(), pending=[];let cacheHits=0;
  globalThis.caches={default:{async match(key){const hit=entries.get(key.url);if(hit){cacheHits++;return hit.clone()}},async put(key,response){entries.set(key.url,new Response(await response.arrayBuffer(),{headers:response.headers}))}}};
  const cacheContext={waitUntil(promise){pending.push(promise)}};
  await (await handleLatencyHistory(req,env,{is_public:'true'},cacheContext)).json();
  await Promise.all(pending);
  const cachedResponse=await handleLatencyHistory(req,env,{is_public:'true'},cacheContext);
  assert.equal(cachedResponse.headers.get('Cache-Control'),'no-store');
  assert.deepEqual((await cachedResponse.json()).samples,samples);assert.equal(cacheHits,1);
  assert.equal((await handleLatencyHistory(req,env,{is_public:'false'},cacheContext)).status,401);
  assert.equal(cacheHits,1); // No cached response is served before the access check.
  globalThis.caches=originalCaches;
  assert.equal((await handleLatencyUpload(new Request('https://test/update/latency',{method:'POST',headers:{Authorization:'Bearer test-secret'},body:'null'}),env)).status,400);
  // A full day is paged with empty ranges included; cursor still advances.
  const oldest=minute-SLOTS+1;
  for(let page=0;page<8;page++) {
   const m=oldest+page*180;
   await db.prepare(BLOCK_SQL).bind(0,m%SLOTS,'detail-test-node',m,JSON.stringify([{p:0,t:m*MINUTE+1000,r:42,k:key}])).run();
  }
  let after=0, pages=0, merged=[];
  while(true) {
   const body=await (await handleLatencyHistory(new Request(`https://test/api/history/latency?id=detail-test-node&after=${after}`),env,{is_public:'true'},{})).json();
   merged.push(...body.samples);pages++;
   if(!body.has_more)break;
   assert.ok(body.next_after>after);after=body.next_after;
   assert.ok(pages<=8);
  }
  assert.equal(pages,8);assert.equal(merged.length,10);
  // Newest-first uses the same bounded pages and visits the entire ring exactly once.
  let before=0, backwardsPages=0, reverseSamples=[], covered=0;
  while(true) {
   const body=await (await handleLatencyHistory(new Request(`https://test/api/history/latency?id=detail-test-node&before=${before}`),env,{is_public:'true'},{})).json();
   assert.ok(body.range_to-body.range_from<=180*MINUTE);
   if(backwardsPages===0)assert.deepEqual(body.samples.slice(-2),samples);
   else assert.equal(body.range_to,before);
   assert.equal(body.next_before,body.range_from);
   covered+=(body.range_to-body.range_from)/MINUTE;
   reverseSamples.push(...body.samples);backwardsPages++;
   if(!body.has_previous)break;
   assert.ok(body.next_before<before || before===0);before=body.next_before;
   assert.ok(backwardsPages<=8);
  }
  assert.equal(backwardsPages,8);assert.equal(covered,1440);assert.equal(reverseSamples.length,10);
  assert.equal(new Set(reverseSamples.map(s=>`${s.p}:${s.t}`)).size,10);
  assert.equal((await handleLatencyHistory(new Request('https://test/api/history/latency?id=detail-test-node&before=nope'),env,{is_public:'true'},{})).status,400);
  assert.equal((await handleLatencyHistory(new Request('https://test/api/history/latency?id=detail-hidden-node&before=0'),env,{is_public:'true'},{})).status,404);
  // Slots are fixed even after the roster replaces a UUID.
  const replacementMinute=oldest+SLOTS;
  await db.prepare(BLOCK_SQL).bind(0,oldest%SLOTS,'replacement-node',replacementMinute,'[]').run();
  assert.equal((await db.prepare('SELECT count(*) n FROM latency_detail').first()).n,9);
  await assert.rejects(()=>db.prepare(BLOCK_SQL).bind(6,0,'seventh-node',minute,'[]').run());
  await assert.rejects(()=>db.prepare(BLOCK_SQL).bind(0,SLOTS,'bad-slot',minute,'[]').run());
  // Empty the extra fixtures before the one-slot rollover assertions below.
  await db.prepare('DELETE FROM latency_detail WHERE slot <> ?').bind(minute%SLOTS).run();
  const first=await db.prepare('SELECT samples FROM latency_detail').first();assert.equal(JSON.parse(first.samples)[0].r,1200);
  await db.prepare(BLOCK_SQL).bind(0,minute%SLOTS,'detail-test-node',minute+SLOTS,'[]').run();
  await db.prepare(BLOCK_SQL).bind(0,minute%SLOTS,'detail-test-node',minute,'[]').run();
  assert.equal((await db.prepare('SELECT count(*) n, max(minute) m FROM latency_detail').first()).n,1);
  assert.equal((await db.prepare('SELECT max(minute) m FROM latency_detail').first()).m,minute+SLOTS);
 } finally {globalThis.caches=originalCaches;await mf.dispose()}
});
