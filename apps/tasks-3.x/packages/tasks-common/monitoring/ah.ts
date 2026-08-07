import * as async_hooks from 'node:async_hooks';
import * as fs from 'node:fs';

export const AHCapture = {
  active: false,
}

const asyncResources = new Map<string, ResourceInfo>();

interface ResourceInfo { count: number; types: Set<string> }
interface ResourceLog { count: number; types: string[]; stack: string }

function logResourceCreation(type: string): void {
  const stack = (new Error()).stack?.split('\n').slice(2).filter((line) => {
    return !['AsyncHook.init', 'node:internal/async_hooks'].some(fn => line.includes(fn));
  }).join('\n') ?? 'stack unavailable';

  if (!asyncResources.has(stack)) {
    asyncResources.set(stack, { count: 0, types: new Set() });
  }

  const resourceInfo = asyncResources.get(stack) as ResourceInfo;
  resourceInfo.count++;
  resourceInfo.types.add(type);
}

const hooks = async_hooks.createHook({
  init(_asyncId, type) {
    if (!AHCapture.active) {
      return;
    }

    logResourceCreation(type);
  },
});

hooks.enable();

function printResults(): void {
  let logs: ResourceLog[] = [];

  asyncResources.forEach((info: ResourceInfo, stack: string) => {
    if (info.count <= 1) {
      return;
    }

    logs.push({
      count: info.count,
      types: [...info.types],
      stack,
    });
  });

  logs = logs.sort((a, b) => b.count - a.count);

  console.log(process.cwd())

  fs.writeFileSync('async-resources.json', JSON.stringify(logs, null, 2));
}

// Set up an interval to print results periodically
setInterval(printResults, 5000);
