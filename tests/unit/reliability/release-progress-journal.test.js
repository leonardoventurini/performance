import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import {
  ProgressJournal,
  ProgressJournalCorruptionError,
} from '../../../reliability/release-audit/progress-journal.js';

const temporaryDirectories = [];

async function createJournalPath() {
  const directory = await mkdtemp(join(tmpdir(), 'release-progress-'));
  temporaryDirectories.push(directory);
  return join(directory, 'progress.ndjson');
}

function validateEvent(event) {
  if (
    !event
    || typeof event !== 'object'
    || !Number.isSafeInteger(event.sequence)
    || typeof event.kind !== 'string'
  ) {
    throw new TypeError('invalid progress event');
  }
  return true;
}

function event(sequence, kind = 'heartbeat') {
  return { auditId: 'audit-1', sequence, kind };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(
    (directory) => rm(directory, { recursive: true, force: true }),
  ));
});

describe('release audit progress journal', () => {
  test('durably appends contiguous events and seals digest bounds', async () => {
    const journalPath = await createJournalPath();
    const journal = await ProgressJournal.open({ journalPath, validateEvent });

    await journal.append(event(1, 'audit_started'));
    await journal.append(event(2));
    const seal = await journal.seal();
    const contents = await readFile(journalPath);

    assert.equal(contents.toString('utf8'), [
      JSON.stringify(event(1, 'audit_started')),
      JSON.stringify(event(2)),
      '',
    ].join('\n'));
    assert.deepEqual(seal, {
      algorithm: 'sha256',
      digest: createHash('sha256').update(contents).digest('hex'),
      byteLength: contents.byteLength,
      eventCount: 2,
      firstSequence: 1,
      lastSequence: 2,
    });
  });

  test('rejects a sequence gap before writing it', async () => {
    const journalPath = await createJournalPath();
    const journal = await ProgressJournal.open({ journalPath, validateEvent });

    await journal.append(event(1));
    await assert.rejects(
      journal.append(event(3)),
      (error) => (
        error instanceof ProgressJournalCorruptionError
        && /expected 2, received 3/.test(error.message)
      ),
    );
    await journal.close();

    assert.equal((await readFile(journalPath, 'utf8')).trim(), JSON.stringify(event(1)));
  });

  test('rejects interior corruption during recovery', async () => {
    const journalPath = await createJournalPath();
    await writeFile(journalPath, [
      JSON.stringify(event(1)),
      '{invalid-json}',
      JSON.stringify(event(3)),
      '',
    ].join('\n'));

    await assert.rejects(
      ProgressJournal.open({ journalPath, validateEvent }),
      (error) => (
        error instanceof ProgressJournalCorruptionError
        && error.recordNumber === 2
      ),
    );
  });

  test('rejects a complete invalid final record', async () => {
    const journalPath = await createJournalPath();
    await writeFile(journalPath, [
      JSON.stringify(event(1)),
      JSON.stringify({ sequence: 2 }),
      '',
    ].join('\n'));

    await assert.rejects(
      ProgressJournal.open({ journalPath, validateEvent }),
      /record 2 failed runtime validation/,
    );
  });

  test('truncates only an invalid unterminated tail and resumes contiguously', async () => {
    const journalPath = await createJournalPath();
    await writeFile(
      journalPath,
      `${JSON.stringify(event(1))}\n{"auditId":"audit-1","sequence":2`,
    );

    const journal = await ProgressJournal.open({ journalPath, validateEvent });
    assert.equal(journal.recoveredTornTail, true);
    assert.equal(journal.lastSequence, 1);
    await journal.append(event(2, 'case_started'));
    const seal = await journal.seal();

    assert.equal(seal.lastSequence, 2);
    assert.equal((await readFile(journalPath, 'utf8')), [
      JSON.stringify(event(1)),
      JSON.stringify(event(2, 'case_started')),
      '',
    ].join('\n'));
  });

  test('rejects a valid complete record missing its commit newline', async () => {
    const journalPath = await createJournalPath();
    await writeFile(journalPath, JSON.stringify(event(1)));

    await assert.rejects(
      ProgressJournal.open({ journalPath, validateEvent }),
      /complete but lacks its committed newline/,
    );
  });

  test('applies the event byte ceiling during recovery', async () => {
    const journalPath = await createJournalPath();
    await writeFile(journalPath, `${JSON.stringify({
      ...event(1),
      detail: 'x'.repeat(100),
    })}\n`);

    await assert.rejects(
      ProgressJournal.open({
        journalPath,
        validateEvent,
        maxEventBytes: 64,
      }),
      /record 1 exceeds 64 bytes/,
    );
  });
});
