// Plain-object I/O facade for the runner / cli / drivers modules.
//
// Why a plain object instead of `export { X } from 'node:Y'`: ESM
// namespace exports — both the source node:* namespaces and any
// re-exports of them — are non-configurable, so mock.method against
// them throws "Cannot redefine property". A plain object whose values
// happen to BE the node:* functions is fully configurable, which lets
// tests stub at this module boundary without polluting global state or
// adding DI parameters to production signatures.
//
// Production: import { io } from './_io.js';  (or '../runner/_io.js' from cli/, drivers/)
//   io.execSync(...), io.spawn(...), io.existsSync(...), await io.sleep(1000), await io.fetch(url)
// Tests:      mock.method(io, 'execSync', () => 'fake-stdout');
//
// Per the approved exception in REFACTOR_SPEC.md hard-constraint #4, this is
// the single io facade for the whole codebase — extend it (don't fork it)
// when a new subsystem needs a mock seam. SimpleDDP and ws live here for the
// same reason: cli/push.js's new SimpleDDP(...) needs a mockable factory
// and a separate facade would just be ceremony.

import { execSync as _execSync, execFileSync as _execFileSync, spawn as _spawn } from 'node:child_process';
import { existsSync as _existsSync, readFileSync as _readFileSync, unlinkSync as _unlinkSync, mkdirSync as _mkdirSync, readdirSync as _readdirSync, writeFileSync as _writeFileSync, statSync as _statSync, rmSync as _rmSync } from 'node:fs';
import { setTimeout as _sleep } from 'node:timers/promises';
import _SimpleDDP from 'simpleddp';
import _ws from 'ws';

export const io = {
  execSync: _execSync,
  execFileSync: _execFileSync,
  spawn: _spawn,
  existsSync: _existsSync,
  readFileSync: _readFileSync,
  unlinkSync: _unlinkSync,
  mkdirSync: _mkdirSync,
  readdirSync: _readdirSync,
  writeFileSync: _writeFileSync,
  statSync: _statSync,
  rmSync: _rmSync,
  sleep: _sleep,
  // Wrapper (not a bound reference) so tests can replace globalThis.fetch
  // without re-loading this module. mock.method(io, 'fetch', ...) also works.
  fetch: (...args) => globalThis.fetch(...args),
  SimpleDDP: _SimpleDDP,
  ws: _ws,
};
