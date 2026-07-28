import { createHash } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  truncate,
} from 'node:fs/promises';
import { dirname } from 'node:path';

/** Runtime ceiling shared with progress ingestion and artifact validation. */
export const PROGRESS_EVENT_MAX_BYTES = 4 * 1024;

/** Defensive ceiling for startup recovery through a single in-memory scan. */
export const PROGRESS_JOURNAL_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Error raised when a journal cannot be trusted as a contiguous event ledger.
 */
export class ProgressJournalCorruptionError extends Error {
  /**
   * Creates a corruption error with its one-based record coordinate.
   */
  constructor(message, { recordNumber = null, cause } = {}) {
    super(message, { cause });
    this.name = 'ProgressJournalCorruptionError';
    this.recordNumber = recordNumber;
  }
}

function assertSequence(event, expectedSequence, recordNumber) {
  if (!Number.isSafeInteger(event?.sequence) || event.sequence < 1) {
    throw new ProgressJournalCorruptionError(
      `Progress record ${recordNumber} has an invalid sequence`,
      { recordNumber },
    );
  }
  if (event.sequence !== expectedSequence) {
    throw new ProgressJournalCorruptionError(
      `Progress sequence gap at record ${recordNumber}: expected ${expectedSequence}, received ${event.sequence}`,
      { recordNumber },
    );
  }
}

async function validateRecord(validateEvent, event, recordNumber) {
  try {
    const validationResult = await validateEvent(event);
    if (validationResult === false) {
      throw new Error('validator returned false');
    }
  } catch (error) {
    throw new ProgressJournalCorruptionError(
      `Progress record ${recordNumber} failed runtime validation`,
      { recordNumber, cause: error },
    );
  }
}

async function parseCompleteRecord(line, recordNumber, validateEvent, expectedSequence) {
  let event;
  try {
    event = JSON.parse(line.toString('utf8'));
  } catch (error) {
    throw new ProgressJournalCorruptionError(
      `Progress record ${recordNumber} is not valid JSON`,
      { recordNumber, cause: error },
    );
  }
  await validateRecord(validateEvent, event, recordNumber);
  assertSequence(event, expectedSequence, recordNumber);
  return event;
}

async function recoverJournal({
  journalPath,
  validateEvent,
  maxEventBytes,
  maxJournalBytes,
}) {
  let contents;
  try {
    contents = await readFile(journalPath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        eventCount: 0,
        firstSequence: null,
        lastSequence: null,
        recoveredTornTail: false,
      };
    }
    throw error;
  }

  if (contents.byteLength > maxJournalBytes) {
    throw new ProgressJournalCorruptionError(
      `Progress journal exceeds ${maxJournalBytes} recovery bytes`,
    );
  }

  let cursor = 0;
  let recordNumber = 0;
  let lastSequence = null;
  while (cursor < contents.byteLength) {
    const newlineIndex = contents.indexOf(0x0a, cursor);
    if (newlineIndex === -1) break;

    recordNumber += 1;
    const line = contents.subarray(cursor, newlineIndex);
    if (line.byteLength === 0) {
      throw new ProgressJournalCorruptionError(
        `Progress record ${recordNumber} is empty`,
        { recordNumber },
      );
    }
    if (line.byteLength + 1 > maxEventBytes) {
      throw new ProgressJournalCorruptionError(
        `Progress record ${recordNumber} exceeds ${maxEventBytes} bytes`,
        { recordNumber },
      );
    }
    const event = await parseCompleteRecord(
      line,
      recordNumber,
      validateEvent,
      recordNumber,
    );
    lastSequence = event.sequence;
    cursor = newlineIndex + 1;
  }

  let recoveredTornTail = false;
  const tail = contents.subarray(cursor);
  if (tail.byteLength > 0) {
    if (tail.byteLength + 1 > maxEventBytes) {
      throw new ProgressJournalCorruptionError(
        `Progress tail exceeds ${maxEventBytes} bytes`,
        { recordNumber: recordNumber + 1 },
      );
    }
    let parsedTail;
    try {
      parsedTail = JSON.parse(tail.toString('utf8'));
    } catch {
      await truncate(journalPath, cursor);
      const recoveryHandle = await open(journalPath, 'r+');
      try {
        await recoveryHandle.sync();
      } finally {
        await recoveryHandle.close();
      }
      recoveredTornTail = true;
    }

    if (parsedTail !== undefined) {
      recordNumber += 1;
      await validateRecord(validateEvent, parsedTail, recordNumber);
      assertSequence(parsedTail, recordNumber, recordNumber);
      throw new ProgressJournalCorruptionError(
        `Progress record ${recordNumber} is complete but lacks its committed newline`,
        { recordNumber },
      );
    }
  }

  return {
    eventCount: recordNumber,
    firstSequence: recordNumber === 0 ? null : 1,
    lastSequence,
    recoveredTornTail,
  };
}

async function writeCompleteBuffer(fileHandle, buffer) {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const { bytesWritten } = await fileHandle.write(
      buffer,
      offset,
      buffer.byteLength - offset,
      null,
    );
    if (bytesWritten === 0) {
      throw new Error('Progress journal append made no forward progress');
    }
    offset += bytesWritten;
  }
}

/**
 * Crash-consistent append-only event journal for a single release audit.
 */
export class ProgressJournal {
  #fileHandle;
  #journalPath;
  #validateEvent;
  #maxEventBytes;
  #eventCount;
  #firstSequence;
  #lastSequence;
  #closed = false;

  constructor({
    fileHandle,
    journalPath,
    validateEvent,
    maxEventBytes,
    recovery,
  }) {
    this.#fileHandle = fileHandle;
    this.#journalPath = journalPath;
    this.#validateEvent = validateEvent;
    this.#maxEventBytes = maxEventBytes;
    this.#eventCount = recovery.eventCount;
    this.#firstSequence = recovery.firstSequence;
    this.#lastSequence = recovery.lastSequence;
    this.recoveredTornTail = recovery.recoveredTornTail;
  }

  /**
   * Opens an existing journal after strict contiguous recovery, or creates it.
   */
  static async open({
    journalPath,
    validateEvent,
    maxEventBytes = PROGRESS_EVENT_MAX_BYTES,
    maxJournalBytes = PROGRESS_JOURNAL_MAX_BYTES,
  }) {
    if (typeof journalPath !== 'string' || journalPath.length === 0) {
      throw new TypeError('journalPath must be a non-empty string');
    }
    if (typeof validateEvent !== 'function') {
      throw new TypeError('validateEvent must be a function');
    }
    if (!Number.isSafeInteger(maxEventBytes) || maxEventBytes < 1) {
      throw new TypeError('maxEventBytes must be a positive safe integer');
    }
    if (!Number.isSafeInteger(maxJournalBytes) || maxJournalBytes < maxEventBytes) {
      throw new TypeError('maxJournalBytes must be a safe integer at least maxEventBytes');
    }

    await mkdir(dirname(journalPath), { recursive: true });
    const recovery = await recoverJournal({
      journalPath,
      validateEvent,
      maxEventBytes,
      maxJournalBytes,
    });
    const fileHandle = await open(journalPath, 'a');
    return new ProgressJournal({
      fileHandle,
      journalPath,
      validateEvent,
      maxEventBytes,
      recovery,
    });
  }

  /** Highest committed sequence, or null for an empty journal. */
  get lastSequence() {
    return this.#lastSequence;
  }

  /** Number of complete, validated records in the journal. */
  get eventCount() {
    return this.#eventCount;
  }

  /**
   * Validates, appends, flushes, and fsyncs one event before returning it.
   */
  async append(event) {
    if (this.#closed) {
      throw new Error('Cannot append to a closed progress journal');
    }
    const recordNumber = this.#eventCount + 1;
    await validateRecord(this.#validateEvent, event, recordNumber);
    assertSequence(event, recordNumber, recordNumber);

    let serialized;
    try {
      serialized = JSON.stringify(event);
    } catch (error) {
      throw new TypeError('Progress event must be JSON serializable', { cause: error });
    }
    if (serialized === undefined) {
      throw new TypeError('Progress event must serialize to a JSON record');
    }
    const record = Buffer.from(`${serialized}\n`, 'utf8');
    if (record.byteLength > this.#maxEventBytes) {
      throw new RangeError(`Progress event exceeds ${this.#maxEventBytes} bytes`);
    }

    await writeCompleteBuffer(this.#fileHandle, record);
    await this.#fileHandle.sync();

    this.#eventCount = recordNumber;
    this.#firstSequence ??= event.sequence;
    this.#lastSequence = event.sequence;
    return event;
  }

  /**
   * Closes the journal and returns its immutable digest and sequence bounds.
   */
  async seal() {
    if (this.#closed) {
      throw new Error('Progress journal is already closed');
    }
    this.#closed = true;
    await this.#fileHandle.close();
    const contents = await readFile(this.#journalPath);
    return Object.freeze({
      algorithm: 'sha256',
      digest: createHash('sha256').update(contents).digest('hex'),
      byteLength: contents.byteLength,
      eventCount: this.#eventCount,
      firstSequence: this.#firstSequence,
      lastSequence: this.#lastSequence,
    });
  }

  /**
   * Closes without sealing, for abort paths that cannot finalize a manifest.
   */
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    await this.#fileHandle.close();
  }
}
