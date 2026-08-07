import { Meteor } from 'meteor/meteor';
import { ReactiveVar } from 'meteor/reactive-var';
import { Template, type TemplateStaticTyped } from 'meteor/templating';
import {
  ACTIVE_AUDIT_STATUSES,
} from '../../api/audit-contract';
import {
  AuditEvents,
  AuditExecutions,
} from '../../api/audit-executions';
import {
  FAILED_STATUS_CLASS,
  PASSED_STATUS_CLASS,
  presentAuditExecution,
} from './audit-presentation';
import './audits.html';

const CAPABILITY_MESSAGES = Object.freeze({
  process_groups_unsupported: 'This server cannot safely isolate and cancel the audit process tree.',
  server_shutting_down: 'The dashboard server is shutting down and cannot accept new audits.',
  repository_not_configured: 'The dashboard server was not started with the benchmark repository configured.',
  repository_unavailable: 'The configured benchmark repository is not available to this server.',
  repository_invalid: 'The configured repository does not contain the audit runner and task fixture.',
  node_incompatible: 'The configured audit runner does not provide Node 24 or newer.',
  executor_preflight_failed: 'The dashboard server could not verify the local audit executor.',
});

interface AuditCapability {
  available: boolean;
  reasonCode: string | null;
  allowedMeteorVersions: string[];
  oplogAvailable: boolean;
}

type AuditsState = Record<string, unknown> & {
  capability: ReactiveVar<AuditCapability | null>;
  startBusy: ReactiveVar<boolean>;
  cancelBusy: ReactiveVar<boolean>;
  recoveryBusy: ReactiveVar<boolean>;
  pageError: ReactiveVar<string>;
  selectedExecutionId: ReactiveVar<string | null>;
  clock: ReactiveVar<number>;
  clockTimer: ReturnType<typeof setInterval>;
};

interface AuditLaunchFormElements extends HTMLFormControlsCollection {
  profile: HTMLSelectElement;
  observerDriver: HTMLSelectElement;
  meteorVersion: HTMLSelectElement;
  seed: HTMLInputElement;
  tag: HTMLInputElement;
}

interface AuditLaunchForm extends HTMLFormElement {
  readonly elements: AuditLaunchFormElements;
}

const Audits = Template as TemplateStaticTyped<'audits', unknown, AuditsState>;

Audits.audits.onCreated(function onAuditsCreated() {
  this.capability = new ReactiveVar(null);
  this.startBusy = new ReactiveVar(false);
  this.cancelBusy = new ReactiveVar(false);
  this.recoveryBusy = new ReactiveVar(false);
  this.pageError = new ReactiveVar('');
  this.selectedExecutionId = new ReactiveVar(null);
  this.clock = new ReactiveVar(Date.now());

  this.clockTimer = setInterval(() => this.clock.set(Date.now()), 1_000);
  refreshCapability(this);

  this.autorun(() => {
    this.subscribe('auditExecutions.recent', 20);
  });

  this.autorun(() => {
    const selectedExecutionId = this.selectedExecutionId.get();
    if (selectedExecutionId) {
      this.subscribe('auditEvents.forExecution', selectedExecutionId);
    }
  });

  this.autorun(() => {
    if (this.selectedExecutionId.get()) return;
    const execution = AuditExecutions.findOne({}, { sort: { createdAt: -1 } });
    if (execution?._id) this.selectedExecutionId.set(execution._id);
  });
});

Audits.audits.onDestroyed(function onAuditsDestroyed() {
  clearInterval(this.clockTimer);
});

Audits.audits.helpers({
  capabilityReady() {
    return Audits.instance().capability.get() !== null;
  },
  executorAvailable() {
    return Audits.instance().capability.get()?.available === true;
  },
  capabilityLabel() {
    return Audits.instance().capability.get()?.available
      ? 'Executor ready'
      : 'Executor unavailable';
  },
  capabilityClass() {
    return Audits.instance().capability.get()?.available
      ? PASSED_STATUS_CLASS
      : FAILED_STATUS_CLASS;
  },
  capabilityMessage() {
    const reasonCode = Audits.instance().capability.get()?.reasonCode;
    return reasonCode && Object.hasOwn(CAPABILITY_MESSAGES, reasonCode)
      ? CAPABILITY_MESSAGES[reasonCode as keyof typeof CAPABILITY_MESSAGES]
      : 'The local audit executor is unavailable.';
  },
  allowedMeteorVersions() {
    return Audits.instance().capability.get()?.allowedMeteorVersions || [];
  },
  oplogUnavailable() {
    return Audits.instance().capability.get()?.oplogAvailable === false;
  },
  oplogOptionSuffix() {
    return Audits.instance().capability.get()?.oplogAvailable === false
      ? ' — server configuration required'
      : '';
  },
  startDisabled() {
    const instance = Audits.instance();
    return instance.startBusy.get()
      || AuditExecutions.find({
        $or: [
          { status: { $in: [...ACTIVE_AUDIT_STATUSES] } },
          { recoveryRequired: true },
        ],
      }).count() > 0;
  },
  startButtonLabel() {
    const instance = Audits.instance();
    if (instance.startBusy.get()) return 'Starting audit…';
    if (AuditExecutions.find({ recoveryRequired: true }).count() > 0) {
      return 'Resolve interrupted audit first';
    }
    if (AuditExecutions.find({ status: { $in: [...ACTIVE_AUDIT_STATUSES] } }).count() > 0) {
      return 'Another audit is active';
    }
    return 'Start audit';
  },
  selectedExecution() {
    const instance = Audits.instance();
    instance.clock.get();
    const selectedId = instance.selectedExecutionId.get();
    if (!selectedId) return null;
    const execution = AuditExecutions.findOne(selectedId);
    return execution ? presentAuditExecution(execution) : null;
  },
  selectedEvents() {
    const instance = Audits.instance();
    const selectedId = instance.selectedExecutionId.get();
    if (!selectedId) return [];
    return AuditEvents.find(
      { executionId: selectedId },
      { sort: { sequence: 1 } },
    ).fetch().map((event) => ({
      ...event,
      eventClass: event.stream === 'stderr'
        ? 'text-amber-300'
        : event.stream === 'system'
          ? 'text-indigo-300'
          : '',
    }));
  },
  executions() {
    const instance = Audits.instance();
    instance.clock.get();
    return AuditExecutions.find({}, { sort: { createdAt: -1 } })
      .fetch()
      .map((execution) => presentAuditExecution(execution));
  },
  hasExecutions() {
    return AuditExecutions.find().count() > 0;
  },
  cancelBusy() {
    return Audits.instance().cancelBusy.get();
  },
  cancelButtonLabel() {
    return Audits.instance().cancelBusy.get()
      ? 'Cancelling audit…'
      : 'Cancel audit';
  },
  recoveryBusy() {
    return Audits.instance().recoveryBusy.get();
  },
  recoveryButtonLabel() {
    return Audits.instance().recoveryBusy.get()
      ? 'Verifying cleanup…'
      : 'Verify cleanup and release';
  },
  pageError() {
    return Audits.instance().pageError.get();
  },
});

Audits.audits.events({
  async 'submit #auditLaunchForm'(event: Meteor.Event, instance): Promise<void> {
    event.preventDefault();
    instance.startBusy.set(true);
    instance.pageError.set('');
    if (!(event.currentTarget instanceof HTMLFormElement)) return;
    const form = event.currentTarget as AuditLaunchForm;
    try {
      const executionId: unknown = await Meteor.callAsync('auditExecutions.start', {
        profile: form.elements.profile.value,
        observerDriver: form.elements.observerDriver.value,
        meteorVersion: form.elements.meteorVersion.value,
        seed: form.elements.seed.value,
        tag: form.elements.tag.value,
      });
      if (typeof executionId !== 'string') throw new Error('Audit start returned an invalid execution identifier.');
      instance.selectedExecutionId.set(executionId);
      form.elements.seed.value = '';
      form.elements.tag.value = '';
    } catch (error: unknown) {
      instance.pageError.set(errorMessage(error));
    } finally {
      instance.startBusy.set(false);
    }
  },

  async 'click .js-cancel-audit'(event: Meteor.Event, instance): Promise<void> {
    event.preventDefault();
    instance.cancelBusy.set(true);
    instance.pageError.set('');
    try {
      await Meteor.callAsync(
        'auditExecutions.cancel',
        instance.selectedExecutionId.get(),
      );
    } catch (error: unknown) {
      instance.pageError.set(errorMessage(error));
    } finally {
      instance.cancelBusy.set(false);
    }
  },

  async 'click .js-resolve-audit-recovery'(event: Meteor.Event, instance): Promise<void> {
    event.preventDefault();
    instance.recoveryBusy.set(true);
    instance.pageError.set('');
    try {
      await Meteor.callAsync(
        'auditExecutions.resolveInterrupted',
        instance.selectedExecutionId.get(),
      );
    } catch (error: unknown) {
      instance.pageError.set(errorMessage(error));
    } finally {
      instance.recoveryBusy.set(false);
    }
  },

  'click .js-select-audit'(event: Meteor.Event, instance): boolean {
    if (event.currentTarget instanceof HTMLElement) {
      instance.selectedExecutionId.set(event.currentTarget.dataset.executionId ?? null);
    }
    return false;
  },

  'click #dismissAuditError'(event: Meteor.Event, instance): boolean {
    event.preventDefault();
    instance.pageError.set('');
    return false;
  },
});

/**
 * Refreshes sanitized server executor capability.
 *
 * @param {Blaze.TemplateInstance} instance Template instance.
 */
async function refreshCapability(instance: AuditsState): Promise<void> {
  try {
    instance.capability.set(
      normalizeCapability(await Meteor.callAsync('auditExecutions.capability')),
    );
  } catch (error: unknown) {
    instance.capability.set({
      available: false,
      reasonCode: 'executor_preflight_failed',
      allowedMeteorVersions: [],
      oplogAvailable: false,
    });
    instance.pageError.set(errorMessage(error));
  }
}

function normalizeCapability(value: unknown): AuditCapability {
  if (value === null || typeof value !== 'object') throw new Error('Audit capability response is invalid.');
  const record = value as Record<string, unknown>;
  if (typeof record.available !== 'boolean' || !Array.isArray(record.allowedMeteorVersions)) {
    throw new Error('Audit capability response is invalid.');
  }
  return {
    available: record.available,
    reasonCode: typeof record.reasonCode === 'string' ? record.reasonCode : null,
    allowedMeteorVersions: record.allowedMeteorVersions.filter((item): item is string => typeof item === 'string'),
    oplogAvailable: record.oplogAvailable === true,
  };
}

function errorMessage(error: unknown): string {
  if (error !== null && typeof error === 'object') {
    if ('reason' in error && typeof error.reason === 'string') return error.reason;
    if ('message' in error && typeof error.message === 'string') return error.message;
  }
  return String(error);
}
