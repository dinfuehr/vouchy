import assert from "node:assert/strict";
import test from "node:test";
import { fuzzyMatch } from "../src/fuzzy.js";

test("fuzzyMatch matches substrings with contiguous indices", () => {
  const match = fuzzyMatch("src/navigation.ts", "nav");

  assert.notEqual(match, null);
  assert.deepEqual(match?.indices, [4, 5, 6]);
});

test("fuzzyMatch matches path subsequences", () => {
  const match = fuzzyMatch("src/navigation.ts", "snt");

  assert.notEqual(match, null);
  assert.deepEqual(match?.indices, [0, 4, 10]);
});

test("fuzzyMatch rejects missing characters", () => {
  assert.equal(fuzzyMatch("src/tui.ts", "xyz"), null);
});

test("fuzzyMatch returns all-match metadata for empty queries", () => {
  assert.deepEqual(fuzzyMatch("src/tui.ts", ""), { score: 0, indices: [] });
});
