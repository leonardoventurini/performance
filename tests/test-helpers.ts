import type { Page } from '@playwright/test';

const timeout = 120000;

interface TaskJourneyOptions {
  readonly page: Page;
  readonly reactive: boolean;
  readonly taskCount: number;
}

/** Runs the shared task creation and removal journey. */
const addAndRemoveTasks = async ({ page, reactive, taskCount }: TaskJourneyOptions): Promise<void> => {
  page.setDefaultTimeout(timeout);

  await page.goto(process.env.REMOTE_URL || 'http://localhost:3000/');
  await page.getByLabel(reactive ? 'Reactive' : 'No Reactive', { exact: true }).check();

  await page.getByRole('button', { name: 'Remove all tasks' }).click();

  const sessionId = await page.textContent('span#sessionId');

  const tasks = Array.from({ length: taskCount });
  let addedNum = 1;
  for await (const _addTask of tasks) {
    await page.getByRole('button', { name: 'Add task' }).click();
    await page.waitForSelector(`text="${sessionId} New Task ${addedNum}"`, { state: 'visible' });
    addedNum += 1;
  }
  let removedNum = 1;
  for await (const _removeTask of tasks) {
    await page.getByRole('button', { name: 'Remove task' }).click();
    await page.waitForSelector(`text="${sessionId} New Task ${removedNum}"`, { state: 'detached' });
    removedNum += 1;
  }

  await page.getByRole('button', { name: 'Remove all tasks' }).click();
};

/** Runs the task journey with reactive data enabled. */
async function reactiveAddAndRemoveTasks(page: Page): Promise<void> {
  const taskCount = parseFloat(process.env.TASK_COUNT ?? '20');
  await addAndRemoveTasks({ page, reactive: true, taskCount });
}

/** Runs the task journey with reactive data disabled. */
async function nonReactiveAddAndRemoveTasks(page: Page): Promise<void> {
  const taskCount = parseFloat(process.env.TASK_COUNT ?? '20');
  await addAndRemoveTasks({ page, reactive: false, taskCount });
}

export { reactiveAddAndRemoveTasks, nonReactiveAddAndRemoveTasks, addAndRemoveTasks };
