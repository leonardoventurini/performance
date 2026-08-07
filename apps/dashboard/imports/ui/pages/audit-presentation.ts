import { ACTIVE_AUDIT_STATUSES, type AuditLaunchRequest, type AuditStatus } from '../../api/audit-contract';

/** Persisted fields consumed by the audit execution presenter. */
export interface AuditExecutionPresentationSource {
  _id?: string;
  status: AuditStatus;
  createdAt: Date | string;
  startedAt?: Date | string;
  finishedAt?: Date | string;
  request?: Partial<AuditLaunchRequest>;
  auditStatus?: string | null;
  recoveryRequired?: boolean;
}

/** Human-readable labels for durable execution states. */
export const AUDIT_STATUS_LABELS = Object.freeze({
  queued: 'Queued',
  starting: 'Starting',
  running: 'Running',
  cancelling: 'Cancelling',
  passed: 'Passed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
});

/** Shared active-state badge styling. */
export const ACTIVE_STATUS_CLASS =
  'inline-flex rounded-full bg-indigo-100 dark:bg-indigo-950 px-2 py-0.5 text-[11px] font-medium text-indigo-700 dark:text-indigo-300';

/** Shared passing-state badge styling. */
export const PASSED_STATUS_CLASS =
  'inline-flex rounded-full bg-emerald-100 dark:bg-emerald-950 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300';

/** Shared failure-state badge styling. */
export const FAILED_STATUS_CLASS =
  'inline-flex rounded-full bg-red-100 dark:bg-red-950 px-2 py-0.5 text-[11px] font-medium text-red-700 dark:text-red-300';

/** Shared neutral-state badge styling. */
export const NEUTRAL_STATUS_CLASS =
  'inline-flex rounded-full bg-neutral-200 dark:bg-neutral-800 px-2 py-0.5 text-[11px] font-medium text-neutral-700 dark:text-neutral-300';

/**
 * Maps an execution to presentation-only fields.
 *
 * @param {Record<string, unknown>} execution Persisted execution.
 * @param {number} now Current wall-clock timestamp.
 * @returns {Record<string, unknown>} Execution with view fields.
 */
export function presentAuditExecution(
  execution: AuditExecutionPresentationSource,
  now: number = Date.now(),
): AuditExecutionPresentationSource & Record<string, unknown> {
  const createdAt = new Date(execution.createdAt);
  const startedAt = execution.startedAt ? new Date(execution.startedAt) : createdAt;
  const finishedAt = execution.finishedAt ? new Date(execution.finishedAt) : new Date(now);
  const elapsedMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());
  return {
    ...execution,
    statusLabel: AUDIT_STATUS_LABELS[execution.status] || 'Unknown',
    statusClass: auditStatusClass(execution.status),
    createdLabel: Number.isNaN(createdAt.getTime())
      ? 'Unknown time'
      : createdAt.toLocaleString('en-GB', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      }),
    elapsedLabel: formatAuditDuration(elapsedMs),
    meteorVersionLabel: execution.request?.meteorVersion || 'server default',
    auditStatusLabel: execution.auditStatus || 'not established',
    canCancel: execution.status === 'queued' || execution.status === 'starting' || execution.status === 'running',
    canResolveRecovery: execution.status === 'interrupted'
      && execution.recoveryRequired === true,
    isActive: ACTIVE_AUDIT_STATUSES.some((candidate) => candidate === execution.status),
    failureTitle: execution.status === 'interrupted'
      ? 'Execution interrupted'
      : 'Audit did not pass',
  };
}

/**
 * Maps an execution status to accessible text-adjacent styling.
 *
 * @param {unknown} status Execution status.
 * @returns {string} CSS class string.
 */
export function auditStatusClass(status: unknown): string {
  if (typeof status === 'string' && ACTIVE_AUDIT_STATUSES.some((candidate) => candidate === status)) return ACTIVE_STATUS_CLASS;
  if (status === 'passed') return PASSED_STATUS_CLASS;
  if (status === 'failed' || status === 'interrupted') return FAILED_STATUS_CLASS;
  return NEUTRAL_STATUS_CLASS;
}

/**
 * Formats elapsed execution duration without implying progress.
 *
 * @param {number} milliseconds Elapsed duration.
 * @returns {string} Human-readable duration.
 */
export function formatAuditDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`;
}
