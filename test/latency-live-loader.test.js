import test from 'node:test';
import assert from 'node:assert/strict';
import { createLatencyHistoryLoader } from '../src/frontend/utils/latencyHistory.js';

const k = '0123456789abcdef';

test('live samples that arrive before the first history page are merged, not dropped', async () => {
  const minute = 60000, asOf = Math.floor(1800000000000 / minute) * minute, now = asOf + 30000;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const loader = createLatencyHistoryLoader({
    now: () => now,
    onChange() {},
    request: async () => {
      await gate;
      return { data: { enabled: true, as_of: asOf, range_from: asOf - 180 * minute, range_to: asOf, next_before: asOf - 180 * minute,
        has_previous: false, samples: [{ p: 0, t: asOf - 120000, r: 50, k }] } };
    }
  });
  const loading = loader.load();
  // Replayed latest report covering the minute not uploaded yet.
  assert.equal(loader.addLive([{ p: 0, t: asOf - 40000, r: 60, k }, { p: 0, t: asOf + 10000, r: 61, k }]), false);
  release();
  await loading;
  assert.deepEqual(loader.state.samples.map(s => s.r), [50, 60, 61]);
  assert.ok(loader.state.liveAt, 'marked live');
  // After that, live samples merge directly and duplicates are ignored.
  assert.equal(loader.addLive([{ p: 0, t: asOf + 10000, r: 61, k }]), false);
  assert.equal(loader.addLive([{ p: 0, t: asOf + 25000, r: 62, k }]), true);
  assert.equal(loader.state.samples.length, 4);
});

test('a node without latency detail ignores live samples', async () => {
  const loader = createLatencyHistoryLoader({ onChange() {}, request: async () => ({ data: { enabled: false, samples: [] } }) });
  await loader.load();
  assert.equal(loader.addLive([{ p: 0, t: Date.now(), r: 1, k }]), false);
  assert.equal(loader.state.samples.length, 0);
});
