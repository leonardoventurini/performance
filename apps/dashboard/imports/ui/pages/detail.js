import { Template } from 'meteor/templating';
import { FlowRouter } from 'meteor/ostrio:flow-router-extra';
import { Runs } from '../../api/runs';
import './detail.html';

Template.detail.onCreated(function () {
  this.autorun(() => {
    const runId = FlowRouter.getParam('id');
    if (runId) this.subscribe('runs.single', runId);
  });
});

// Helpers below all read `this.metrics.<key>`. Each metric panel guards
// rendering with `hasXxx` (absence convention CC-5: missing key → omit
// the whole card), so a run JSON without a given metric stays clean.

function fmtMs(n) {
  if (n == null || !Number.isFinite(n)) return '-';
  return n.toFixed(2);
}

function fmtInt(n) {
  if (n == null || !Number.isFinite(n)) return '-';
  return Math.round(n).toString();
}

function fmtRate(n) {
  if (n == null || !Number.isFinite(n)) return '-';
  return n.toFixed(2);
}

Template.detail.helpers({
  run() {
    return Runs.findOne(FlowRouter.getParam('id'));
  },
  formatDate(date) {
    if (!date) return '-';
    return new Date(date).toLocaleString('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  },
  formatMs(ms) {
    if (!ms) return '-';
    return `${(ms / 1000).toFixed(1)}s`;
  },
  appCpuAvg() { return this.metrics?.app_resources?.cpu?.avg?.toFixed(1) || '-'; },
  appCpuMax() { return this.metrics?.app_resources?.cpu?.max?.toFixed(1) || '-'; },
  appRamAvg() { return this.metrics?.app_resources?.memory?.avg_mb?.toFixed(0) || '-'; },
  appRamMax() { return this.metrics?.app_resources?.memory?.max_mb?.toFixed(0) || '-'; },
  dbCpuAvg() { return this.metrics?.db_resources?.cpu?.avg?.toFixed(1) || '-'; },
  dbRamAvg() { return this.metrics?.db_resources?.memory?.avg_mb?.toFixed(0) || '-'; },
  gcCount() { return this.metrics?.gc?.count || '-'; },
  gcTotalPause() { return this.metrics?.gc?.total_pause_ms?.toFixed(0) || '-'; },
  gcMaxPause() { return this.metrics?.gc?.max_pause_ms?.toFixed(1) || '-'; },
  gcAvgPause() { return this.metrics?.gc?.avg_pause_ms?.toFixed(1) || '-'; },
  gcMinorCount() { return this.metrics?.gc?.minor?.count || '-'; },
  gcMinorMs() { return this.metrics?.gc?.minor?.total_ms?.toFixed(0) || '-'; },
  gcMajorCount() { return this.metrics?.gc?.major?.count || '-'; },
  gcMajorMs() { return this.metrics?.gc?.major?.total_ms?.toFixed(0) || '-'; },

  // ─── DDP method latency (task 01) ──────────────────────────────────
  hasDdpMethods() { return !!this.metrics?.ddp_methods; },
  ddpMethodsTotal() { return this.metrics?.ddp_methods?.total_calls ?? '-'; },
  ddpMethodsRows() {
    const methods = this.metrics?.ddp_methods?.methods ?? {};
    return Object.entries(methods)
      .sort((a, b) => b[1].count - a[1].count)
      .map(([name, m]) => ({
        name,
        count: fmtInt(m.count),
        avg: fmtMs(m.avg_ms),
        p95: fmtMs(m.p95),
        p99: fmtMs(m.p99),
        max: fmtMs(m.max_ms),
      }));
  },

  // ─── DDP subscription ready latency (task 02) ──────────────────────
  hasDdpSubscriptions() { return !!this.metrics?.ddp_subscriptions; },
  ddpSubsTotal() { return this.metrics?.ddp_subscriptions?.total_subs ?? '-'; },
  ddpSubsRows() {
    const pubs = this.metrics?.ddp_subscriptions?.publications ?? {};
    return Object.entries(pubs)
      .sort((a, b) => b[1].count - a[1].count)
      .map(([name, p]) => ({
        name,
        count: fmtInt(p.count),
        avg: fmtMs(p.avg_ms),
        p95: fmtMs(p.p95),
        p99: fmtMs(p.p99),
        max: fmtMs(p.max_ms),
      }));
  },

  // ─── Live-update propagation latency (task 03) ─────────────────────
  hasLiveUpdatePropagation() { return !!this.metrics?.live_update_propagation; },
  lupObservedUpdates() { return fmtInt(this.metrics?.live_update_propagation?.observed_updates); },
  lupAvg() { return fmtMs(this.metrics?.live_update_propagation?.avg_ms); },
  lupP50() { return fmtMs(this.metrics?.live_update_propagation?.p50); },
  lupP95() { return fmtMs(this.metrics?.live_update_propagation?.p95); },
  lupP99() { return fmtMs(this.metrics?.live_update_propagation?.p99); },
  lupMax() { return fmtMs(this.metrics?.live_update_propagation?.max_ms); },

  // ─── Mongo opcounters (task 04) ────────────────────────────────────
  hasMongoOps() { return !!this.metrics?.mongo_ops; },
  mongoOpsDuration() {
    const d = this.metrics?.mongo_ops?.duration_s;
    return d != null && Number.isFinite(d) ? d.toFixed(1) : '-';
  },
  mongoOpsRows() {
    const totals = this.metrics?.mongo_ops?.totals ?? {};
    const rates = this.metrics?.mongo_ops?.ops_per_sec ?? {};
    return Object.keys(totals).map((op) => ({
      op,
      total: fmtInt(totals[op]),
      perSec: fmtRate(rates[op]),
    }));
  },
});
