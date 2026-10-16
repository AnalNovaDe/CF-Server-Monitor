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

export function detailNodes(env) {
  const ids = [...new Set(String(env.LATENCY_DETAIL_SERVER_IDS || '').split(',').map(s => s.trim()).filter(Boolean))];
  // Fail closed. This feature never enables itself or expands beyond six nodes.
  return ids.length <= 6 ? ids : [];
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
  const serverSlot = detailNodes(env).indexOf(data.id);
  if (serverSlot < 0) return json({ error: 'Latency detail is not enabled for this node' }, 403);
  if (!await getServerDetail(env.DB, data.id, true)) return json({ error: 'Not found' }, 404);
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
  if (!detailNodes(env).includes(data.id)) return json({ error: 'Latency detail is not enabled for this node' }, 403);
  if (!await getServerDetail(env.DB, data.id, true)) return json({ error: 'Not found' }, 404);
  try {
    await env.DB.prepare('SELECT server_slot FROM latency_detail LIMIT 0').all();
    return json({ enabled: true, version: '1.0.19-latency.2' });
  } catch { return json({ error: 'Latency storage unavailable; check migration and D1 usage' }, 503); }
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
  const serverSlot = detailNodes(env).indexOf(id);
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
