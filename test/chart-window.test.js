import test from 'node:test';
import assert from 'node:assert/strict';
import { trimToWindow, timeTickStep, alignedTicks } from '../src/frontend/utils/chartWindow.js';

const p = (x, y = x) => ({ x, y });

test('trimToWindow keeps the window plus one point before it', () => {
  const data = [p(10), p(20), p(30), p(40)];
  assert.deepEqual(trimToWindow(data, 25).map(d => d.x), [20, 30, 40], 'line enters from the left edge');
  assert.deepEqual(trimToWindow(data, 5).map(d => d.x), [10, 20, 30, 40]);
  assert.deepEqual(trimToWindow(data, 50).map(d => d.x), [40], 'all older: keep the newest');
  assert.deepEqual(trimToWindow(undefined, 1), []);
  // history rows carry their time as x too
  assert.deepEqual(trimToWindow([{ x: 1, cpu: 1 }, { x: 9, cpu: 2 }], 5).map(r => r.cpu), [1, 2]);
});

test('timeTickStep picks whole-minute/hour steps within the tick budget', () => {
  const m = 60000, h = 3600000;
  assert.equal(timeTickStep(10 / 60, 6), 2 * m);
  assert.equal(timeTickStep(10 / 60, 12), m);
  assert.equal(timeTickStep(0.5, 6), 10 * m);
  assert.equal(timeTickStep(1, 8), 10 * m);
  assert.equal(timeTickStep(24, 8), 6 * h);
  assert.equal(timeTickStep(24, 9), 3 * h);
  assert.equal(timeTickStep(168, 6), 24 * h);
});

test('alignedTicks lands on whole steps inside the window', () => {
  const m = 60000, min = 1800000024000, max = min + 601200;
  const ticks = alignedTicks(min, max, 2 * m).map(t => t.value);
  assert.ok(ticks.length === 5 && ticks.every(v => v % (2 * m) === 0 && v >= min && v <= max));
  assert.deepEqual(alignedTicks(5, 1, 1), []);
});

test('aggregateLiveRow aggregates the in-progress minute like stored history rows', async () => {
  const { aggregateLiveRow } = await import('../src/frontend/utils/chartWindow.js');
  const row = aggregateLiveRow([
    { ts: 3000, data: { cpu: 3, net_in_speed: 100, processes: 90, disk: { read_bps: 5, util: 1 }, load_avg: '0.1 0 0', disk_used: 1 } },
    { ts: 1000, data: { cpu: 1, net_in_speed: 900, processes: 89, disk: { read_bps: 50, util: 0 } } },
    { ts: 5000, data: { cpu: 5, net_in_speed: 300, disk_used: 2 } }
  ]);
  assert.equal(row.cpu, 3, 'CPU is averaged');
  assert.equal(row.net_in_speed, 900, 'rates keep the peak');
  assert.equal(row.processes, 90);
  assert.deepEqual(row.disk, { read_bps: 50, util: 1 });
  assert.equal(row.load_avg, '0.1 0 0', 'other fields: latest value present');
  assert.equal(row.disk_used, 2);
  assert.equal(row.timestamp, 5000);
  assert.equal(aggregateLiveRow([]), null);
});
