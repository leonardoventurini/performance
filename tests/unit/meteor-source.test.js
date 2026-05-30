// Covers resolveMeteorSource and getMeteorInfo for checkout and system modes.
// Release mode (--meteor-version / METEOR_RELEASE / config.meteorVersion +
// mutual-exclusion) lands in commit 8.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { resolveMeteorSource, getMeteorInfo } from '../../meteor-source.js';

let tmpRoot;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'meteor-source-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// Build a directory that looks like a Meteor checkout: a `meteor` file at the
// root. Does NOT make it a git repo — pass { git: true } for that.
function makeFakeCheckout({ git = false } = {}) {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'checkout-'));
  fs.writeFileSync(path.join(dir, 'meteor'), '#!/usr/bin/env bash\n');
  if (git) {
    execSync('git init -q', { cwd: dir });
    execSync('git -c user.email=t@t -c user.name=t commit --allow-empty -q -m init', { cwd: dir });
  }
  return dir;
}

// Directory with no `meteor` binary, so the "checkout binary missing" branch
// is taken and resolution falls through to system mode.
function makeEmptyDir() {
  return fs.mkdtempSync(path.join(tmpRoot, 'empty-'));
}

describe('resolveMeteorSource — checkout mode', () => {
  test('flags["meteor-checkout"] with existing meteor binary → checkout mode', () => {
    const dir = makeFakeCheckout({ git: true });
    const src = resolveMeteorSource({
      flags: { 'meteor-checkout': dir },
      env: {},
      config: {},
    });
    assert.equal(src.mode, 'checkout');
    assert.equal(src.meteorCmd, path.join(dir, 'meteor'));
    assert.equal(src.releaseArg, null);
    assert.equal(src.checkoutPath, dir);
    assert.ok(typeof src.version === 'string' && src.version.length > 0);
    assert.ok(typeof src.sha === 'string' && src.sha.length > 0);
  });

  test('env.METEOR_CHECKOUT_PATH (no flag) → checkout mode', () => {
    const dir = makeFakeCheckout({ git: true });
    const src = resolveMeteorSource({
      flags: {},
      env: { METEOR_CHECKOUT_PATH: dir },
      config: {},
    });
    assert.equal(src.mode, 'checkout');
    assert.equal(src.checkoutPath, dir);
  });

  test('config.meteorCheckoutPath (no flag, no env) → checkout mode', () => {
    const dir = makeFakeCheckout({ git: true });
    const src = resolveMeteorSource({
      flags: {},
      env: {},
      config: { meteorCheckoutPath: dir },
    });
    assert.equal(src.mode, 'checkout');
    assert.equal(src.checkoutPath, dir);
  });

  test('precedence: flag wins over env wins over config', () => {
    const flagDir = makeFakeCheckout({ git: true });
    const envDir = makeFakeCheckout({ git: true });
    const configDir = makeFakeCheckout({ git: true });
    const src = resolveMeteorSource({
      flags: { 'meteor-checkout': flagDir },
      env: { METEOR_CHECKOUT_PATH: envDir },
      config: { meteorCheckoutPath: configDir },
    });
    assert.equal(src.checkoutPath, flagDir);

    const srcEnvBeatsConfig = resolveMeteorSource({
      flags: {},
      env: { METEOR_CHECKOUT_PATH: envDir },
      config: { meteorCheckoutPath: configDir },
    });
    assert.equal(srcEnvBeatsConfig.checkoutPath, envDir);
  });
});

describe('resolveMeteorSource — system mode', () => {
  test('no flag, no env, no config → system mode', () => {
    const src = resolveMeteorSource({ flags: {}, env: {}, config: {} });
    assert.equal(src.mode, 'system');
    assert.equal(src.meteorCmd, 'meteor');
    assert.equal(src.releaseArg, null);
    assert.equal(src.version, 'system');
    assert.equal(src.sha, 'unknown');
    assert.equal(src.checkoutPath, null);
  });

  test('checkout path provided but `meteor` binary missing → falls through to system', () => {
    const empty = makeEmptyDir();
    const src = resolveMeteorSource({
      flags: { 'meteor-checkout': empty },
      env: {},
      config: {},
    });
    assert.equal(src.mode, 'system');
    assert.equal(src.version, 'system');
    assert.equal(src.sha, 'unknown');
  });

  test('env-provided checkout path with no binary → system', () => {
    const empty = makeEmptyDir();
    const src = resolveMeteorSource({
      flags: {},
      env: { METEOR_CHECKOUT_PATH: empty },
      config: {},
    });
    assert.equal(src.mode, 'system');
  });
});

describe('getMeteorInfo', () => {
  test('returns non-empty {version, sha} for a real git checkout', () => {
    const dir = makeFakeCheckout({ git: true });
    const info = getMeteorInfo({ mode: 'checkout', checkoutPath: dir });
    assert.ok(typeof info.version === 'string' && info.version.length > 0, 'version is a non-empty string');
    assert.ok(typeof info.sha === 'string' && info.sha.length > 0, 'sha is a non-empty string');
    // short-sha is typically 7 chars, but git can use 4+ — just assert no whitespace.
    assert.doesNotMatch(info.sha, /\s/);
    assert.doesNotMatch(info.version, /\s/);
  });

  test('throws (no silent "unknown") when checkout path is not a git repo', () => {
    const dir = makeFakeCheckout({ git: false });
    assert.throws(
      () => getMeteorInfo({ mode: 'checkout', checkoutPath: dir }),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes(dir), `error message should mention the checkout path; got: ${err.message}`);
        return true;
      }
    );
  });
});

// TODO(commit 8): add release-mode cases.
//   - flags['meteor-version'] set → { mode: 'release', meteorCmd: 'meteor',
//     releaseArg: '--release=<version>', version: <version>, sha: 'release:<version>' }
//   - env.METEOR_RELEASE set (no flag) → release mode
//   - config.meteorVersion set (no flag, no env) → release mode
//   - precedence flag > env > config for release mode (parallel to checkout)
//   - both --meteor-version and --meteor-checkout set → throws
//     "--meteor-version and --meteor-checkout are mutually exclusive; got
//     version=X and checkout=Y. Pick one." (both values in the message)
//   - getMeteorInfo not called for release mode (resolveMeteorSource pre-fills
//     version and sha)
