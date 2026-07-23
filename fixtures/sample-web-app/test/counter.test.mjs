import assert from 'node:assert/strict';
import test from 'node:test';
import { increment } from '../src/counter.mjs';

test('src/counter.mjs increments by exactly one', () => {
  assert.equal(increment(0), 1, 'src/counter.mjs must advance the counter from 0 to 1');
});
