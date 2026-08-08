// Parses `[runtime-info] key=value` lines out of a byte stream and
// accumulates the key/value pairs.
//
// Used by runner/meteor-process.js to capture the runtime dimensions
// (observer_driver, transport) that apps/tasks-3.x/server/main.js prints
// on startup. Pure: no I/O, no async, no globals.
//
// Buffers partial chunks so a line straddling two `data` events still
// parses. Later values for the same key win (every Meteor restart in a
// loop re-emits the same lines).

const LINE_RE = /^\[runtime-info\] (\w+)=(.+)$/;

export interface RuntimeInfoExtractor { feed(chunk: Uint8Array | string): void; get(): Record<string, string> }

export function createRuntimeInfoExtractor(): RuntimeInfoExtractor {
  let buffer = '';
  const captured: Record<string, string> = {};

  return {
    feed(chunk: Uint8Array | string): void {
      buffer += chunk.toString();
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const m = LINE_RE.exec(line);
        const key = m?.[1];
        const value = m?.[2];
        if (key !== undefined && value !== undefined) captured[key] = value;
      }
    },
    get: () => ({ ...captured }),
  };
}
