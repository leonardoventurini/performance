import { Meteor } from 'meteor/meteor';
import { ReactiveVar } from 'meteor/reactive-var';
import { Template } from 'meteor/templating';
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
Template.audits.onCreated(function onAuditsCreated() {
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
    if (execution) this.selectedExecutionId.set(execution._id);
  });
});

Template.audits.onDestroyed(function onAuditsDestroyed() {
  clearInterval(this.clockTimer);
});

Template.audits.helpers({
  capabilityReady() {
    return Template.instance().capability.get() !== null;
  },
  executorAvailable() {
    return Template.instance().capability.get()?.available === true;
  },
  capabilityLabel() {
    return Template.instance().capability.get()?.available
      ? 'Executor ready'
      : 'Executor unavailable';
  },
  capabilityClass() {
    return Template.instance().capability.get()?.available
      ? PASSED_STATUS_CLASS
      : FAILED_STATUS_CLASS;
  },
  capabilityMessage() {
    const reasonCode = Template.instance().capability.get()?.reasonCode;
    return CAPABILITY_MESSAGES[reasonCode]
      || 'The local audit executor is unavailable.';
  },
  allowedMeteorVersions() {
    return Template.instance().capability.get()?.allowedMeteorVersions || [];
  },
  oplogUnavailable() {
    return Template.instance().capability.get()?.oplogAvailable === false;
  },
  oplogOptionSuffix() {
    return Template.instance().capability.get()?.oplogAvailable === false
      ? ' — server configuration required'
      : '';
  },
  startDisabled() {
    const instance = Template.instance();
    return instance.startBusy.get()
      || AuditExecutions.find({
        $or: [
          { status: { $in: ACTIVE_AUDIT_STATUSES } },
          { recoveryRequired: true },
        ],
      }).count() > 0;
  },
  startButtonLabel() {
    const instance = Template.instance();
    if (instance.startBusy.get()) return 'Starting audit…';
    if (AuditExecutions.find({ recoveryRequired: true }).count() > 0) {
      return 'Resolve interrupted audit first';
    }
    if (AuditExecutions.find({ status: { $in: ACTIVE_AUDIT_STATUSES } }).count() > 0) {
      return 'Another audit is active';
    }
    return 'Start audit';
  },
  selectedExecution() {
    const instance = Template.instance();
    instance.clock.get();
    const execution = AuditExecutions.findOne(instance.selectedExecutionId.get());
    return execution ? presentAuditExecution(execution) : null;
  },
  selectedEvents() {
    const instance = Template.instance();
    return AuditEvents.find(
      { executionId: instance.selectedExecutionId.get() },
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
    const instance = Template.instance();
    instance.clock.get();
    return AuditExecutions.find({}, { sort: { createdAt: -1 } })
      .fetch()
      .map((execution) => presentAuditExecution(execution));
  },
  hasExecutions() {
    return AuditExecutions.find().count() > 0;
  },
  cancelBusy() {
    return Template.instance().cancelBusy.get();
  },
  cancelButtonLabel() {
    return Template.instance().cancelBusy.get()
      ? 'Cancelling audit…'
      : 'Cancel audit';
  },
  recoveryBusy() {
    return Template.instance().recoveryBusy.get();
  },
  recoveryButtonLabel() {
    return Template.instance().recoveryBusy.get()
      ? 'Verifying cleanup…'
      : 'Verify cleanup and release';
  },
  pageError() {
    return Template.instance().pageError.get();
  },
});

Template.audits.events({
  async 'submit #auditLaunchForm'(event, instance) {
    event.preventDefault();
    instance.startBusy.set(true);
    instance.pageError.set('');
    const form = event.currentTarget.elements;
    try {
      const executionId = await Meteor.callAsync('auditExecutions.start', {
        profile: form.profile.value,
        observerDriver: form.observerDriver.value,
        meteorVersion: form.meteorVersion.value,
        seed: form.seed.value,
        tag: form.tag.value,
      });
      instance.selectedExecutionId.set(executionId);
      form.seed.value = '';
      form.tag.value = '';
    } catch (error) {
      instance.pageError.set(error.reason || error.message);
    } finally {
      instance.startBusy.set(false);
    }
  },

  async 'click .js-cancel-audit'(event, instance) {
    event.preventDefault();
    instance.cancelBusy.set(true);
    instance.pageError.set('');
    try {
      await Meteor.callAsync(
        'auditExecutions.cancel',
        instance.selectedExecutionId.get(),
      );
    } catch (error) {
      instance.pageError.set(error.reason || error.message);
    } finally {
      instance.cancelBusy.set(false);
    }
  },

  async 'click .js-resolve-audit-recovery'(event, instance) {
    event.preventDefault();
    instance.recoveryBusy.set(true);
    instance.pageError.set('');
    try {
      await Meteor.callAsync(
        'auditExecutions.resolveInterrupted',
        instance.selectedExecutionId.get(),
      );
    } catch (error) {
      instance.pageError.set(error.reason || error.message);
    } finally {
      instance.recoveryBusy.set(false);
    }
  },

  'click .js-select-audit'(event, instance) {
    instance.selectedExecutionId.set(event.currentTarget.dataset.executionId);
  },

  'click #dismissAuditError'(event, instance) {
    event.preventDefault();
    instance.pageError.set('');
  },
});

/**
 * Refreshes sanitized server executor capability.
 *
 * @param {Blaze.TemplateInstance} instance Template instance.
 */
async function refreshCapability(instance) {
  try {
    instance.capability.set(
      await Meteor.callAsync('auditExecutions.capability'),
    );
  } catch (error) {
    instance.capability.set({
      available: false,
      reasonCode: 'executor_preflight_failed',
      allowedMeteorVersions: [],
    });
    instance.pageError.set(error.reason || error.message);
  }
}
