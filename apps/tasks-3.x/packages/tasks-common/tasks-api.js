import { ReliabilityCollection, TasksCollection } from './tasks-collection';
import { buildReliabilityCursorPlans } from './reliability-query-descriptors';

export const registerTaskApi = async () => {
  Meteor.methods({
    insertTask({ description, sessionId }) {
      return TasksCollection.insertAsync({
        sessionId,
        description,
        createdAt: new Date(),
      });
    },
    removeTask({ taskId }) {
      return TasksCollection.removeAsync({ _id: taskId });
    },
    removeAllTasks({ sessionId }) {
      return TasksCollection.removeAsync({ sessionId });
    },
    fetchTasks() {
      return TasksCollection.find({}).fetch();
    },
  });

  if (Meteor.isServer) {
    Meteor.publish('fetchTasks', function pubFetchTasks() {
      return TasksCollection.find({});
    });
    Meteor.publish('reliability.documents', function publishReliabilityDocuments(request) {
      let plans;
      try {
        plans = buildReliabilityCursorPlans(request);
      } catch (error) {
        throw new Meteor.Error('invalid-reliability-query', error.message);
      }

      const cursors = plans.map(({ selector, options }) => ReliabilityCollection.find(selector, options));
      return cursors.length === 1 ? cursors[0] : cursors;
    });
  }
};
