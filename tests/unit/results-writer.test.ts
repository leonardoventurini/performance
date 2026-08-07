import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeResult, appendToHistory } from '../../reporters/json-reporter.js';
import type { BenchmarkResult } from '../../reporters/json-reporter.js';

let tmpDir = '';

function makeResult(overrides: Partial<BenchmarkResult> = {}): BenchmarkResult {
  return {
    timestamp: '2026-08-07T00:00:00.000Z',
    tag: 't',
    meteor: { version: 'test', sha: 'test' },
    runtime: {},
    scenario: 's',
    app: 'a',
    wall_clock_ms: 1,
    metrics: {},
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-results-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('writeResult', () => {
  test('writes JSON file with trailing newline', () => {
    const outputPath = path.join(tmpDir, 'result.json');
    const result = makeResult();
    writeResult(result, outputPath);
    const raw = fs.readFileSync(outputPath, 'utf8');
    assert.ok(raw.endsWith('\n'), 'file ends with newline');
    assert.deepEqual(JSON.parse(raw), result);
  });

  test('creates nested parent directories when missing', () => {
    const outputPath = path.join(tmpDir, 'nested', 'deep', 'result.json');
    writeResult(makeResult(), outputPath);
    assert.ok(fs.existsSync(outputPath));
    assert.ok(fs.statSync(path.dirname(outputPath)).isDirectory());
  });

  test('overwrites an existing file', () => {
    const outputPath = path.join(tmpDir, 'result.json');
    writeResult(makeResult({ tag: 'first' }), outputPath);
    writeResult(makeResult({ tag: 'second' }), outputPath);
    assert.equal(JSON.parse(fs.readFileSync(outputPath, 'utf8')).tag, 'second');
  });

  test('pretty-prints with 2-space indentation', () => {
    const outputPath = path.join(tmpDir, 'result.json');
    writeResult(makeResult({ metrics: { gc: { metric: 'gc', count: 1 } } }), outputPath);
    const raw = fs.readFileSync(outputPath, 'utf8');
    assert.ok(raw.includes('\n  "scenario"'), 'top-level keys indented with 2 spaces');
    assert.ok(raw.includes('\n    "gc"'), 'nested keys indented with 4 spaces');
  });
});

describe('appendToHistory', () => {
  test('writes a file with the pattern <scenario>-<tag>-<timestamp>.json', () => {
    const result = makeResult({ scenario: 'reactive-light', tag: 'v3.5' });
    appendToHistory(result, tmpDir);
    const files = fs.readdirSync(tmpDir);
    assert.equal(files.length, 1);
    assert.match(files[0] ?? '', /^reactive-light-v3\.5-\d+\.json$/);
  });

  test('creates the history directory when missing', () => {
    const historyDir = path.join(tmpDir, 'new-history-dir');
    appendToHistory(makeResult(), historyDir);
    assert.ok(fs.existsSync(historyDir));
    assert.equal(fs.readdirSync(historyDir).length, 1);
  });

  test('two appends produce two distinct files', async () => {
    const result = makeResult();
    appendToHistory(result, tmpDir);
    await sleep(2); // guarantee Date.now() advances on fast machines
    appendToHistory(result, tmpDir);
    assert.equal(fs.readdirSync(tmpDir).length, 2);
  });

  test('written history file contents match the input result', () => {
    const result = makeResult({ metrics: { gc: { metric: 'gc', count: 1 } } });
    appendToHistory(result, tmpDir);
    const file = fs.readdirSync(tmpDir)[0];
    assert.ok(file);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(tmpDir, file), 'utf8')), result);
  });
});
