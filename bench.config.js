/**
 * Meteor Benchmark Framework — Configuration
 *
 * Defines apps, scenarios, metric thresholds for regression detection,
 * and the local Meteor checkout path for version switching.
 */

const path = require('path');

module.exports = {
  // Local Meteor checkout — switch branches here to benchmark different versions
  meteorCheckoutPath: process.env.METEOR_CHECKOUT_PATH || path.resolve(__dirname, '../../meteor'),

  // Default app to benchmark
  defaultApp: 'tasks-3.x',

  // Port for the Meteor app
  appPort: 3000,

  // Collector interval in ms
  collectorInterval: 1000,

  // Apps available for benchmarking
  apps: {
    'tasks-3.x': {
      path: path.resolve(__dirname, 'apps/tasks-3.x'),
      description: 'Meteor 3 React task app',
    },
  },

  // Scenarios
  scenarios: {
    'reactive-crud': {
      driver: 'artillery-playwright',
      config: 'artillery/reactive-stress.yml',
      description: 'Reactive pub/sub CRUD with 240 browser VUs',
    },
    'reactive-light': {
      driver: 'artillery-playwright',
      config: 'artillery/reactive-stress-light.yml',
      description: 'Light reactive CRUD with 30 browser VUs',
    },
    'non-reactive-crud': {
      driver: 'artillery-playwright',
      config: 'artillery/non-reactive-stress.yml',
      description: 'Methods-only CRUD with 240 browser VUs',
    },
    'ddp-reactive-light': {
      driver: 'artillery',
      config: 'artillery/ddp-reactive-light.yml',
      description: 'DDP-only reactive CRUD with 150 VUs (no browser)',
    },
    'ddp-non-reactive-light': {
      driver: 'artillery',
      config: 'artillery/ddp-non-reactive-light.yml',
      description: 'DDP-only methods CRUD with 150 VUs (no browser)',
    },
    'fanout-light': {
      driver: 'script',
      script: 'tests/fanout-bench.js',
      args: '--subscribers 50 --writes 30',
      description: 'Reactive fanout: 50 subscribers, 1 writer, measure propagation latency',
    },
    'fanout-heavy': {
      driver: 'script',
      script: 'tests/fanout-bench.js',
      args: '--subscribers 200 --writes 50',
      description: 'Reactive fanout: 200 subscribers, 1 writer, measure propagation latency',
    },
    'cold-start': {
      driver: 'cli',
      description: 'App startup time from clean state (meteor reset)',
    },
    'hot-reload': {
      driver: 'cli',
      description: 'Client/server rebuild time after file change',
    },
    'bundle-size': {
      driver: 'cli',
      description: 'Client + server bundle output size',
    },
  },

  // Regression detection thresholds (% increase from baseline)
  thresholds: {
    wall_clock_ms:       { warn: 10, fail: 25 },
    response_time_p95:   { warn: 10, fail: 25 },
    cpu_avg_percent:     { warn: 15, fail: 30 },
    ram_avg_mb:          { warn: 10, fail: 20 },
    event_loop_p99_ms:   { warn: 20, fail: 50 },
    cold_start_ms:       { warn: 10, fail: 25 },
    bundle_size_kb:      { warn: 5,  fail: 15 },
    gc_total_pause_ms:   { warn: 20, fail: 50 },
    gc_max_pause_ms:     { warn: 25, fail: 60 },
    gc_count:            { warn: 20, fail: 50 },
    gc_major_ms:         { warn: 25, fail: 60 },
  },

  // Dashboard
  dashboardUrl: process.env.BENCH_DASHBOARD_URL?.trim() || 'ws://localhost:4000/websocket',
  dashboardApiKey: process.env.BENCH_API_KEY || 'dev-bench-key-change-in-prod',

  // Output paths
  results: {
    dir: path.resolve(__dirname, 'results'),
    baseline: path.resolve(__dirname, 'results/baseline.json'),
    history: path.resolve(__dirname, 'results/history'),
  },
};
