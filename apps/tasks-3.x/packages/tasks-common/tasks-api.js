import { ReliabilityCollection, TasksCollection } from './tasks-common.client';

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
    Meteor.publish('reliability.documents', function publishReliabilityDocuments(runId) {
      if (typeof runId !== 'string' || runId.length < 1 || runId.length > 128) {
        throw new Meteor.Error('invalid-run-id', 'runId must be a non-empty string of at most 128 characters');
      }
      return ReliabilityCollection.find({ runId });
    });
  }
};
