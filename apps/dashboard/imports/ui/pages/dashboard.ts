import { Template, type TemplateStaticTyped } from 'meteor/templating';
import { ReactiveVar } from 'meteor/reactive-var';
import { Meteor } from 'meteor/meteor';
import { Runs, type RunDocument } from '../../api/runs';
import './dashboard.html';

const PAGE_SIZE = 30;
type DashboardState = Record<string, unknown> & {
  limit: ReactiveVar<number>;
  scenarioFilter: ReactiveVar<string>;
  tagFilter: ReactiveVar<string>;
  scenarios: ReactiveVar<string[]>;
};
const Dashboard = Template as TemplateStaticTyped<'dashboard', unknown, DashboardState>;

// "When" column — relative time. Stitch shows "2m ago / 1h ago / 3d ago".
function whenAgo(ts: Date | string | number | undefined): string {
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
function versionLabel(run: RunDocument): string {
  const v = run.meteor?.version;
  if (v && v !== 'system' && v !== 'unknown') return v;
  if (run.runtime?.channel) return run.runtime.channel;
  if (run.runtime?.version) return run.runtime.version;
  return 'local';
}

Dashboard.dashboard.onCreated(function () {
  this.limit = new ReactiveVar(PAGE_SIZE);
  this.scenarioFilter = new ReactiveVar('');
  this.tagFilter = new ReactiveVar('');
  this.scenarios = new ReactiveVar([]);

  this.autorun(() => {
    this.subscribe('runs.recent', this.limit.get());
  });

  Meteor.callAsync('runs.distinctScenarios').then((scenarios: string[]) => this.scenarios.set(scenarios));
});

Dashboard.dashboard.helpers({
  scenarios(): string[] { return Dashboard.instance().scenarios.get(); },

  runs() {
    const t = Dashboard.instance();
    const q: { scenario?: string } = {};
    const sc = t.scenarioFilter.get();
    const tag = t.tagFilter.get().trim().toLowerCase();
    if (sc) q.scenario = sc;
    const all = Runs.find(q, { sort: { timestamp: -1 } }).fetch();

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
      }));
  },

  hasRuns() { return Runs.find().count() > 0; },
  hasMore() {
    const t = Dashboard.instance();
    return Runs.find().count() >= t.limit.get();
  },
  runCount() { return Runs.find().count(); },
  scenarioCount() { return Dashboard.instance().scenarios.get().length; },
  hasActiveFilters() {
    const t = Dashboard.instance();
    return t.scenarioFilter.get() || t.tagFilter.get();
  },
});

Dashboard.dashboard.events({
  'change #filterScenario'(event: Meteor.Event, instance): boolean {
    if (event.target instanceof HTMLSelectElement) instance.scenarioFilter.set(event.target.value);
    return false;
  },
  'input #filterTag'(event: Meteor.Event, instance): boolean {
    if (event.target instanceof HTMLInputElement) instance.tagFilter.set(event.target.value);
    return false;
  },
  'click #clearFilters'(_event: Meteor.Event, instance): boolean {
    instance.scenarioFilter.set('');
    instance.tagFilter.set('');
    const sc = instance.find('#filterScenario');
    const tg = instance.find('#filterTag');
    if (sc instanceof HTMLSelectElement) sc.value = '';
    if (tg instanceof HTMLInputElement) tg.value = '';
    return false;
  },
  'click #loadMore'(_event: Meteor.Event, instance): boolean {
    instance.limit.set(instance.limit.get() + PAGE_SIZE);
    return false;
  },
});
