import test from 'node:test';
import assert from 'node:assert/strict';
import { createLatencyHistoryLoader } from '../src/frontend/utils/latencyHistory.js';
import { latencyChartSeries, latencySeries } from '../src/frontend/utils/latencyDetail.js';

const MINUTE = 60000, DAY = 1440 * MINUTE, PAGE = 180 * MINUTE;
const key = '0123456789abcdef';
const startTime = Math.floor(1800000000000 / MINUTE) * MINUTE;
const sample = t => ({ t, p: 0, r: 42, k: key });

function response(query, now = startTime, samples) {
  const asOf = Math.floor(now / MINUTE) * MINUTE;
  const earliest = asOf - DAY;
  const backwards = Object.hasOwn(query, 'before');
  const to = backwards ? (query.before || asOf) : Math.min(asOf, Math.max(earliest, query.after) + PAGE);
  const from = backwards ? Math.max(earliest, to - PAGE) : Math.max(earliest, query.after);
  return { data: { enabled: true, as_of: asOf, range_from: from, range_to: to,
    next_before: from, has_previous: from > earliest, next_after: to, has_more: to < asOf,
    samples: samples ?? [sample(to - 20000)] } };
}

test('newest page is published before older pages finish; failure preserves points and retry resumes', async () => {
  const queries = [], rendered = [];
  let fail = true, releaseSecond, reachedSecond;
  const secondRequested = new Promise(resolve => { reachedSecond = resolve; });
  const loader = createLatencyHistoryLoader({ now: () => startTime, onChange() {},
    onPage: async () => { rendered.push(loader.state.samples.length); },
    request: async query => {
      queries.push(query);
      if (queries.length === 2) { reachedSecond(); await new Promise(resolve => { releaseSecond = resolve; }); }
      if (queries.length === 3 && fail) { fail = false; return { error: 'timeout' }; }
      return response(query);
    }
  });
  const firstLoad = loader.load();
  await secondRequested;
  assert.deepEqual(queries[0], { before: 0 });
  assert.deepEqual(rendered, [1]);
  assert.equal(loader.state.samples[0].t, startTime - 20000);
  assert.equal(loader.state.complete, false);
  assert.equal(loader.state.loadedFrom, startTime - PAGE);
  releaseSecond();
  await firstLoad;
  assert.equal(loader.state.error, 'timeout');
  assert.equal(loader.state.samples.length, 2);
  assert.equal(loader.state.loadedFrom, startTime - 2 * PAGE);
  await loader.load();
  assert.deepEqual(queries[3], queries[2]);
  assert.equal(queries.filter(q => q.before === 0).length, 1);
  assert.equal(queries.length, 9); // eight successful pages plus the one failed attempt
  assert.equal(loader.state.complete, true);
  assert.equal(loader.state.loadedFrom, startTime - DAY);
  assert.equal(loader.state.samples.length, 8);
  assert.equal(loader.state.error, '');
});

test('empty pages still advance coverage; hidden tabs pause and resume without starting over', async () => {
  let hidden = false;
  const queries = [];
  const loader = createLatencyHistoryLoader({ now: () => startTime, paused: () => hidden, onChange() {},
    onPage: async () => { if (queries.length === 1) hidden = true; },
    request: async query => { queries.push(query); return response(query, startTime, []); }
  });
  await loader.load();
  await loader.load();
  assert.equal(queries.length, 1);
  assert.equal(loader.state.loadedFrom, startTime - PAGE);
  assert.equal(loader.state.complete, false);
  hidden = false;
  await loader.load();
  assert.equal(queries.length, 8);
  assert.equal(loader.state.complete, true);
  assert.equal(loader.state.samples.length, 0);
});

test('automatic refresh reads the 31-minute retry window and includes delayed uploads', async () => {
  let clock = startTime;
  const queries = [];
  const late = { ...sample(startTime - 25 * MINUTE), r: 1234 };
  const loader = createLatencyHistoryLoader({ now: () => clock, onChange() {}, request: async query => {
    queries.push(query);
    return response(query, clock, Object.hasOwn(query, 'after') ? [late, sample(clock - 1000)] : undefined);
  } });
  await loader.load();
  clock += MINUTE;
  await loader.load();
  assert.equal(queries.length, 9);
  assert.deepEqual(queries.at(-1), { after: startTime - 31 * MINUTE });
  assert.ok(loader.state.samples.some(s => s.r === 1234));
  assert.equal(loader.state.samples.at(-1).t, clock - 1000);
  assert.equal(loader.state.complete, true);
  assert.equal(loader.state.loadedFrom, clock - DAY);
});

test('a long inactive period prioritizes current measurements again', async () => {
  let clock = startTime;
  const queries = [];
  const loader = createLatencyHistoryLoader({ now: () => clock, onChange() {}, request: async query => {
    queries.push(query); return response(query, clock);
  } });
  await loader.load();
  clock += 4 * 60 * MINUTE;
  await loader.load();
  assert.deepEqual(queries[8], { before: 0 });
  assert.equal(loader.state.samples.at(-1).t, clock - 20000);
  assert.equal(loader.state.complete, true);
});

test('authentication revocation clears cached samples; dispose ignores an in-flight reply', async () => {
  let allowed = true;
  const loader = createLatencyHistoryLoader({ now: () => startTime, onChange() {}, request: async query =>
    allowed ? response(query) : { error: 'Unauthorized', status: 401 } });
  await loader.load();
  allowed = false;
  await loader.load();
  assert.deepEqual(loader.state.samples, []);
  assert.equal(loader.state.enabled, null);
  assert.equal(loader.state.complete, false);
  let release, changes = 0;
  const disposed = createLatencyHistoryLoader({ onChange() { changes++; }, request: () => new Promise(resolve => { release = resolve; }) });
  const pending = disposed.load();
  disposed.dispose();
  release(response({ before: 0 }));
  await pending;
  assert.equal(changes, 1); // busy state only, before dispose
  assert.deepEqual(disposed.state.samples, []);
});

test('malformed or non-advancing pagination cannot loop or erase loaded measurements', async () => {
  let calls = 0;
  const loader = createLatencyHistoryLoader({ now: () => startTime, onChange() {}, request: async query => {
    calls++;
    const result = response(query);
    if (calls > 1) result.data.range_to--;
    return result;
  } });
  await loader.load();
  assert.equal(calls, 2);
  assert.match(loader.state.error, /cursor/);
  assert.equal(loader.state.samples.length, 1);
  assert.equal(loader.state.complete, false);
});

test('short chart ranges retain failure-rate context, spikes, nulls and target boundaries', () => {
  const rows = [];
  for (let n = 0; n < 4320; n++) rows.push({ ...sample(startTime - DAY + n * 20000), r: n % 13 === 0 ? null : n === 4300 ? 1200 : 42 });
  const start = startTime - 10 * MINUTE;
  const chart = latencyChartSeries(rows, start, startTime).get(0);
  const full = latencySeries(rows, 0);
  assert.ok(chart.ping.some(p => p.y === 1200));
  assert.ok(chart.ping.some(p => p.y === null));
  assert.deepEqual(chart.loss.filter(p => p.x >= start), full.loss.filter(p => p.x >= start));
  assert.ok(chart.ping.length <= 32); // not all 4320 points for a 10-minute view
  const gapRows = [sample(start - 20000), { ...sample(start + 60000), k: 'ffffffffffffffff' }];
  assert.ok(latencyChartSeries(gapRows, start, startTime).get(0).ping.some(p => p.y === null));
});
