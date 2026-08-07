import { ReliabilityCollection, TasksCollection } from './tasks-collection';
import { registerTaskApi  } from './tasks-api';

function initializeTaskCollection() {
  return TasksCollection;
}

export { ReliabilityCollection, TasksCollection, initializeTaskCollection, registerTaskApi };
