import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { MINUTE, SLOTS, MAX_DETAIL_NODES, handleLatencyUpload, handleLatencyHistory, handleLatencyInstallCheck, listDetailNodes, resolveDetailSlot, resetDetailRegistryCache } from '../src/handlers/latencyDetail.js';
import { clearServersListCache } from '../src/utils/cache.js';

const key = '0123456789abcdef';
const sql = name => readFile(new URL(`../migrations-custom/${name}`, import.meta.url), 'utf8');

test('migration 002 keeps stored minutes, seeds legacy slots and enrols new nodes automatically', async () => {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch(){return new Response("ok")} }', compatibilityDate: '2024-12-01', d1Databases: { DB: 'enrol-test' } });
  try {
    const db = await mf.getD1Database('DB');
    await db.prepare(await sql('001_latency_detail.sql')).run();
    await db.exec('CREATE TABLE servers(id TEXT PRIMARY KEY, is_hidden INTEGER);');
    const ids = Array.from({ length: 12 }, (_, i) => `node-${i}`);
    for (const id of ids) await db.prepare('INSERT INTO servers VALUES (?, 0)').bind(id).run();
    // Legacy roster: node-1 sits in slot 0 and node-0 in slot 1, so seeding must follow the variable's order.
    const env = { DB: db, API_SECRET: 's', LATENCY_DETAIL_SERVER_IDS: 'node-1,node-0' };
    const minute = Math.floor(Date.now() / MINUTE) - 1;
    const block = id => ({ minute, samples: [{ t: minute * MINUTE + 1000, p: 0, r: 42, k: key }] });
    const upload = id => handleLatencyUpload(new Request('https://t/update/latency', { method: 'POST', headers: { Authorization: 'Bearer s' }, body: JSON.stringify({ id, blocks: [block(id)] }) }), env);
    const check = id => handleLatencyInstallCheck(new Request('https://t/update/latency-check', { method: 'POST', headers: { Authorization: 'Bearer s' }, body: JSON.stringify({ id }) }), env);
    const history = async id => (await handleLatencyHistory(new Request(`https://t/api/history/latency?id=${id}&before=0`), env, { is_public: 'true' }, {})).json();

    // Before 002: unchanged behaviour, the variable is the whole list.
    resetDetailRegistryCache();
    assert.equal((await upload('node-1')).status, 200);
    assert.equal((await upload('node-5')).status, 403);
    assert.deepEqual(await listDetailNodes(env), { ids: ['node-1', 'node-0'], max: 6, auto: false });

    await db.exec((await sql('002_latency_detail_auto_enrol.sql')).replace(/--[^\n]*/g, '').replace(/\s*\n\s*/g, ' '));
    resetDetailRegistryCache();
    // The stored minute survived the rebuild and is still served from slot 0.
    assert.equal((await history('node-1')).samples.length, 1);
    assert.equal(await resolveDetailSlot(env, 'node-1'), 0);
    assert.equal(await resolveDetailSlot(env, 'node-0'), 1);
    // History reads never enrol.
    assert.equal((await history('node-5')).enabled, false);
    assert.equal(await resolveDetailSlot(env, 'node-5'), -1);
    // The install check enrols into the lowest free slot and keeps the installer's exact reply.
    const ready = await check('node-5');
    assert.equal(ready.status, 200);
    assert.equal(await ready.text(), '{"enabled":true,"version":"1.1.4-latency.1"}');
    assert.equal(await resolveDetailSlot(env, 'node-5'), 2);
    // An already-installed Agent enrols on its first upload too.
    assert.equal((await upload('node-6')).status, 200);
    assert.equal(await resolveDetailSlot(env, 'node-6'), 3);
    assert.equal((await history('node-6')).samples.length, 1);
    // Unknown servers never take a slot.
    clearServersListCache();
    assert.equal((await check('ghost')).status, 404);
    // Fill up to the cap; the next node is refused, nothing beyond slot 9 is ever written.
    for (const id of ['node-7', 'node-8', 'node-9', 'node-10', 'node-11', 'node-2']) assert.equal((await check(id)).status, 200, id);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM latency_detail_nodes').first()).n, MAX_DETAIL_NODES);
    assert.equal((await check('node-3')).status, 403);
    assert.equal((await upload('node-3')).status, 403);
    // Deleting a server frees its slot for the next node; the new node never sees the old node's minutes.
    await db.prepare('DELETE FROM servers WHERE id = ?').bind('node-6').run();
    clearServersListCache();
    assert.equal((await check('node-3')).status, 200);
    assert.equal(await resolveDetailSlot(env, 'node-3'), 3);
    assert.equal((await history('node-3')).samples.length, 0);
    assert.equal((await upload('node-3')).status, 200);
    assert.equal((await history('node-3')).samples.length, 1);
    const listed = await listDetailNodes(env);
    assert.equal(listed.auto, true);
    assert.equal(listed.max, MAX_DETAIL_NODES);
    assert.equal(listed.ids.length, MAX_DETAIL_NODES);
    assert.ok(!listed.ids.includes('node-6'));
    // The rebuilt table accepts slot 9 and still rejects anything past the cap.
    const write = slot => db.prepare('INSERT INTO latency_detail (server_slot, server_id, slot, minute, samples) VALUES (?, ?, 0, ?, ?)').bind(slot, 'x', minute, '[]').run();
    await write(9);
    await assert.rejects(() => write(MAX_DETAIL_NODES));
    await assert.rejects(() => db.prepare('INSERT INTO latency_detail_nodes VALUES (10, ?, 0)').bind('node-x').run());
    assert.equal(SLOTS, 1440);
  } finally { await mf.dispose(); }
});
