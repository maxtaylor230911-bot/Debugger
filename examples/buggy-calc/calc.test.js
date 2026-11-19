import { test } from "node:test";
import assert from "node:assert/strict";
import { average, median } from "./calc.js";

test("average of a list", () => {
  assert.equal(average([2, 4, 6]), 4);
});

test("average of an empty list is 0", () => {
  assert.equal(average([]), 0);
});

test("median of an odd-length list", () => {
  assert.equal(median([3, 1, 2]), 2);
});

test("median sorts numerically, not alphabetically", () => {
  assert.equal(median([10, 9, 2, 1]), 5.5);
});

test("median does not reorder the caller's array", () => {
  const input = [3, 1, 2];
  median(input);
  assert.deepEqual(input, [3, 1, 2]);
});
