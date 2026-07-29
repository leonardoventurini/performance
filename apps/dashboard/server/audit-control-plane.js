import { Meteor } from 'meteor/meteor';
import { Random } from 'meteor/random';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import {
  ACTIVE_AUDIT_STATUSES,
  buildAuditArgv,
  validateAuditLaunchRequest,
} from '../imports/api/audit-contract';
import {
  AuditEvents,
  AuditExecutions,
} from '../imports/api/audit-executions';
import {
  insertRunResult,
} from '../imports/api/runs';
import {
  normalizeAuditRunResult,
} from '../imports/api/run-contract';

/** One global lease prevents two audits from resetting the same fixture. */
const ACTIVE_LEASE = 'dashboard-audit';
/** Maximum persisted output events per execution. */
const MAX_EVENT_COUNT = 500;
/** Maximum characters retained from one process-output line. */
const MAX_EVENT_MESSAGE_LENGTH = 1_000;
/** Maximum bytes accepted from one result artifact. */
const MAX_RESULT_BYTES = 5 * 1024 * 1024;
/** Maximum audit runtime before the process group is terminated. */
const MAX_AUDIT_RUNTIME_MS = 8 * 60 * 1000;
/** Grace period between TERM and KILL during cancellation. */
const CANCEL_GRACE_MS = 5_000;
/** Retain process events for seven days. */
const EVENT_RETENTION_SECONDS = 7 * 24 * 60 * 60;
/** Minimum supported Node major for the root harness. */
const MINIMUM_NODE_MAJOR = 24;
/** Published release used by the current audit fixture. */
const DEFAULT_ALLOWED_METEOR_VERSION = '3.5.1-beta.0';

const ownedProcesses = new Map();
let shuttingDown = false;

/**
 * Returns a sanitized executor capability without disclosing server paths.
 *
 * @returns {{
 *   available: boolean,
 *   reasonCode: string|null,
 *   allowedMeteorVersions: ReadonlyArray<string>,
 *   oplogAvailable: boolean
 * }} Public capability.
 */
export function getAuditExecutorCapability() {
  const allowedMeteorVersions = getAllowedMeteorVersions();
  const oplogAvailable = Boolean(process.env.MONGO_OPLOG_URL);
  if (process.platform === 'win32') {
    return {
      available: false,
      reasonCode: 'process_groups_unsupported',
      allowedMeteorVersions,
      oplogAvailable,
    };
  }
  if (shuttingDown) {
    return {
      available: false,
      reasonCode: 'server_shutting_down',
      allowedMeteorVersions,
      oplogAvailable,
    };
  }

  try {
    resolveExecutorConfig();
    return {
      available: true,
      reasonCode: null,
      allowedMeteorVersions,
      oplogAvailable,
    };
  } catch (error) {
    return {
      available: false,
      reasonCode: error.code || 'executor_preflight_failed',
      allowedMeteorVersions,
      oplogAvailable,
    };
  }
}

/**
 * Resolves and verifies server-owned executor configuration.
 *
 * @returns {{
 *   repositoryRoot: string,
 *   outputRoot: string,
 *   nodeCommand: string
 * }} Verified configuration.
 */
export function resolveExecutorConfig() {
  const configuredRoot = process.env.BENCH_REPOSITORY_ROOT;
  if (!configuredRoot) {
    throw executorError(
      'repository_not_configured',
      'Set BENCH_REPOSITORY_ROOT on the dashboard server.',
    );
  }

  let repositoryRoot;
  try {
    repositoryRoot = fs.realpathSync(configuredRoot);
  } catch {
    throw executorError(
      'repository_unavailable',
      'The configured benchmark repository is unavailable.',
    );
  }

  const requiredPaths = [
    'bench.js',
    'bench.config.js',
    path.join('apps', 'tasks-3.x', '.meteor', 'release'),
  ];
  if (requiredPaths.some((relativePath) => (
    !fs.statSync(path.join(repositoryRoot, relativePath), { throwIfNoEntry: false })?.isFile()
  ))) {
    throw executorError(
      'repository_invalid',
      'The configured repository does not contain the audit runner and fixture.',
    );
  }

  const nodeCommand = process.env.BENCH_NODE_PATH || 'node';
  const nodeCheck = spawnSync(nodeCommand, ['--version'], {
    encoding: 'utf8',
    shell: false,
    timeout: 5_000,
  });
  const major = Number.parseInt(
    String(nodeCheck.stdout || '').trim().replace(/^v/, '').split('.')[0],
    10,
  );
  if (nodeCheck.status !== 0 || !Number.isInteger(major) || major < MINIMUM_NODE_MAJOR) {
    throw executorError(
      'node_incompatible',
      `The dashboard audit runner requires Node ${MINIMUM_NODE_MAJOR} or newer.`,
    );
  }

  const configuredOutputRoot = path.join(repositoryRoot, 'results', 'dashboard');
  fs.mkdirSync(configuredOutputRoot, { recursive: true, mode: 0o700 });
  const outputRoot = fs.realpathSync(configuredOutputRoot);
  assertPathContained(repositoryRoot, outputRoot);
  fs.accessSync(outputRoot, fs.constants.R_OK | fs.constants.W_OK);

  return { repositoryRoot, outputRoot, nodeCommand };
}

/**
 * Redacts sensitive and machine-specific data from one output line.
 *
 * @param {unknown} value Raw process output.
 * @param {string} repositoryRoot Verified repository root.
 * @returns {string} Bounded safe output.
 */
export function sanitizeAuditLogLine(value, repositoryRoot) {
  const escapedRoot = escapeRegExp(repositoryRoot);
  const homeRelativeRoot = process.env.HOME
    && repositoryRoot.startsWith(`${process.env.HOME}${path.sep}`)
    ? `~${repositoryRoot.slice(process.env.HOME.length)}`
    : null;
  return String(value)
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(new RegExp(escapedRoot, 'g'), '<repository>')
    .replace(
      homeRelativeRoot ? new RegExp(escapeRegExp(homeRelativeRoot), 'g') : /$^/,
      '<repository>',
    )
    .replace(/mongodb(?:\+srv)?:\/\/[^\s"'<>]+/gi, 'mongodb://<redacted>')
    .replace(/(BENCH_API_KEY\s*=\s*)[^\s]+/gi, '$1<redacted>')
    .slice(0, MAX_EVENT_MESSAGE_LENGTH);
}

/**
 * Creates a newline-aware output consumer that preserves partial chunks.
 *
 * @param {(line: string) => void} onLine Consumer.
 * @returns {{ push(chunk: Buffer|string): void, flush(): void }} Consumer API.
 */
export function createLineConsumer(onLine) {
  let buffered = '';
  return {
    push(chunk) {
      buffered += chunk.toString();
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? '';
      for (const line of lines) onLine(line);
    },
    flush() {
      if (buffered !== '') onLine(buffered);
      buffered = '';
    },
  };
}

/**
 * Starts the authenticated audit in the background and returns immediately.
 *
 * @param {unknown} rawRequest Untrusted method input.
 * @returns {Promise<string>} Execution identifier.
 */
async function createAuditExecution(rawRequest) {
  try {
    await auditControlPlaneReady;
  } catch {
    throw new Meteor.Error(
      'audit-state-unavailable',
      'The dashboard could not initialize durable audit state.',
    );
  }
  const validatedRequest = validateAuditLaunchRequest(rawRequest);
  const capability = getAuditExecutorCapability();
  if (!capability.available) {
    throw new Meteor.Error(
      'audit-unavailable',
      capabilityMessage(capability.reasonCode),
    );
  }
  if (
    validatedRequest.meteorVersion !== null
    && !capability.allowedMeteorVersions.includes(validatedRequest.meteorVersion)
  ) {
    throw new Meteor.Error(
      'audit-release-not-allowed',
      'Choose one of the server-configured Meteor releases.',
    );
  }
  const request = Object.freeze({
    ...validatedRequest,
    meteorVersion: validatedRequest.meteorVersion
      ?? capability.allowedMeteorVersions[0],
  });
  if (request.observerDriver === 'oplog' && !process.env.MONGO_OPLOG_URL) {
    throw new Meteor.Error(
      'audit-oplog-unavailable',
      'Oplog audits require MONGO_OPLOG_URL on the dashboard server.',
    );
  }

  const executionId = Random.id();
  const now = new Date();
  try {
    await AuditExecutions.insertAsync({
      _id: executionId,
      activeLease: ACTIVE_LEASE,
      status: 'queued',
      request,
      createdAt: now,
      updatedAt: now,
      eventCount: 0,
    });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw new Meteor.Error(
        'audit-already-running',
        'Another audit is already active. Wait for it to finish or cancel it.',
      );
    }
    throw error;
  }

  Meteor.defer(() => {
    executeAudit(executionId).catch((error) => {
      console.error('Dashboard audit executor failed:', error);
      failExecution(
        executionId,
        'executor_failed',
        'The audit executor failed before the runner completed.',
      ).catch(
        (failureError) => console.error(
          'Could not persist dashboard audit failure:',
          failureError,
        ),
      );
    });
  });
  return executionId;
}

/**
 * Launches one previously reserved execution.
 *
 * @param {string} executionId Durable execution identifier.
 */
async function executeAudit(executionId) {
  const execution = await AuditExecutions.findOneAsync(executionId);
  if (!execution) return;
  if (execution.status === 'cancelling') {
    await finishExecution(executionId, {
      status: 'cancelled',
      failureCode: 'cancelled_before_start',
      failureMessage: 'The audit was cancelled before the runner started.',
    });
    return;
  }
  if (execution.status !== 'queued') return;

  const config = resolveExecutorConfig();
  const outputPath = path.join(config.outputRoot, `${executionId}.json`);
  assertPathContained(config.outputRoot, outputPath);
  if (fs.existsSync(outputPath)) {
    throw executorError(
      'result_path_conflict',
      'The generated audit result path already exists.',
    );
  }
  const expectedTag = execution.request.tag ?? `dashboard:${executionId}`;
  const argv = buildAuditArgv(execution.request, { outputPath, executionId });
  const child = spawn(config.nodeCommand, argv, {
    cwd: config.repositoryRoot,
    detached: true,
    env: buildExecutorEnvironment(),
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const runtime = {
    child,
    executionId,
    outputPath,
    outputRoot: config.outputRoot,
    expectedTag,
    repositoryRoot: config.repositoryRoot,
    sequence: 0,
    eventQueue: Promise.resolve(),
    eventCount: 0,
    spawnError: null,
    timeout: null,
    killTimer: null,
    cancellationReason: null,
    settled: false,
  };
  ownedProcesses.set(executionId, runtime);

  const stdout = createLineConsumer((line) => queueAuditEvent(runtime, 'stdout', line));
  const stderr = createLineConsumer((line) => queueAuditEvent(runtime, 'stderr', line));
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  child.on('error', (error) => {
    runtime.spawnError = error;
    queueAuditEvent(runtime, 'system', `Runner failed to start: ${error.message}`);
  });
  child.on('spawn', () => {
    AuditExecutions.updateAsync(
      { _id: executionId, status: 'queued' },
      {
        $set: {
          status: 'running',
          startedAt: new Date(),
          updatedAt: new Date(),
          processId: child.pid,
        },
      },
    ).catch((error) => console.error('Could not mark audit running:', error));
  });
  child.on('close', (code, signal) => {
    stdout.flush();
    stderr.flush();
    settleAuditProcess(runtime, code, signal).catch((error) => {
      console.error('Dashboard audit finalization failed:', error);
      failExecution(
        executionId,
        'executor_finalization_failed',
        'The audit result could not be finalized safely.',
      )
        .catch((failureError) => console.error(
          'Could not finalize dashboard audit:',
          failureError,
        ));
    });
  });

  runtime.timeout = setTimeout(() => {
    requestProcessCancellation(runtime, 'runtime_limit_exceeded').catch(
      (error) => {
        console.error('Could not persist audit runtime cancellation:', error);
        queueAuditEvent(
          runtime,
          'system',
          'The runtime limit was reached; process termination is continuing while state persistence recovers.',
        );
      },
    );
  }, MAX_AUDIT_RUNTIME_MS);
}

/**
 * Finalizes one closed process and imports any correlated audit evidence.
 *
 * @param {object} runtime In-memory execution runtime.
 * @param {number|null} exitCode Child exit code.
 * @param {NodeJS.Signals|null} signal Closing signal.
 */
async function settleAuditProcess(runtime, exitCode, signal) {
  if (runtime.settled) return;
  runtime.settled = true;
  clearTimeout(runtime.timeout);
  clearTimeout(runtime.killTimer);
  await runtime.eventQueue;

  const execution = await AuditExecutions.findOneAsync(runtime.executionId);
  let result = null;
  let resultRunId = null;
  let evidenceError = null;
  try {
    result = readAuditResult(runtime.outputPath, {
      ...execution.request,
      expectedTag: runtime.expectedTag,
    }, runtime.outputRoot);
  } catch (error) {
    evidenceError = error;
  }

  ownedProcesses.delete(runtime.executionId);
  const cancellationRequested = execution?.status === 'cancelling'
    || runtime.cancellationReason !== null;
  if (cancellationRequested) {
    if (groupExists(runtime.child.pid)) {
      signalProcessGroup(runtime.child.pid, 'SIGKILL');
    }
    const timedOut = runtime.cancellationReason === 'runtime_limit_exceeded';
    await finishExecution(runtime.executionId, {
      status: timedOut ? 'failed' : 'cancelled',
      exitCode,
      exitSignal: signal,
      resultRunId,
      failureCode: runtime.cancellationReason || 'cancelled_by_operator',
      failureMessage: timedOut
        ? 'The audit exceeded the maximum dashboard runtime and was stopped.'
        : 'The audit was cancelled by an operator.',
    });
    return;
  }

  if (runtime.spawnError) {
    await finishExecution(runtime.executionId, {
      status: 'failed',
      exitCode,
      exitSignal: signal,
      failureCode: 'runner_spawn_failed',
      failureMessage: 'The audit runner could not be started.',
    });
    return;
  }
  if (evidenceError) {
    await finishExecution(runtime.executionId, {
      status: 'failed',
      exitCode,
      exitSignal: signal,
      failureCode: 'audit_evidence_invalid',
      failureMessage: evidenceError.message,
    });
    return;
  }

  resultRunId = await insertRunResult(result);
  const auditStatus = result.metrics.change_stream_audit.status;
  const passed = exitCode === 0 && auditStatus === 'passed';
  await finishExecution(runtime.executionId, {
    status: passed ? 'passed' : 'failed',
    exitCode,
    exitSignal: signal,
    resultRunId,
    auditStatus,
    failureCode: passed ? null : 'audit_not_conformant',
    failureMessage: passed
      ? null
      : `The audit produced ${auditStatus} evidence and exited with code ${exitCode}.`,
  });
}

/**
 * Reads and validates one exact execution artifact.
 *
 * @param {string} outputPath Server-generated artifact path.
 * @param {object} expected Correlation contract.
 * @param {string} [outputRoot] Server-controlled artifact root.
 * @returns {Record<string, unknown>} Validated canonical result.
 */
export function readAuditResult(
  outputPath,
  expected,
  outputRoot = path.dirname(outputPath),
) {
  const stats = fs.lstatSync(outputPath, { throwIfNoEntry: false });
  if (!stats?.isFile() || stats.isSymbolicLink()) {
    throw new Error('The audit runner did not produce a result artifact.');
  }
  const realOutputPath = fs.realpathSync(outputPath);
  assertPathContained(outputRoot, realOutputPath);
  if (stats.size > MAX_RESULT_BYTES) {
    throw new Error('The audit result exceeded the dashboard safety limit.');
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(realOutputPath, 'utf8'));
  } catch {
    throw new Error('The audit result is not valid JSON.');
  }
  return normalizeAuditRunResult(parsed, expected);
}

/**
 * Requests authenticated cancellation of one active execution.
 *
 * @param {string} executionId Execution identifier.
 * @returns {Promise<string>} Current lifecycle status.
 */
async function cancelAuditExecution(executionId) {
  if (typeof executionId !== 'string' || executionId.length > 40) {
    throw new Meteor.Error('audit-invalid-id', 'Audit execution ID is invalid.');
  }
  const execution = await AuditExecutions.findOneAsync(executionId);
  if (!execution) {
    throw new Meteor.Error('audit-not-found', 'Audit execution was not found.');
  }
  if (!ACTIVE_AUDIT_STATUSES.includes(execution.status)) {
    return execution.status;
  }

  await AuditExecutions.updateAsync(
    { _id: executionId, status: { $in: ACTIVE_AUDIT_STATUSES } },
    { $set: { status: 'cancelling', updatedAt: new Date() } },
  );
  const runtime = ownedProcesses.get(executionId);
  if (!runtime) {
    await finishExecution(executionId, {
      status: 'cancelled',
      failureCode: 'cancelled_before_start',
      failureMessage: 'The audit was cancelled before the runner started.',
    });
    return 'cancelled';
  }
  await requestProcessCancellation(runtime, 'cancelled_by_operator');
  return 'cancelling';
}

/**
 * Releases an interrupted lease only after its process group is proven gone.
 *
 * @param {string} executionId Execution identifier.
 * @returns {Promise<boolean>} Whether recovery was resolved.
 */
async function resolveInterruptedExecution(executionId) {
  if (typeof executionId !== 'string' || executionId.length > 40) {
    throw new Meteor.Error('audit-invalid-id', 'Audit execution ID is invalid.');
  }
  const execution = await AuditExecutions.findOneAsync(executionId);
  if (!execution || execution.status !== 'interrupted' || !execution.recoveryRequired) {
    throw new Meteor.Error(
      'audit-recovery-not-required',
      'This execution does not require interrupted-run recovery.',
    );
  }
  if (groupExists(execution.processId)) {
    throw new Meteor.Error(
      'audit-process-still-running',
      'The interrupted audit process group is still running. Stop it before releasing the audit lease.',
    );
  }
  await AuditExecutions.updateAsync(
    {
      _id: executionId,
      status: 'interrupted',
      recoveryRequired: true,
    },
    {
      $set: {
        recoveryRequired: false,
        recoveryResolvedAt: new Date(),
        updatedAt: new Date(),
      },
      $unset: {
        activeLease: '',
        processId: '',
      },
    },
  );
  return true;
}

/**
 * Signals a tracked process group and schedules forceful termination.
 *
 * @param {object} runtime In-memory execution runtime.
 * @param {string} reason Stable cancellation reason.
 */
async function requestProcessCancellation(runtime, reason) {
  if (runtime.killTimer) return;
  runtime.cancellationReason = reason;
  queueAuditEvent(runtime, 'system', `Stopping audit: ${reason}`);
  try {
    await AuditExecutions.updateAsync(
      { _id: runtime.executionId, status: { $in: ACTIVE_AUDIT_STATUSES } },
      {
        $set: {
          status: 'cancelling',
          updatedAt: new Date(),
          failureCode: reason,
        },
      },
    );
  } finally {
    signalProcessGroup(runtime.child.pid, 'SIGTERM');
    runtime.killTimer = setTimeout(() => {
      if (groupExists(runtime.child.pid)) {
        signalProcessGroup(runtime.child.pid, 'SIGKILL');
      }
    }, CANCEL_GRACE_MS);
  }
}

/**
 * Persists a bounded, sequenced output event without applying backpressure to
 * the child process.
 *
 * @param {object} runtime In-memory execution runtime.
 * @param {'stdout'|'stderr'|'system'} stream Output source.
 * @param {string} line Raw output line.
 */
function queueAuditEvent(runtime, stream, line) {
  if (runtime.eventCount >= MAX_EVENT_COUNT) return;
  const message = sanitizeAuditLogLine(line, runtime.repositoryRoot);
  if (message === '') return;
  runtime.eventCount += 1;
  runtime.sequence += 1;
  const event = {
    executionId: runtime.executionId,
    sequence: runtime.sequence,
    stream,
    message,
    createdAt: new Date(),
  };
  runtime.eventQueue = runtime.eventQueue
    .then(async () => {
      await AuditEvents.insertAsync(event);
      await AuditExecutions.updateAsync(runtime.executionId, {
        $set: { eventCount: runtime.eventCount, updatedAt: new Date() },
      });
    })
    .catch((error) => console.error('Could not persist audit output:', error));
}

/**
 * Applies one terminal execution state and releases the global lease.
 *
 * @param {string} executionId Execution identifier.
 * @param {Record<string, unknown>} fields Terminal fields.
 */
async function finishExecution(executionId, fields) {
  await AuditExecutions.updateAsync(
    { _id: executionId, status: { $in: ACTIVE_AUDIT_STATUSES } },
    {
      $set: {
        ...fields,
        finishedAt: new Date(),
        updatedAt: new Date(),
      },
      $unset: {
        activeLease: '',
        processId: '',
      },
    },
  );
}

/**
 * Records an executor failure while preserving the active-lease invariant.
 *
 * @param {string} executionId Execution identifier.
 * @param {string} failureCode Stable failure code.
 * @param {string} message Non-secret failure detail.
 */
async function failExecution(executionId, failureCode, message) {
  const runtime = ownedProcesses.get(executionId);
  const repositoryRoot = runtime?.repositoryRoot
    || process.env.BENCH_REPOSITORY_ROOT;
  ownedProcesses.delete(executionId);
  await finishExecution(executionId, {
    status: 'failed',
    failureCode,
    failureMessage: repositoryRoot
      ? sanitizeAuditLogLine(message, repositoryRoot)
      : String(message)
        .replace(/(?:\/[^/\s]+){2,}/g, '<path>')
        .slice(0, MAX_EVENT_MESSAGE_LENGTH),
  });
}

/**
 * Builds a minimal inherited environment required by Node, Meteor, and Mongo.
 *
 * @returns {NodeJS.ProcessEnv} Executor environment.
 */
function buildExecutorEnvironment() {
  const allowedKeys = [
    'PATH',
    'HOME',
    'TMPDIR',
    'TMP',
    'TEMP',
    'LANG',
    'LC_ALL',
    'BENCH_MONGO_URL',
    'BENCH_MONGO_DB',
    'MONGO_URL',
    'MONGO_OPLOG_URL',
  ];
  return Object.fromEntries(
    allowedKeys
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]]),
  );
}

/**
 * Reconciles stale active records after a dashboard server restart.
 */
async function reconcileInterruptedExecutions() {
  await AuditExecutions.updateAsync(
    {
      status: { $in: ['running', 'cancelling', 'starting'] },
      processId: { $exists: true },
    },
    {
      $set: {
        status: 'interrupted',
        recoveryRequired: true,
        updatedAt: new Date(),
        finishedAt: new Date(),
        failureCode: 'dashboard_server_restarted',
        failureMessage: 'The dashboard server restarted while the audit was active. Stop any remaining process group, then verify cleanup before releasing the audit lease.',
      },
    },
    { multi: true },
  );
  await AuditExecutions.updateAsync(
    {
      status: { $in: ['queued', 'starting'] },
      processId: { $exists: false },
    },
    {
      $set: {
        status: 'interrupted',
        recoveryRequired: false,
        updatedAt: new Date(),
        finishedAt: new Date(),
        failureCode: 'dashboard_server_restarted_before_spawn',
        failureMessage: 'The dashboard server restarted before the audit process started.',
      },
      $unset: { activeLease: '' },
    },
    { multi: true },
  );
}

/**
 * Terminates only process groups owned by this live server instance.
 */
function terminateOwnedProcesses() {
  shuttingDown = true;
  for (const runtime of ownedProcesses.values()) {
    signalProcessGroup(runtime.child.pid, 'SIGTERM');
  }
}

/**
 * Returns the server-configured set of launchable published releases.
 *
 * @returns {ReadonlyArray<string>} Allowed releases.
 */
function getAllowedMeteorVersions() {
  const configured = process.env.BENCH_AUDIT_METEOR_VERSIONS
    ?.split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return Object.freeze(
    configured?.length > 0 ? configured : [DEFAULT_ALLOWED_METEOR_VERSION],
  );
}

/**
 * Sends a signal to one child-owned POSIX process group.
 *
 * @param {number|undefined} pid Process-group leader.
 * @param {NodeJS.Signals} signal Signal name.
 */
function signalProcessGroup(pid, signal) {
  if (!Number.isInteger(pid) || pid <= 1) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') {
      console.error(`Could not signal audit process group: ${error.message}`);
    }
  }
}

/**
 * Checks whether a live process group still owns the tracked identifier.
 *
 * @param {number|undefined} pid Process-group leader.
 * @returns {boolean} Whether the group exists.
 */
function groupExists(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensures a generated path remains inside its server-controlled root.
 *
 * @param {string} root Allowed root.
 * @param {string} candidate Candidate path.
 */
function assertPathContained(root, candidate) {
  const relative = path.relative(root, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw executorError(
      'result_path_invalid',
      'The generated audit result path escaped its configured root.',
    );
  }
}

/**
 * Creates a stable executor-preflight error.
 *
 * @param {string} code Stable code.
 * @param {string} message Operator-facing message.
 * @returns {Error & {code: string}} Error.
 */
function executorError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Returns whether Mongo reported the unique active-lease invariant.
 *
 * @param {unknown} error Candidate error.
 * @returns {boolean} Whether it is a duplicate-key error.
 */
function isDuplicateKeyError(error) {
  return error?.code === 11000 || /duplicate key/i.test(error?.message || '');
}

/**
 * Escapes a literal string for use in a RegExp.
 *
 * @param {string} value Literal string.
 * @returns {string} Escaped string.
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Maps a stable capability code to actionable UI copy.
 *
 * @param {string|null} reasonCode Capability reason.
 * @returns {string} Operator-facing explanation.
 */
function capabilityMessage(reasonCode) {
  const messages = {
    process_groups_unsupported: 'Dashboard audit execution requires POSIX process-group support.',
    server_shutting_down: 'The dashboard server is shutting down.',
    repository_not_configured: 'Start the dashboard with BENCH_REPOSITORY_ROOT configured.',
    repository_unavailable: 'The configured benchmark repository is unavailable.',
    repository_invalid: 'The configured repository does not contain the audit runner and fixture.',
    node_incompatible: `The dashboard audit runner requires Node ${MINIMUM_NODE_MAJOR} or newer.`,
    executor_preflight_failed: 'The dashboard audit executor failed its server preflight.',
  };
  return messages[reasonCode] || messages.executor_preflight_failed;
}

/**
 * Reconciles stale leases before exposing the unique single-flight index.
 *
 * @returns {Promise<void>} Initialization completion.
 */
async function initializeAuditControlPlane() {
  await Promise.all([
    AuditExecutions.createIndexAsync({ createdAt: -1 }),
    AuditEvents.createIndexAsync(
      { executionId: 1, sequence: 1 },
      { unique: true },
    ),
    AuditEvents.createIndexAsync(
      { createdAt: 1 },
      { expireAfterSeconds: EVENT_RETENTION_SECONDS },
    ),
  ]);
  await reconcileInterruptedExecutions();
  await AuditExecutions.createIndexAsync(
    { activeLease: 1 },
    { unique: true, sparse: true },
  );
}

/** Resolves when durable state and the single-flight lease are ready. */
export const auditControlPlaneReady = initializeAuditControlPlane();

Meteor.publish('auditExecutions.recent', function publishAuditExecutions(limit = 20) {
  const boundedLimit = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 50) : 20;
  return AuditExecutions.find({}, {
    fields: {
      processId: 0,
      activeLease: 0,
    },
    sort: { createdAt: -1 },
    limit: boundedLimit,
  });
});

Meteor.publish('auditEvents.forExecution', function publishAuditEvents(executionId) {
  if (typeof executionId !== 'string' || executionId.length > 40) {
    throw new Meteor.Error('audit-invalid-id', 'Audit execution ID is invalid.');
  }
  return AuditEvents.find(
    { executionId },
    { sort: { sequence: 1 }, limit: MAX_EVENT_COUNT },
  );
});

Meteor.methods({
  'auditExecutions.capability'() {
    return getAuditExecutorCapability();
  },

  async 'auditExecutions.start'(request) {
    return await createAuditExecution(request);
  },

  async 'auditExecutions.cancel'(executionId) {
    return await cancelAuditExecution(executionId);
  },

  async 'auditExecutions.resolveInterrupted'(executionId) {
    return await resolveInterruptedExecution(executionId);
  },
});

Meteor.startup(() => {
  auditControlPlaneReady.catch((error) => {
    console.error('Dashboard audit control-plane initialization failed:', error);
  });
});

process.once('exit', terminateOwnedProcesses);
