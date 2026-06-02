// Main server entry. Re-exports every init function future tasks will
// add. Server/main.js imports from here and calls each init in
// Meteor.startup, BEFORE any user code that registers Meteor APIs.

import { initMethodTiming } from './method-timing.server';

export { initMethodTiming };
