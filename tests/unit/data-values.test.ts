import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isJsonValue } from '../../lib/data-values.js';

class JsonShapedClass {
  readonly value = 'looks serializable';
}

describe('isJsonValue', () => {
  test('accepts plain and null-prototype JSON records', () => {
    const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, { value: 1 });
    assert.equal(isJsonValue({ nested: ['value', 1, true, null] }), true);
    assert.equal(isJsonValue(nullPrototype), true);
  });

  test('rejects instances whose serialization would erase type semantics', () => {
    assert.equal(isJsonValue(new Date('2026-08-07T00:00:00.000Z')), false);
    assert.equal(isJsonValue(new JsonShapedClass()), false);
  });
});
