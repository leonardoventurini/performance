import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import { Meteor } from 'meteor/meteor';
import { initializeTaskCollection, registerTaskApi, App } from 'meteor/tasks-common';

Meteor.startup(() => {
  initializeTaskCollection();
  registerTaskApi();

  const container = document.getElementById('react-target');
  if (!container) throw new Error('react-target container is required');
  const root = createRoot(container);
  root.render(createElement(App));
});
