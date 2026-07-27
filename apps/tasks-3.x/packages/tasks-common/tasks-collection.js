import { Meteor } from "meteor/meteor";

export const TasksCollection = new Meteor.Collection('taskCollection');
export const ReliabilityCollection = new Meteor.Collection('reliabilityDocuments');

TasksCollection.allow({
  insert() { return true; },
  update() { return true; },
  remove() { return true; },
});
