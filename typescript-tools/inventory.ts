import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listFiles } from './files.js';

const ALLOWED_JAVASCRIPT = new Set([
  'bench.js',
  'apps/tasks-3.x/packages/bench-monitors/package.js',
  'apps/tasks-3.x/packages/tasks-common/package.js',
  'apps/dashboard/rspack.config.js',
]);

const IGNORED_SEGMENTS = new Set(['.git', '.meteor', '.typescript-tools', '_build', 'dist', 'node_modules', 'playwright-report', 'results']);
const NEGATIVE_FIXTURE_ROOT = 'types/type-tests/compile-negative/';
const TYPESCRIPT_EXTENSIONS = /\.(?:cts|mts|tsx?|d\.ts)$/;
const TYPESCRIPT_SUPPRESSION = new RegExp(`@ts-(?:expect-${'error'}|ignore|nocheck)\\b`, 'g');
const TYPESCRIPT_CONFIG = /(?:^|\/)tsconfig(?:\.[^/]+)?\.json$/;
const TOOL_REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPESCRIPT_COMPILER = path.join(TOOL_REPOSITORY_ROOT, 'node_modules/typescript/bin/tsc');

interface InventoryViolation {
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

interface SourceToken {
  readonly text: string;
  readonly start: number;
  readonly stringValue?: string;
}

interface SourceComment {
  readonly text: string;
  readonly start: number;
}

interface CompilerOwner {
  readonly config: string;
  readonly emits: boolean;
}

interface CompilerProject {
  readonly files: readonly string[];
  readonly noEmit: boolean;
}

function compilerProject(repositoryRoot: string, config: string): CompilerProject {
  const output = execFileSync(process.execPath, [TYPESCRIPT_COMPILER, '--showConfig', '--project', config], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  const value: unknown = JSON.parse(output);
  if (typeof value !== 'object' || value === null) throw new Error(`${config} produced an invalid compiler project`);
  const record = value as Record<string, unknown>;
  const files = record.files;
  const options = record.compilerOptions;
  if (files !== undefined && (!Array.isArray(files) || files.some((file) => typeof file !== 'string'))) {
    throw new Error(`${config} produced invalid compiler fileNames`);
  }
  const noEmit = typeof options === 'object' && options !== null
    && (options as Record<string, unknown>).noEmit === true;
  return { files: files === undefined ? [] : files, noEmit };
}

function repositoryPath(repositoryRoot: string, fileName: string): string | undefined {
  const relativePath = path.relative(repositoryRoot, path.resolve(fileName));
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) return undefined;
  return relativePath.split(path.sep).join('/');
}

function compilerOwnership(
  repositoryRoot: string,
  maintainedTypeScript: readonly string[],
  maintainedFiles: readonly string[],
): InventoryViolation[] {
  const owners = new Map<string, CompilerOwner[]>();
  for (const file of maintainedTypeScript) owners.set(file, []);

  const diagnostics: string[] = [];
  for (const config of maintainedFiles.filter((file) => (
    TYPESCRIPT_CONFIG.test(file) && !file.endsWith('tsconfig.base.json')
  ))) {
    let project: CompilerProject;
    try {
      project = compilerProject(repositoryRoot, config);
    } catch (error) {
      diagnostics.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    for (const fileName of project.files) {
      const relativePath = repositoryPath(repositoryRoot, path.join(repositoryRoot, path.dirname(config), fileName));
      if (relativePath === undefined) continue;
      const fileOwners = owners.get(relativePath);
      if (fileOwners === undefined) continue;
      fileOwners.push({
        config,
        emits: !project.noEmit && !relativePath.endsWith('.d.ts'),
      });
    }
  }

  const violations: InventoryViolation[] = diagnostics.map((message) => ({
    file: '<tsconfig>',
    line: 1,
    message,
  }));
  for (const [file, fileOwners] of owners) {
    if (fileOwners.length === 0) {
      violations.push({ file, line: 1, message: 'maintained TypeScript has no compiler project owner' });
      continue;
    }
    const emitOwners = fileOwners.filter((owner) => owner.emits);
    if (emitOwners.length > 1) {
      violations.push({
        file,
        line: 1,
        message: `maintained TypeScript has multiple emit owners: ${emitOwners.map((owner) => owner.config).join(', ')}`,
      });
    }
  }
  return violations;
}

function sourceComments(sourceText: string): SourceComment[] {
  const comments: SourceComment[] = [];
  let offset = 0;
  while (offset < sourceText.length) {
    const character = sourceText[offset];
    const next = sourceText[offset + 1];
    if (character === '/' && next === '/') {
      const end = sourceText.indexOf('\n', offset + 2);
      const boundedEnd = end === -1 ? sourceText.length : end;
      comments.push({ text: sourceText.slice(offset, boundedEnd), start: offset });
      offset = boundedEnd;
      continue;
    }
    if (character === '/' && next === '*') {
      const end = sourceText.indexOf('*/', offset + 2);
      const boundedEnd = end === -1 ? sourceText.length : end + 2;
      comments.push({ text: sourceText.slice(offset, boundedEnd), start: offset });
      offset = boundedEnd;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      const quote = character;
      offset += 1;
      while (offset < sourceText.length) {
        if (sourceText[offset] === '\\') offset += 2;
        else if (sourceText[offset] === quote) {
          offset += 1;
          break;
        } else offset += 1;
      }
      continue;
    }
    offset += 1;
  }
  return comments;
}

function tokenizeSource(sourceText: string): SourceToken[] {
  const tokens: SourceToken[] = [];
  let offset = 0;
  while (offset < sourceText.length) {
    const character = sourceText[offset];
    const next = sourceText[offset + 1];
    if (character === '/' && next === '/') {
      offset = sourceText.indexOf('\n', offset + 2);
      if (offset === -1) break;
      continue;
    }
    if (character === '/' && next === '*') {
      const end = sourceText.indexOf('*/', offset + 2);
      offset = end === -1 ? sourceText.length : end + 2;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      const quote = character;
      const start = offset;
      offset += 1;
      while (offset < sourceText.length) {
        if (sourceText[offset] === '\\') offset += 2;
        else if (sourceText[offset] === quote) {
          offset += 1;
          break;
        } else offset += 1;
      }
      if (quote !== '`') tokens.push({
        text: sourceText.slice(start, offset),
        start,
        stringValue: sourceText.slice(start + 1, Math.max(start + 1, offset - 1)),
      });
      continue;
    }
    if (character !== undefined && /[A-Za-z_$]/.test(character)) {
      const start = offset;
      offset += 1;
      while (offset < sourceText.length && /[A-Za-z0-9_$]/.test(sourceText[offset] ?? '')) offset += 1;
      tokens.push({ text: sourceText.slice(start, offset), start });
      continue;
    }
    if (character !== undefined && '!(){}[].,;:=?'.includes(character)) tokens.push({ text: character, start: offset });
    offset += 1;
  }
  return tokens;
}

function lineAt(sourceText: string, offset: number): number {
  return sourceText.slice(0, offset).split('\n').length;
}

function resolvesIntoDist(repositoryRoot: string, sourcePath: string, specifier: string): boolean {
  if (specifier === 'dist' || specifier.startsWith('dist/')) return true;
  if (!specifier.startsWith('.')) return false;
  const sourceDirectory = path.dirname(path.join(repositoryRoot, sourcePath));
  const resolved = path.resolve(sourceDirectory, specifier);
  const distRoot = path.join(repositoryRoot, 'dist');
  return resolved === distRoot || resolved.startsWith(`${distRoot}${path.sep}`);
}

function scanTypeScript(repositoryRoot: string, relativePath: string, sourceText: string): InventoryViolation[] {
  const violations: InventoryViolation[] = [];
  const tokens = tokenizeSource(sourceText);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) continue;
    if (token.text === 'any') {
      violations.push({ file: relativePath, line: lineAt(sourceText, token.start), message: 'explicit any is forbidden' });
    }
    if (token.text === '!') {
      const next = tokens[index + 1];
      const prefix = sourceText.slice(0, token.start).trimEnd();
      const previousCharacter = prefix.at(-1);
      const postfix = previousCharacter !== undefined
        && !'([{:;,=!?&|'.includes(previousCharacter)
        && !prefix.endsWith('=>')
        && !prefix.endsWith('#')
        && !/\b(?:return|case|throw|yield|await)$/.test(prefix)
        && next?.text !== '=';
      if (postfix) violations.push({ file: relativePath, line: lineAt(sourceText, token.start), message: 'non-null assertions are forbidden' });
    }
    if (token.text === 'as'
      && tokens[index + 1]?.text === 'unknown'
      && tokens[index + 2]?.text === 'as') {
      violations.push({ file: relativePath, line: lineAt(sourceText, token.start), message: 'double type assertions are forbidden' });
    }
    if (token.stringValue !== undefined) {
      const previous = tokens[index - 1];
      const dynamicImport = previous?.text === '(' && tokens[index - 2]?.text === 'import';
      if ((previous?.text === 'from' || previous?.text === 'import' || dynamicImport)
        && resolvesIntoDist(repositoryRoot, relativePath, token.stringValue)) {
        violations.push({ file: relativePath, line: lineAt(sourceText, token.start), message: 'source imports from dist are forbidden' });
      }
    }
  }

  for (const comment of sourceComments(sourceText)) {
    for (const match of comment.text.matchAll(TYPESCRIPT_SUPPRESSION)) {
      const directive = match[0];
      const offset = comment.start + match.index;
      const line = lineAt(sourceText, offset);
      if (directive !== `@ts-expect-${'error'}` || !relativePath.startsWith(NEGATIVE_FIXTURE_ROOT)) {
        violations.push({ file: relativePath, line, message: `${directive} is forbidden outside compile-negative fixtures` });
      }
    }
  }
  return violations;
}

function verifyNegativeFixtures(repositoryRoot: string, files: readonly string[]): InventoryViolation[] {
  const fixtureFiles = files.filter((file) => file.startsWith(NEGATIVE_FIXTURE_ROOT) && TYPESCRIPT_EXTENSIONS.test(file));
  if (fixtureFiles.length === 0) return [];
  try {
    execFileSync(process.execPath, [
      path.join(repositoryRoot, 'node_modules/typescript/bin/tsc'),
      '--ignoreConfig',
      '--strict', '--noEmit', '--skipLibCheck', 'false', '--target', 'ES2024',
      '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
      ...fixtureFiles.map((file) => path.join(repositoryRoot, file)),
    ], { cwd: repositoryRoot, encoding: 'utf8', stdio: 'pipe' });
    return [];
  } catch (error) {
    const output = error instanceof Error && 'stdout' in error ? String(error.stdout) : String(error);
    return [{ file: '<compile-negative>', line: 1, message: output.trim() || 'compile-negative fixture validation failed' }];
  }
}

/** Fails when maintained JavaScript remains outside the four required hosts. */
export async function verifySourceInventory(repositoryRoot: string): Promise<void> {
  const files = await listFiles(repositoryRoot);
  const maintained = files.filter((file) => !file.split('/').some((segment) => IGNORED_SEGMENTS.has(segment)));
  const unexpected = maintained.filter((file) => (
    /\.(?:c?js|jsx|mjs)$/.test(file)
    && !ALLOWED_JAVASCRIPT.has(file)
  ));
  if (unexpected.length > 0) {
    throw new Error(`unexpected maintained JavaScript:\n${unexpected.map((file) => `- ${file}`).join('\n')}`);
  }

  const violations: InventoryViolation[] = [];
  const maintainedTypeScript = maintained.filter((candidate) => (
    TYPESCRIPT_EXTENSIONS.test(candidate) && !candidate.startsWith(NEGATIVE_FIXTURE_ROOT)
  ));
  violations.push(...compilerOwnership(repositoryRoot, maintainedTypeScript, maintained));
  for (const file of maintained.filter((candidate) => TYPESCRIPT_EXTENSIONS.test(candidate))) {
    const sourceText = await readFile(path.join(repositoryRoot, file), 'utf8');
    violations.push(...scanTypeScript(repositoryRoot, file, sourceText));
  }
  violations.push(...verifyNegativeFixtures(repositoryRoot, maintained));
  if (violations.length > 0) {
    throw new Error(`strict TypeScript source inventory violations:\n${violations
      .map((violation) => `- ${violation.file}:${violation.line}: ${violation.message}`)
      .join('\n')}`);
  }
}

const defaultRepositoryRoot = TOOL_REPOSITORY_ROOT;
const repositoryRoot = path.resolve(process.argv[2] ?? defaultRepositoryRoot);
await verifySourceInventory(repositoryRoot);
console.log('Source inventory contains only the four declared JavaScript hosts.');
