// Custom extension v1. Immutable minute blocks, bounded 24-hour ring per node.
import { checkAuth, simpleAuthResponse } from '../middleware/auth.js';
import { getServerDetail } from '../utils/cache.js';

export const MINUTE = 60000;
export const SLOTS = 1440;
export const BLOCK_SQL = `INSERT INTO latency_detail (server_slot, slot, server_id, minute, samples)
VALUES (?, ?, ?, ?, ?) ON CONFLICT(server_slot, slot) DO UPDATE SET
server_id=excluded.server_id, minute=excluded.minute, samples=excluded.samples
WHERE excluded.minute > latency_detail.minute`;
const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

// Legacy allowlist (Cloudflare variable). Before migration 002 it is the whole list (at most six,
// fail closed); after it, it only seeds the registry once, keeping each node's existing slot.
export function detailNodes(env) {
  const ids = [...new Set(String(env.LATENCY_DETAIL_SERVER_IDS || '').split(',').map(s => s.trim()).filter(Boolean))];
  return ids.length <= 6 ? ids : [];
}

// Migration 002: nodes enrol themselves when the custom Agent is installed or first uploads, up to
// MAX_DETAIL_NODES (about 1,440 D1 rows written per node per day). Deleting a server frees its slot.
export const MAX_DETAIL_NODES = 10;
const REGISTRY_RECHECK_MS = 60000;
let registryState = { ready: false, checkedAt: 0 };

export function resetDetailRegistryCache() { registryState = { ready: false, checkedAt: 0 }; }

async function registryReady(db) {
  if (registryState.ready) return true;
  if (Date.now() - registryState.checkedAt < REGISTRY_RECHECK_MS) return false;
  try {
    await db.prepare('SELECT server_slot FROM latency_detail_nodes LIMIT 0').all();
    registryState = { ready: true, checkedAt: Date.now() };
  } catch {
    registryState = { ready: false, checkedAt: Date.now() };
  }
  return registryState.ready;
}

const ENROL_SQL = `INSERT OR IGNORE INTO latency_detail_nodes (server_slot, server_id, enrolled_at)
SELECT free.s, ?1, ?2 FROM (
  WITH RECURSIVE n(s) AS (SELECT 0 UNION ALL SELECT s + 1 FROM n WHERE s < ${MAX_DETAIL_NODES - 1})
  SELECT s FROM n WHERE s NOT IN (SELECT server_slot FROM latency_detail_nodes) ORDER BY s LIMIT 1
) AS free WHERE EXISTS (SELECT 1 FROM servers WHERE id = ?1)`;

async function seedRegistry(env) {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM latency_detail_nodes').first();
  if (Number(row?.n) > 0) return;
  const ids = detailNodes(env);
  if (!ids.length) return;
  await env.DB.batch(ids.map((id, slot) => env.DB.prepare(
    'INSERT OR IGNORE INTO latency_detail_nodes (server_slot, server_id, enrolled_at) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM servers WHERE id = ?)'
  ).bind(slot, id, Date.now(), id)));
}

// Returns the node's ring slot, or -1. With enrol, frees slots of deleted servers and claims the
// lowest free slot for an existing server.
export async function resolveDetailSlot(env, id, { enrol = false } = {}) {
  if (!await registryReady(env.DB)) return detailNodes(env).indexOf(id);
  await seedRegistry(env);
  const find = async () => (await env.DB.prepare('SELECT server_slot FROM latency_detail_nodes WHERE server_id = ?').bind(id).first())?.server_slot;
  let slot = await find();
  if (slot === undefined && enrol) {
    await env.DB.prepare('DELETE FROM latency_detail_nodes WHERE server_id NOT IN (SELECT id FROM servers)').run();
    const claimed = await env.DB.prepare(ENROL_SQL).bind(id, Date.now()).run();
    slot = await find();
    // A reused slot may still hold a deleted node's minutes; clear them once (primary-key prefix,
    // at most 1,440 rows) so the newcomer's first minutes are never refused as duplicates.
    if (Number.isInteger(slot) && claimed.meta?.changes > 0) {
      await env.DB.prepare('DELETE FROM latency_detail WHERE server_slot = ? AND server_id <> ?').bind(slot, id).run();
    }
  }
  return Number.isInteger(slot) ? slot : -1;
}

// For the admin page: enrolled nodes, capacity and whether new nodes enrol automatically.
export async function listDetailNodes(env) {
  if (!await registryReady(env.DB)) return { ids: detailNodes(env), max: 6, auto: false };
  await seedRegistry(env);
  const { results = [] } = await env.DB.prepare(
    'SELECT n.server_id FROM latency_detail_nodes n JOIN servers s ON s.id = n.server_id ORDER BY n.server_slot'
  ).all();
  return { ids: results.map(r => r.server_id), max: MAX_DETAIL_NODES, auto: true };
}

export function validateBlock(block, now = Date.now()) {
  const minute = block?.minute;
  const latest = Math.floor(now / MINUTE) - 1;
  if (!Number.isSafeInteger(minute) || minute > latest || minute < latest - SLOTS + 1) throw new Error('invalid minute');
  if (!Array.isArray(block.samples) || !block.samples.length || block.samples.length > 32) throw new Error('invalid sample count');
  const last = new Map();
  const samples = block.samples.map(s => {
    if (!Number.isInteger(s.p) || s.p < 0 || s.p > 7 || !Number.isSafeInteger(s.t) || Math.floor(s.t / MINUTE) !== minute) throw new Error('invalid sample');
    if (s.r !== null && (!Number.isInteger(s.r) || s.r < 0 || s.r > 60000)) throw new Error('invalid latency');
    if (!/^[a-f0-9]{16}$/.test(s.k)) throw new Error('invalid target key');
    if (last.has(s.p) && s.t - last.get(s.p) < 15000) throw new Error('sample frequency exceeds budget');
    last.set(s.p, s.t);
    return { t: s.t, p: s.p, r: s.r, k: s.k };
  });
  return { minute, samples };
}

async function boundedJSON(request) {
  if (Number(request.headers.get('Content-Length')) > 16384) throw new Error('payload too large');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('empty payload');
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 16384) { await reader.cancel(); throw new Error('payload too large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export async function handleLatencyUpload(request, env) {
  if (!env.API_SECRET || request.headers.get('Authorization') !== `Bearer ${env.API_SECRET}`) return json({ error: 'Unauthorized' }, 401);
  let data;
  try { data = await boundedJSON(request); } catch { return json({ error: 'Invalid payload' }, 400); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return json({ error: 'Invalid payload' }, 400);
  if (typeof data.id !== 'string' || !await getServerDetail(env.DB, data.id, true)) return json({ error: 'Not found' }, 404);
  let serverSlot;
  try { serverSlot = await resolveDetailSlot(env, data.id, { enrol: true }); } catch (e) {
    console.error('[latency-detail] enrol failed', e.message);
    return json({ error: 'Latency storage unavailable; check migration and D1 usage' }, 503);
  }
  if (serverSlot < 0) return json({ error: 'Latency detail is not enabled for this node (all slots in use)' }, 403);
  let blocks;
  try {
    if (!Array.isArray(data.blocks) || !data.blocks.length || data.blocks.length > 5) throw new Error('invalid block count');
    blocks = data.blocks.map(b => validateBlock(b));
    if (new Set(blocks.map(b => b.minute)).size !== blocks.length) throw new Error('duplicate minute');
  } catch (e) { return json({ error: e.message }, 400); }
  try {
    const result = await env.DB.batch(blocks.map(block => env.DB.prepare(BLOCK_SQL).bind(serverSlot, block.minute % SLOTS, data.id, block.minute, JSON.stringify(block.samples))));
    // A duplicate is also acknowledged: never rewrite a minute on a lost ACK.
    return json({ ok: true, minutes: blocks.map(b => b.minute), rows_written: result.reduce((n, r) => n + (r.meta?.rows_written || 0), 0) });
  } catch (e) {
    console.error('[latency-detail] write failed', e.message);
    return json({ error: 'Latency storage unavailable; check migration and D1 usage' }, 503);
  }
}

// A one-time, authenticated check before installation; never writes a minute block.
export async function handleLatencyInstallCheck(request, env) {
  if (!env.API_SECRET || request.headers.get('Authorization') !== `Bearer ${env.API_SECRET}`) return json({ error: 'Unauthorized' }, 401);
  let data;
  try { data = await boundedJSON(request); } catch { return json({ error: 'Invalid payload' }, 400); }
  if (!data || typeof data.id !== 'string') return json({ error: 'Invalid server ID' }, 400);
  if (!await getServerDetail(env.DB, data.id, true)) return json({ error: 'Not found' }, 404);
  try {
    if (await resolveDetailSlot(env, data.id, { enrol: true }) < 0) return json({ error: 'Latency detail is not enabled for this node (all slots in use)' }, 403);
    await env.DB.prepare('SELECT server_slot FROM latency_detail LIMIT 0').all();
    return json({ enabled: true, version: '1.0.19-latency.5' });
  } catch { return json({ error: 'Latency storage unavailable; check migration and D1 usage' }, 503); }
}

// latency.3+ agents echo recent raw probe samples in every realtime report (latency.5: 150s,
// at most 72). Broadcast only: never written to D1 here (minute blocks remain the record).
export const LIVE_MAX_SAMPLES = 96;
export function sanitizeLatencyLive(value) {
  if (!Array.isArray(value)) return undefined;
  const out = [];
  for (const s of value.slice(-LIVE_MAX_SAMPLES)) {
    if (!s || !Number.isSafeInteger(s.t) || s.t <= 0 || !Number.isInteger(s.p) || s.p < 0 || s.p > 7) continue;
    if (s.r !== null && (!Number.isInteger(s.r) || s.r < 0 || s.r > 60000)) continue;
    if (typeof s.k !== 'string' || !/^[a-f0-9]{16}$/.test(s.k)) continue;
    out.push({ t: s.t, p: s.p, r: s.r, k: s.k });
  }
  return out.length ? out : undefined;
}

// Primary-key ranges, not a scan of the resource history tables.
export function slotRanges(first, last) {
  if (last - first + 1 >= SLOTS) return [[0, SLOTS - 1]];
  const a = first % SLOTS, b = last % SLOTS;
  return a <= b ? [[a, b]] : [[a, SLOTS - 1], [0, b]];
}

export async function handleLatencyHistory(request, env, sys, ctx) {
  const loggedIn = await checkAuth(request, env, sys);
  if (sys.is_public !== 'true' && !loggedIn) return simpleAuthResponse();
  const url = new URL(request.url), id = url.searchParams.get('id');
  if (!id || !await getServerDetail(env.DB, id, loggedIn)) return json({ error: 'Not found' }, 404);
  let serverSlot;
  try { serverSlot = await resolveDetailSlot(env, id); } catch { serverSlot = -1; }
  if (serverSlot < 0) return json({ enabled: false, samples: [] });
  const now = Date.now(), latest = Math.floor(now / MINUTE) - 1;
  const after = Number(url.searchParams.get('after') || 0);
  const backwards = url.searchParams.has('before');
  const before = Number(url.searchParams.get('before') || 0);
  if (![after, before].every(n => Number.isSafeInteger(n) && n >= 0 && n <= now)) return json({ error: 'Invalid cursor' }, 400);
  const earliest = latest - SLOTS + 1;
  // before=0 starts at the newest closed minute. Subsequent cursors are exclusive.
  // Keep the existing forward protocol and the 180-minute CPU/read bound.
  const last = backwards
    ? Math.max(earliest, Math.min(latest, before ? Math.floor(before / MINUTE) - 1 : latest))
    : Math.min(latest, Math.max(earliest, Math.floor(after / MINUTE)) + 179);
  const first = backwards ? Math.max(earliest, last - 179) : Math.max(earliest, Math.min(latest, Math.floor(after / MINUTE)));
  // Auth is checked BEFORE cache access. Coarsen cursors to minute boundaries.
  const cacheKey = new Request(`${url.origin}/__latency_cache/v2/${serverSlot}/${encodeURIComponent(id)}/${first}/${last}`);
  const cache = globalThis.caches?.default;
  const cached = await cache?.match(cacheKey);
  if (cached) {
    const headers = new Headers(cached.headers);
    headers.set('Cache-Control', 'no-store');
    return new Response(cached.body, { status: cached.status, headers });
  }
  try {
    const statements = slotRanges(first, last).map(([a, b]) => env.DB.prepare(
      'SELECT minute, samples FROM latency_detail WHERE server_slot=? AND slot>=? AND slot<=? AND server_id=? AND minute>=? AND minute<=?'
    ).bind(serverSlot, a, b, id, first, last));
    const result = await env.DB.batch(statements);
    const samples = result.flatMap(r => r.results || []).flatMap(r => JSON.parse(r.samples)).sort((a, b) => a.t - b.t || a.p - b.p);
    // Cursor follows persisted records, never wall time: delayed uploads remain visible.
    const cursor = samples.length ? Math.max(after, ...samples.map(s => s.t)) : after;
    const body = { enabled: true, interval_seconds: 20, retention_hours: 24, cursor,
      next_after: (last + 1) * MINUTE, has_more: last < latest, as_of: (latest + 1) * MINUTE,
      range_from: first * MINUTE, range_to: (last + 1) * MINUTE,
      next_before: first * MINUTE, has_previous: first > earliest, samples };
    const response = json(body);
    if (cache && ctx?.waitUntil) {
      const headers = new Headers(response.headers);
      headers.set('Cache-Control', 'max-age=60');
      ctx.waitUntil(cache.put(cacheKey, new Response(response.clone().body, { headers })));
    }
    return response;
  } catch (e) {
    console.error('[latency-detail] read failed', e.message);
    return json({ error: 'Latency storage unavailable; check migration and D1 usage' }, 503);
  }
}
