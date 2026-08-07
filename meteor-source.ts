/**
 * Meteor source resolution.
 *
 * Single source of truth for "which Meteor do we run?". Replaces the
 * duplicated git-shelling that used to live in both bench.js and
 * reporters/json-reporter.js.
 *
 * Resolution precedence (per input): flag > env > config.
 * Modes:
 *   - release:  pinned Meteor release (no local checkout needed).
 *   - checkout: a local meteor checkout (with git history).
 *   - system:   no version or checkout configured; falls back to `meteor` on PATH.
 *
 * Release-vs-checkout is mutually exclusive: pinning a release with a
 * local checkout is meaningless (the checkout's release is whatever its
 * tooling/_finished-upgraders says it is). The function throws rather
 * than silently picking a winner so misconfigured runs fail loud.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { BenchmarkConfig, CliValues, Environment, MeteorSource } from './lib/benchmark-types.js';
import { errorMessage } from './lib/benchmark-types.js';

interface SourceInputs {
  readonly flags?: CliValues;
  readonly env?: Environment;
  readonly config?: Partial<BenchmarkConfig>;
}

function pickVersion({ flags = {}, env = {}, config = {} }: SourceInputs): string | null {
  const flag = flags['meteor-version'];
  if (typeof flag === 'string') return flag;
  return env.METEOR_RELEASE
      ?? config.meteorVersion
      ?? null;
}

function pickCheckoutPath({ flags = {}, env = {}, config = {} }: SourceInputs): string | null {
  const flag = flags['meteor-checkout'];
  if (typeof flag === 'string') return flag;
  return env.METEOR_CHECKOUT_PATH
      ?? config.meteorCheckoutPath
      ?? null;
}

export function resolveMeteorSource(inputs: SourceInputs = {}): MeteorSource {
  const { flags = {}, env = {}, config = {} } = inputs;
  const version = pickVersion({ flags, env, config });
  const checkoutPath = pickCheckoutPath({ flags, env, config });
  const hasBinary = checkoutPath !== null && fs.existsSync(path.join(checkoutPath, 'meteor'));

  // Mutual exclusion only fires when both inputs would actually be USED — a stale
  // config.meteorCheckoutPath pointing at a non-existent path shouldn't block
  // --meteor-version. Same shape as the checkout-mode "binary missing → fall
  // through to system" handling.
  if (version && hasBinary) {
    throw new Error(
      `--meteor-version and --meteor-checkout are mutually exclusive; ` +
      `got version=${version} and checkout=${checkoutPath}. Pick one.`
    );
  }

  if (version) {
    return {
      mode: 'release',
      meteorCmd: 'meteor',
      releaseArg: `--release=${version}`,
      checkoutPath: null,
      version,
      sha: `release:${version}`,
    };
  }

  if (hasBinary) {
    const unresolvedSource: MeteorSource = {
      mode: 'checkout',
      meteorCmd: path.join(checkoutPath, 'meteor'),
      releaseArg: null,
      checkoutPath,
      version: 'unknown',
      sha: 'unknown',
    };
    const info = getMeteorInfo(unresolvedSource);
    return { ...unresolvedSource, ...info };
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

export function getMeteorInfo(source: MeteorSource): Readonly<{ version: string; sha: string }> {
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
      `Could not read Meteor git info at ${cwd}: ${errorMessage(err)}. Is this a git checkout?`
    );
  }
}
