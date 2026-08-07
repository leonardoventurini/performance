import { ReliabilityCollection, TasksCollection } from './tasks-collection';
import { buildReliabilityCursorPlans } from './reliability-query-descriptors';
import { Meteor } from 'meteor/meteor';

interface TaskMutationRequest { description: string; sessionId: string }
interface TaskIdRequest { taskId: string }
interface SessionRequest { sessionId: string }

export const registerTaskApi = async () => {
  Meteor.methods({
    insertTask({ description, sessionId }: TaskMutationRequest) {
      return TasksCollection.insertAsync({
        sessionId,
        description,
        createdAt: new Date(),
      });
    },
    removeTask({ taskId }: TaskIdRequest) {
      return TasksCollection.removeAsync({ _id: taskId });
    },
    removeAllTasks({ sessionId }: SessionRequest) {
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
    Meteor.publish('reliability.documents', function publishReliabilityDocuments(request: unknown) {
      let plans;
      try {
        plans = buildReliabilityCursorPlans(request);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Meteor.Error('invalid-reliability-query', message);
      }

      const cursors = plans.map(({ selector, options }) => ReliabilityCollection.find(selector, options));
      return cursors.length === 1 ? cursors[0] : cursors;
    });
  }
};
