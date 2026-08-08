import { Template, type TemplateStaticTyped } from 'meteor/templating';
import { ReactiveVar } from 'meteor/reactive-var';
import { FlowRouter } from 'meteor/ostrio:flow-router-extra';
import './main.html';

const THEME_KEY = 'meteor-bench-theme';
type Theme = 'dark' | 'light';
type MainLayoutState = Record<string, unknown> & { theme: ReactiveVar<Theme> };
const MainLayout = Template as TemplateStaticTyped<'mainLayout', unknown, MainLayoutState>;

const ACTIVE_CLASS =
  'flex items-center pl-5 pr-3 py-2 border-l-2 border-indigo-500 ' +
  'text-neutral-950 dark:text-neutral-100 bg-neutral-200/60 dark:bg-neutral-800/70';
const IDLE_CLASS =
  'flex items-center pl-5 pr-3 py-2 border-l-2 border-transparent ' +
  'text-neutral-700 dark:text-neutral-300 hover:text-neutral-950 dark:hover:text-neutral-100 ' +
  'hover:bg-neutral-200/40 dark:hover:bg-neutral-800/50 transition';

MainLayout.mainLayout.onCreated(function () {
  // Mirror the <html> class into a reactive var so the theme button label
  // updates the moment the user clicks it.
  this.theme = new ReactiveVar(
    typeof document !== 'undefined' &&
    document.documentElement.classList.contains('dark') ? 'dark' : 'light'
  );
});

MainLayout.mainLayout.helpers({
  navItemClass(routeName: string): string {
    return FlowRouter.getRouteName() === routeName ? ACTIVE_CLASS : IDLE_CLASS;
  },
  themeIcon() {
    // Sun in dark mode (click to switch to light), moon in light mode.
    return MainLayout.instance().theme.get() === 'dark' ? '☀' : '☾';
  },
});

MainLayout.mainLayout.events({
  'click .js-theme-toggle'(_event: Meteor.Event, instance): boolean {
    const current = instance.theme.get();
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.classList.toggle('dark', next === 'dark');
    localStorage.setItem(THEME_KEY, next);
    instance.theme.set(next);
    return false;
  },
});
