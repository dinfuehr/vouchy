import assert from "node:assert/strict";
import test from "node:test";
import { deleteBackward, deleteForward, deleteToStart, deleteWordBackward, insertText, lineInputState, moveCursorBy } from "../src/line-input.js";

test("line input inserts and deletes at the cursor", () => {
  let state = lineInputState("abcd", 2);
  state = insertText(state, "XY");
  assert.deepEqual(state, { value: "abXYcd", cursor: 4 });

  state = deleteBackward(state);
  assert.deepEqual(state, { value: "abXcd", cursor: 3 });

  state = deleteForward(state);
  assert.deepEqual(state, { value: "abXd", cursor: 3 });
});

test("line input moves cursor within bounds", () => {
  let state = lineInputState("abc", 1);
  state = moveCursorBy(state, -5);
  assert.deepEqual(state, { value: "abc", cursor: 0 });

  state = moveCursorBy(state, 10);
  assert.deepEqual(state, { value: "abc", cursor: 3 });
});

test("line input ctrl-u deletes to start", () => {
  const state = deleteToStart(lineInputState("hello world", 6));
  assert.deepEqual(state, { value: "world", cursor: 0 });
});

test("line input ctrl-w deletes previous word and preceding spaces", () => {
  assert.deepEqual(deleteWordBackward(lineInputState("hello world", 11)), { value: "hello ", cursor: 6 });
  assert.deepEqual(deleteWordBackward(lineInputState("hello   world", 8)), { value: "world", cursor: 0 });
  assert.deepEqual(deleteWordBackward(lineInputState("hello   world", 13)), { value: "hello   ", cursor: 8 });
});
