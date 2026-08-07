import { Meteor } from 'meteor/meteor';
import { FlowRouter } from 'meteor/ostrio:flow-router-extra';

// Layouts
import '../imports/ui/layouts/main.ts';

// Pages
import '../imports/ui/pages/dashboard.ts';
import '../imports/ui/pages/compare.ts';
import '../imports/ui/pages/trends.ts';
import '../imports/ui/pages/detail.ts';
import '../imports/ui/pages/scenario.ts';
import '../imports/ui/pages/audits.ts';

// Apply persisted theme before Blaze paints. Dark is the default.
Meteor.startup(() => {
  const saved = localStorage.getItem('meteor-bench-theme') || 'dark';
  document.documentElement.classList.toggle('dark', saved === 'dark');
});

// Routes
FlowRouter.route('/', {
  name: 'dashboard',
  action() {
    this.render('mainLayout', { content: 'dashboard' });
  },
});

FlowRouter.route('/compare', {
  name: 'compare',
  action() {
    this.render('mainLayout', { content: 'compare' });
  },
});

FlowRouter.route('/trends', {
  name: 'trends',
  action() {
    this.render('mainLayout', { content: 'trends' });
  },
});

FlowRouter.route('/audits', {
  name: 'audits',
  action() {
    this.render('mainLayout', { content: 'audits' });
  },
});

FlowRouter.route('/run/:id', {
  name: 'detail',
  action() {
    this.render('mainLayout', { content: 'detail' });
  },
});

FlowRouter.route('/scenario/:name', {
  name: 'scenario',
  action() {
    this.render('mainLayout', { content: 'scenario' });
  },
});
