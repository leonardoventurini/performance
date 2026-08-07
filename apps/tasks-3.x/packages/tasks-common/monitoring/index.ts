import { Meteor } from 'meteor/meteor';
import './ah';
import { EventLoopMonitor } from './elm';

if (Meteor.isServer) {
  const monitor = new EventLoopMonitor(100);
  monitor.start();
}

export {};
