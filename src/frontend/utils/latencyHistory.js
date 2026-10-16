import { mergeLatencySamples } from './latencyDetail.js';

const MINUTE = 60000;
const DAY = 1440 * MINUTE;

// Per-component memory only. Never persist potentially private history in browser storage.
export function createLatencyHistoryLoader({ request, onChange, onPage = async () => {}, now = Date.now, paused = () => false }) {
  let state = { enabled: null, samples: [], loadedFrom: null, asOf: 0, nextBefore: 0, complete: false, busy: false, error: '' };
  let disposed = false;
  const stopped = () => disposed || paused();
  const publish = patch => { state = { ...state, ...patch }; if (!disposed) onChange(state); };

  async function read(query) {
    const result = await request(query);
    if (stopped()) return null;
    if (result.error) {
      if ([401, 403, 404].includes(result.status)) {
        publish({ enabled: null, samples: [], loadedFrom: null, asOf: 0, nextBefore: 0, complete: false });
      }
      throw new Error(result.message || result.error);
    }
    const data = result.data;
    if (typeof data?.enabled !== 'boolean') throw new Error('Invalid history response');
    if (!data.enabled) {
      publish({ enabled: false, samples: [], loadedFrom: null, asOf: 0, nextBefore: 0, complete: false });
      return null;
    }
    if (!Array.isArray(data.samples) || ![data.range_from, data.range_to, data.as_of].every(Number.isSafeInteger)
      || data.range_from >= data.range_to || data.range_to - data.range_from > 180 * MINUTE
      || data.range_to > data.as_of || data.range_from < data.as_of - DAY
      || data.next_before !== data.range_from || typeof data.has_previous !== 'boolean') {
      throw new Error('Invalid history pagination; deploy the matching Worker');
    }
    return data;
  }

  async function accept(data, patch) {
    publish({ enabled: true, samples: mergeLatencySamples(state.samples, data.samples, now()), ...patch });
    // Render and yield after every page, including the first one, before starting another request.
    await onPage();
  }

  async function load() {
    if (state.busy || stopped()) return;
    publish({ busy: true, error: '' });
    try {
      // After a long hidden-tab pause, prioritize fresh measurements again.
      if (state.asOf && now() - state.asOf > 150 * MINUTE) {
        publish({ loadedFrom: null, nextBefore: 0, complete: false, asOf: 0 });
      }
      if (!state.asOf) {
        const data = await read({ before: 0 });
        if (!data) return;
        await accept(data, { loadedFrom: data.range_from, asOf: data.as_of, nextBefore: data.next_before, complete: !data.has_previous });
      } else if (state.complete) {
        // Normal polling still reads only the 31-minute late-upload window.
        let after = Math.max(0, state.asOf - 31 * MINUTE);
        for (let page = 0; page < 9; page++) {
          const data = await read({ after });
          if (!data) return;
          if (!Number.isSafeInteger(data.next_after) || data.next_after <= after) throw new Error('History cursor did not advance');
          await accept(data, { asOf: data.as_of, loadedFrom: Math.max(state.loadedFrom, data.as_of - DAY) });
          if (!data.has_more) return;
          if (stopped()) return;
          after = data.next_after;
        }
        throw new Error('History pagination limit exceeded');
      }
      // Save the cursor after each success. An error or hidden tab resumes here, never at page one.
      for (let page = 0; !state.complete && page < 8 && !stopped(); page++) {
        const before = state.nextBefore;
        const data = await read({ before });
        if (!data) return;
        if (data.range_to !== before || data.next_before >= before) throw new Error('History cursor did not advance');
        await accept(data, { loadedFrom: data.range_from, nextBefore: data.next_before, complete: !data.has_previous });
      }
      if (!state.complete && !stopped()) throw new Error('History pagination limit exceeded');
    } catch (error) {
      if (!disposed) publish({ error: error.message });
    } finally {
      if (!disposed) publish({ busy: false });
    }
  }

  return { load, get state() { return state; }, dispose() { disposed = true; } };
}
