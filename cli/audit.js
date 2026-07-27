import { runBenchmark } from './run.js';

const PROFILES = new Set(['smoke', 'extreme']);
const OBSERVER_DRIVERS = new Set(['changeStreams', 'oplog']);

export function buildAuditRunValues(values) {
  const profile = values.profile || 'smoke';
  const observerDriver = values['observer-driver'] || 'changeStreams';
  if (!PROFILES.has(profile)) {
    throw new Error(`Unknown audit profile "${profile}". Expected smoke or extreme.`);
  }
  if (!OBSERVER_DRIVERS.has(observerDriver)) {
    throw new Error(`Unknown observer driver "${observerDriver}". Expected changeStreams or oplog.`);
  }

  const scriptArgs = [
    '--observer-driver', observerDriver,
    ...(values.seed ? ['--seed', values.seed] : []),
    ...(values['allow-remote-mongo'] ? ['--allow-remote-mongo'] : []),
  ];
  const env = [
    ...(Array.isArray(values.env) ? values.env : values.env ? [values.env] : []),
    `METEOR_REACTIVITY_ORDER=${observerDriver}`,
  ];

  return {
    ...values,
    scenario: `change-stream-audit-${profile}`,
    env,
    scriptArgs,
  };
}

export async function runAudit({ values, config }) {
  return runBenchmark({ values: buildAuditRunValues(values), config });
}
