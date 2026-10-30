import test from 'node:test';
import assert from 'node:assert/strict';
import { toBroadcastSamples } from '../src/handlers/update.js';
import { sanitizeLatencyLive, LIVE_MAX_SAMPLES } from '../src/handlers/latencyDetail.js';

const k = '0123456789abcdef';

test('sanitizeLatencyLive keeps valid raw samples and drops malformed ones', () => {
  const live = sanitizeLatencyLive([
    { t: 1700000000000, p: 0, r: 1080, k },
    { t: 1700000000000, p: 1, r: null, k },
    { t: 1700000000000, p: 8, r: 10, k },
    { t: 1700000000000, p: 2, r: -1, k },
    { t: 1700000000000, p: 2, r: 5, k: 'nope' },
    { t: 'x', p: 2, r: 5, k },
    null
  ]);
  assert.deepEqual(live, [
    { t: 1700000000000, p: 0, r: 1080, k },
    { t: 1700000000000, p: 1, r: null, k }
  ]);
  assert.equal(sanitizeLatencyLive('x'), undefined);
  assert.equal(sanitizeLatencyLive([]), undefined);
  const many = Array.from({ length: 200 }, (_, i) => ({ t: 1 + i, p: 0, r: 1, k }));
  assert.equal(sanitizeLatencyLive(many).length, LIVE_MAX_SAMPLES);
});

test('latency_live reaches only the latest broadcast sample, sanitized', () => {
  const samples = [
    { ts: 1000, metrics: { cpu: 1, latency_live: [{ t: 1, p: 0, r: 1, k }] } },
    { ts: 3000, metrics: { cpu: 2 } }
  ];
  const report = { ping_ct: 50, latency_live: [{ t: 2500, p: 0, r: 51, k, extra: 'x' }, { t: 2500, p: 9, r: 1, k }] };
  const out = toBroadcastSamples('srv', samples, 'JP', '1.0.19-latency.3', report);
  assert.equal(out[0].payload.latency_live, undefined);
  assert.deepEqual(out[1].payload.latency_live, [{ t: 2500, p: 0, r: 51, k }]);
  assert.equal(out[1].payload.ping_ct, 50);
});

test('reports without latency_live are unchanged', () => {
  const out = toBroadcastSamples('srv', [{ ts: 1, metrics: { cpu: 1 } }], '', '', { ping_ct: 5 });
  assert.equal(Object.hasOwn(out[0].payload, 'latency_live'), false);
});
