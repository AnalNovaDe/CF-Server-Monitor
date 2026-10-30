import assert from 'node:assert/strict';
import test from 'node:test';

import { applyLiveLatencySample } from '../src/frontend/utils/liveLatencyWindow.js';

const W = 360000;
const base = [0, 1, 2, 3].map(i => ({ ts: 1000 + i * W, ct: 50 + i, cu: 60 }));

test('live sample inside newest bucket updates only that bucket', () => {
  const next = applyLiveLatencySample(base, { ping_ct: 120 }, 1000 + 3 * W + 1000, 'ping');
  assert.equal(next.length, 4);
  assert.equal(next[3].ct, 120);
  assert.equal(next[3].cu, 60, 'fields absent from the sample are kept');
  assert.equal(next[3].ts, base[3].ts);
  assert.deepEqual(next.slice(0, 3), base.slice(0, 3));
});

test('crossing the boundary shifts the window left by one bucket', () => {
  const next = applyLiveLatencySample(base, { ping_ct: 99 }, 1000 + 4 * W + 5, 'ping');
  assert.equal(next.length, 4);
  assert.equal(next[0].ts, base[1].ts);
  assert.equal(next[3].ts, 1000 + 4 * W);
  assert.equal(next[3].ct, 99);
});

test('skipped buckets stay empty and long gaps keep the window length', () => {
  const next = applyLiveLatencySample(base, { loss_ct: 0 }, 1000 + 6 * W + 5, 'loss');
  assert.equal(next.length, 4);
  assert.equal(next[2].ct, undefined);
  assert.equal(next[3].ct, 0);
  const far = applyLiveLatencySample(base, { loss_ct: 0 }, 1000 + 100 * W, 'loss');
  assert.equal(far.length, 4);
  assert.equal(far[3].ts, 1000 + 100 * W, 'newest bucket aligns to the live time');
  assert.deepEqual(far.map(p => p.ts), [97, 98, 99, 100].map(i => 1000 + i * W));
  assert.equal(far[0].ct, undefined);
});

test('ignores samples without latency fields, old samples and invalid windows', () => {
  assert.equal(applyLiveLatencySample(base, { cpu: 3 }, base[3].ts + 1, 'ping'), base);
  assert.equal(applyLiveLatencySample(base, { ping_ct: 1 }, 0, 'ping'), base);
  assert.equal(applyLiveLatencySample([base[0]], { ping_ct: 1 }, base[0].ts + 1, 'ping').length, 1);
  assert.equal(applyLiveLatencySample(undefined, { ping_ct: 1 }, 1, 'ping'), undefined);
});
