// Pure helpers for the Fly Ask NDJSON stream. No DOM access.
export const STAGES = ['interpret', 'research', 'pool', 'jev', 'adapter'];

export function newState() {
  const stages = {};
  for (const s of STAGES) stages[s] = { status: 'pending', ms: null, data: null, error: null };
  return { stages, final: null, error: null, malformed: 0, done: false };
}

function parseLine(line, onEvent) {
  const t = line.trim();
  if (!t) return;
  try {
    onEvent(JSON.parse(t));
  } catch (err) {
    onEvent({ stage: 'malformed', status: 'error', raw: t.slice(0, 200), error: { message: String(err.message || err) } });
  }
}

async function* chunksOf(stream) {
  if (stream && typeof stream.getReader === 'function') {
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        yield value;
      }
    } finally {
      try { reader.releaseLock(); } catch (_) { /* ignore */ }
    }
  } else {
    yield* stream;
  }
}

// Reads NDJSON from a ReadableStream (or async iterable of Uint8Array/string).
// Malformed lines are reported as {stage:'malformed'} events, never thrown.
export async function parseNdjsonStream(stream, onEvent) {
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  for await (const chunk of chunksOf(stream)) {
    buf += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      parseLine(buf.slice(0, i), onEvent);
      buf = buf.slice(i + 1);
    }
  }
  buf += decoder.decode();
  parseLine(buf, onEvent);
}

// Reducer: returns a new state, never mutates the old one.
export function applyEvent(state, event) {
  if (!event || typeof event !== 'object') return state;
  const next = { ...state, stages: { ...state.stages } };
  if (event.stage === 'malformed') {
    next.malformed = state.malformed + 1;
    return next;
  }
  if (event.stage === 'final') {
    next.done = true;
    if (event.status === 'error') {
      next.error = event.error || { code: 'unknown', message: 'Unknown error' };
    } else {
      next.final = event.data || null;
    }
    return next;
  }
  if (STAGES.includes(event.stage)) {
    const prev = state.stages[event.stage];
    const status = event.status === 'start' ? 'running' : event.status === 'done' ? 'done' : event.status === 'error' ? 'error' : prev.status;
    next.stages[event.stage] = {
      status,
      ms: typeof event.ms === 'number' ? event.ms : prev.ms,
      data: event.data !== undefined ? event.data : prev.data,
      error: event.status === 'error' ? (event.error || { message: 'Stage failed' }) : prev.error,
    };
  }
  return next;
}
