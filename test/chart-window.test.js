import test from 'node:test';
import assert from 'node:assert/strict';
import { trimToWindow, mergeCachedPoints, timeTickStep, alignedTicks } from '../src/frontend/utils/chartWindow.js';

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

test('mergeCachedPoints prefers cached 2s points inside their span and keeps history outside', () => {
  const history = [p(0, 'h'), p(60, 'h'), p(120, 'h'), p(180, 'h')];
  const cached = [p(50, 'c'), p(52, 'c'), p(54, 'c'), p(130, 'c')];
  const merged = mergeCachedPoints(history, cached);
  assert.deepEqual(merged.map(d => `${d.x}${d.y}`), ['0h', '50c', '52c', '54c', '130c', '180h']);
  assert.equal(mergeCachedPoints(history, []), history);
  assert.deepEqual(mergeCachedPoints(undefined, [p(1)]).map(d => d.x), [1]);
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
