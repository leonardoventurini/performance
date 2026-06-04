import { Template } from 'meteor/templating';
import { ReactiveVar } from 'meteor/reactive-var';
import { Meteor } from 'meteor/meteor';
import { Runs } from '../../api/runs';
import './dashboard.html';

const PAGE_SIZE = 30;

// "When" column — relative time. Stitch shows "2m ago / 1h ago / 3d ago".
function whenAgo(ts) {
  if (!ts) return '-';
  const d = ts instanceof Date ? ts : new Date(ts);
  const diff = Date.now() - d.getTime();
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.round(h / 24);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
}

// Pull a usable version label from the run. Most local results have
// meteor.version = "system"; fall back to the runtime channel or "—".
function versionLabel(run) {
  const v = run.meteor?.version;
  if (v && v !== 'system' && v !== 'unknown') return v;
  if (run.runtime?.channel) return run.runtime.channel;
  if (run.runtime?.version) return run.runtime.version;
  return 'local';
}

Template.dashboard.onCreated(function () {
  this.limit = new ReactiveVar(PAGE_SIZE);
  this.scenarioFilter = new ReactiveVar('');
  this.tagFilter = new ReactiveVar('');
  this.scenarios = new ReactiveVar([]);

  this.autorun(() => {
    this.subscribe('runs.recent', this.limit.get());
  });

  Meteor.callAsync('runs.distinctScenarios').then((s) => this.scenarios.set(s));
});

Template.dashboard.helpers({
  scenarios() { return Template.instance().scenarios.get(); },

  runs() {
    const t = Template.instance();
    const q = {};
    const sc = t.scenarioFilter.get();
    const tag = t.tagFilter.get().trim().toLowerCase();
    if (sc) q.scenario = sc;
    const all = Runs.find(q, { sort: { timestamp: -1 } }).fetch();

    // Δ vs previous: for each row, find the most recent earlier run of
    // the same scenario (regardless of tag) and compute wall_clock_ms
    // percentage delta. Sorting is descending by timestamp so we walk
    // by scenario lazily.
    const prevByScenario = {};
    // Build a per-scenario list sorted ascending so we can pair
    // chronologically. We compute the delta on the table-display order.
    const ascByScenario = {};
    for (const r of all) {
      (ascByScenario[r.scenario] ||= []).push(r);
    }
    for (const list of Object.values(ascByScenario)) {
      // Mongo gave us desc; reverse for chronological walk.
      list.reverse();
      for (let i = 1; i < list.length; i++) {
        list[i]._deltaPct = list[i - 1].wall_clock_ms
          ? ((list[i].wall_clock_ms - list[i - 1].wall_clock_ms) / list[i - 1].wall_clock_ms) * 100
          : null;
      }
    }

    return all
      .filter((r) => !tag || r.tag?.toLowerCase().includes(tag))
      .map((r) => ({
        ...r,
        whenAgo: whenAgo(r.timestamp),
        versionLabel: versionLabel(r),
        wallClock: r.wall_clock_ms ? `${(r.wall_clock_ms / 1000).toFixed(1)}s` : '-',
        cpuAvg: r.metrics?.app_resources?.cpu?.avg != null
          ? `${r.metrics.app_resources.cpu.avg.toFixed(1)}%` : '-',
        ramAvg: r.metrics?.app_resources?.memory?.avg_mb != null
          ? `${r.metrics.app_resources.memory.avg_mb.toFixed(0)} MB` : '-',
        gcPause: r.metrics?.gc?.total_pause_ms != null
          ? `${r.metrics.gc.total_pause_ms.toFixed(0)} ms` : '-',
        deltaStr: r._deltaPct == null
          ? '—'
          : `${r._deltaPct > 0 ? '+' : ''}${r._deltaPct.toFixed(1)}%`,
        deltaClass: r._deltaPct == null
          ? 'text-neutral-500'
          : Math.abs(r._deltaPct) < 5
            ? 'text-neutral-500'
            : r._deltaPct > 0
              ? 'text-orange-500 font-medium'
              : 'text-green-500 font-medium',
      }));
  },

  hasRuns() { return Runs.find().count() > 0; },
  hasMore() {
    const t = Template.instance();
    return Runs.find().count() >= t.limit.get();
  },
  runCount() { return Runs.find().count(); },
  scenarioCount() { return Template.instance().scenarios.get().length; },
  hasActiveFilters() {
    const t = Template.instance();
    return t.scenarioFilter.get() || t.tagFilter.get();
  },
});

Template.dashboard.events({
  'change #filterScenario'(event, instance) {
    instance.scenarioFilter.set(event.target.value);
  },
  'input #filterTag'(event, instance) {
    instance.tagFilter.set(event.target.value);
  },
  'click #clearFilters'(event, instance) {
    instance.scenarioFilter.set('');
    instance.tagFilter.set('');
    const sc = instance.find('#filterScenario');
    const tg = instance.find('#filterTag');
    if (sc) sc.value = '';
    if (tg) tg.value = '';
  },
  'click #loadMore'(event, instance) {
    instance.limit.set(instance.limit.get() + PAGE_SIZE);
  },
});
