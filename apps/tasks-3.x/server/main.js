import { Meteor } from 'meteor/meteor';
import { tryMonitorExtras, initializeTaskCollection, registerTaskApi } from 'meteor/tasks-common';

// Emit one machine-parseable line per runtime dimension on startup. The
// benchmark harness greps these from stderr and surfaces them under
// `runtime.*` in the result JSON so a comparison across the (observer
// driver × DDP transport) matrix carries the requested configuration with
// the numbers.
//
// We log the REQUESTED value, not the per-cursor actually-used driver:
// Meteor picks the observer driver per-cursor based on availability
// (changeStreams needs Mongo replica set; oplog needs MONGO_OPLOG_URL).
// For a benchmark matrix where the env pins one driver and the workflow
// reports it, the requested value is the right thing to record.
function logRuntimeInfo() {
  const orderEnv = process.env.METEOR_REACTIVITY_ORDER;
  const orderSetting = Meteor.settings?.packages?.mongo?.reactivity;
  const observerDriver =
    orderEnv?.split(',')[0] ||
    (Array.isArray(orderSetting) ? orderSetting[0] : orderSetting) ||
    'changeStreams'; // Meteor 3 default first-in-order

  const transportEnv = process.env.DDP_TRANSPORT;
  const transport = transportEnv && transportEnv !== 'sockjs' ? transportEnv : 'sockjs';

  process.stderr.write(`[runtime-info] observer_driver=${observerDriver}\n`);
  process.stderr.write(`[runtime-info] transport=${transport}\n`);
}

Meteor.startup(() => {
  logRuntimeInfo();
  tryMonitorExtras();
  initializeTaskCollection();
  registerTaskApi();
});
