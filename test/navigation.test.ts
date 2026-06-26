import assert from "node:assert/strict";
import test from "node:test";
import { findChangeGroupEnd, findChangeGroupStart, findHunkEnd, findHunkStart, findSearchHit, searchHitIndices } from "../src/navigation.js";
import type { DiffLine, DiffLineKind } from "../src/types.js";

function line(kind: DiffLineKind, text: string = kind): DiffLine {
  return { kind, text, oldLine: null, newLine: null };
}

test("findChangeGroupStart jumps to group starts, not each changed line", () => {
  const lines = [
    line("context"),
    line("remove"),
    line("add"),
    line("context"),
    line("add"),
    line("add"),
    line("context"),
    line("remove"),
    line("remove"),
  ];

  assert.equal(findChangeGroupStart(lines, 0, 1), 1);
  assert.equal(findChangeGroupStart(lines, 1, 1), 4);
  assert.equal(findChangeGroupStart(lines, 2, 1), 4);
  assert.equal(findChangeGroupStart(lines, 4, 1), 7);
  assert.equal(findChangeGroupStart(lines, 8, 1), null);

  assert.equal(findChangeGroupStart(lines, 6, -1), 4);
  assert.equal(findChangeGroupStart(lines, 5, -1), 4);
  assert.equal(findChangeGroupStart(lines, 4, -1), 1);
  assert.equal(findChangeGroupStart(lines, 1, -1), null);
  assert.equal(findChangeGroupStart(lines, lines.length, -1), 7);
});

test("findChangeGroupEnd returns the end of a changed block", () => {
  const lines = [
    line("context"),
    line("remove"),
    line("add"),
    line("context"),
    line("add"),
    line("add"),
    line("context"),
  ];

  assert.equal(findChangeGroupEnd(lines, 0), null);
  assert.equal(findChangeGroupEnd(lines, 1), 2);
  assert.equal(findChangeGroupEnd(lines, 2), 2);
  assert.equal(findChangeGroupEnd(lines, 4), 5);
  assert.equal(findChangeGroupEnd(lines, 5), 5);
});

test("findHunkStart jumps between hunk headers", () => {
  const lines = [
    line("file"),
    line("hunk"),
    line("context"),
    line("remove"),
    line("add"),
    line("context"),
    line("hunk"),
    line("context"),
    line("add"),
    line("hunk"),
    line("remove"),
  ];

  assert.equal(findHunkStart(lines, 0, 1), 1);
  assert.equal(findHunkStart(lines, 1, 1), 6);
  assert.equal(findHunkStart(lines, 4, 1), 6);
  assert.equal(findHunkStart(lines, 8, 1), 9);
  assert.equal(findHunkStart(lines, 9, 1), null);

  assert.equal(findHunkStart(lines, 8, -1), 6);
  assert.equal(findHunkStart(lines, 6, -1), 1);
  assert.equal(findHunkStart(lines, 4, -1), 1);
  assert.equal(findHunkStart(lines, 1, -1), null);
  assert.equal(findHunkStart(lines, lines.length, -1), 9);
});

test("findHunkEnd returns the line before the next hunk", () => {
  const lines = [
    line("file"),
    line("hunk"),
    line("context"),
    line("add"),
    line("hunk"),
    line("remove"),
  ];

  assert.equal(findHunkEnd(lines, 0), null);
  assert.equal(findHunkEnd(lines, 1), 3);
  assert.equal(findHunkEnd(lines, 4), 5);
});

test("searchHitIndices only matches changed and context lines", () => {
  const lines = [
    line("file", "diff --git foo"),
    line("hunk", "@@ foo @@"),
    line("context", " context foo"),
    line("add", "+Foo"),
    line("remove", "-bar"),
    line("meta", "foo"),
  ];

  assert.deepEqual(searchHitIndices(lines, "foo"), [2, 3]);
  assert.deepEqual(searchHitIndices(lines, "bar"), [4]);
  assert.deepEqual(searchHitIndices(lines, ""), []);
});

test("findSearchHit moves between file-local hits with wrapping", () => {
  const lines = [
    line("context", " one"),
    line("add", "+needle"),
    line("context", " two"),
    line("remove", "-Needle"),
    line("context", " three"),
  ];

  assert.equal(findSearchHit(lines, 0, "needle", 1), 1);
  assert.equal(findSearchHit(lines, 1, "needle", 1), 3);
  assert.equal(findSearchHit(lines, 3, "needle", 1), 1);
  assert.equal(findSearchHit(lines, 3, "needle", -1), 1);
  assert.equal(findSearchHit(lines, 1, "needle", -1), 3);
  assert.equal(findSearchHit(lines, 0, "missing", 1), null);
});
