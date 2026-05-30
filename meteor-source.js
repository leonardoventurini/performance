/**
 * Meteor source resolution.
 *
 * Single source of truth for "which Meteor do we run?". Replaces the
 * duplicated git-shelling that used to live in both bench.js and
 * reporters/json-reporter.js.
 *
 * Resolution precedence (per input): flag > env > config.
 * Modes:
 *   - checkout: a local meteor checkout (with git history).
 *   - system:   no checkout configured; falls back to `meteor` on PATH.
 *
 * Release mode (--meteor-version / METEOR_RELEASE / config.meteorVersion)
 * is added in commit 8; the function signature already accepts those
 * inputs so commit 8 only extends the resolution rule.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function pickCheckoutPath({ flags, env, config }) {
  return flags['meteor-checkout']
      ?? env.METEOR_CHECKOUT_PATH
      ?? config.meteorCheckoutPath
      ?? null;
}

export function resolveMeteorSource({ flags = {}, env = {}, config = {} } = {}) {
  const checkoutPath = pickCheckoutPath({ flags, env, config });
  const hasBinary = checkoutPath && fs.existsSync(path.join(checkoutPath, 'meteor'));

  if (hasBinary) {
    const source = {
      mode: 'checkout',
      meteorCmd: path.join(checkoutPath, 'meteor'),
      releaseArg: null,
      checkoutPath,
      version: 'unknown',
      sha: 'unknown',
    };
    const info = getMeteorInfo(source);
    source.version = info.version;
    source.sha = info.sha;
    return source;
  }

  return {
    mode: 'system',
    meteorCmd: 'meteor',
    releaseArg: null,
    checkoutPath: null,
    version: 'system',
    sha: 'unknown',
  };
}

export function getMeteorInfo(source) {
  if (source.mode !== 'checkout') {
    return { version: source.version, sha: source.sha };
  }
  const cwd = source.checkoutPath;
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
    const version = execFileSync('git', ['describe', '--tags', '--always'], { cwd, encoding: 'utf8' }).trim();
    return { version, sha };
  } catch (err) {
    throw new Error(
      `Could not read Meteor git info at ${cwd}: ${err.message}. Is this a git checkout?`
    );
  }
}
