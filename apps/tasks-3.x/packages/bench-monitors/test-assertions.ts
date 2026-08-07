/** Browser-safe assertion contract for package-owned Meteor tests. */
interface TestAssertions {
  equal(actual: unknown, expected: unknown): void;
  notEqual(actual: unknown, expected: unknown): void;
  deepEqual(actual: unknown, expected: unknown): void;
  throws(callback: () => unknown, pattern: RegExp): void;
}

/** Minimal assertion surface shared by package contract tests. */
export const assert: TestAssertions = Object.freeze({
  equal(actual: unknown, expected: unknown): void {
    if (!Object.is(actual, expected)) throw new Error(`expected ${String(expected)}, received ${String(actual)}`);
  },
  notEqual(actual: unknown, expected: unknown): void {
    if (Object.is(actual, expected)) throw new Error(`did not expect ${String(expected)}`);
  },
  deepEqual(actual: unknown, expected: unknown): void {
    const actualJson = JSON.stringify(actual);
    const expectedJson = JSON.stringify(expected);
    if (actualJson !== expectedJson) throw new Error(`expected ${expectedJson}, received ${actualJson}`);
  },
  throws(callback: () => unknown, pattern: RegExp): void {
    try {
      callback();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (pattern.test(message)) return;
      throw new Error(`expected error matching ${String(pattern)}, received ${message}`);
    }
    throw new Error(`expected callback to throw ${String(pattern)}`);
  },
});
