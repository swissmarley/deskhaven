import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describe, mean, sum } from '../src/stats.ts';

test('sum adds numbers', () => {
  assert.equal(sum([1, 2, 3]), 6);
  assert.equal(sum([]), 0);
});

test('mean averages numbers', () => {
  assert.equal(mean([2, 4]), 3);
  assert.equal(mean([5]), 5);
});

test('describe reports count, sum and mean', () => {
  assert.deepEqual(describe([1, 2, 3]), { count: 3, sum: 6, mean: 2 });
});
