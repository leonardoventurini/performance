import { test } from '@playwright/test';
import { nonReactiveAddAndRemoveTasks } from './test-helpers.js';

test('non-reactive', async ({ page }) => {
  await nonReactiveAddAndRemoveTasks(page);
});
