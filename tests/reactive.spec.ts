import { test } from '@playwright/test';
import { reactiveAddAndRemoveTasks } from './test-helpers.js';

test('reactive', async ({ page }) => {
  await reactiveAddAndRemoveTasks(page);
});
