import assert from "node:assert/strict";
import test from "node:test";
import { expandDiffContext } from "../src/context.js";
import { parseUnifiedDiff } from "../src/diff.js";

test("expandDiffContext adds source-backed context around one hunk", () => {
  const diff = [
    "@@ -20 +20 @@",
    "-line 20",
    "+changed line 20",
  ].join("\n");
  const lines = parseUnifiedDiff(diff);
  const oldLines = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`);
  const newLines = [...oldLines];
  newLines[19] = "changed line 20";

  const expanded = expandDiffContext(lines, { oldLines, newLines }, () => ({ before: 3, after: 3 }));
  const rendered = expanded.map((line) => line.text);

  assert.deepEqual(rendered.slice(0, 4), [
    "@@ -20 +20 @@",
    " line 17",
    " line 18",
    " line 19",
  ]);
  assert.deepEqual(rendered.slice(-3), [
    " line 21",
    " line 22",
    " line 23",
  ]);
});

test("expandDiffContext can show zero context", () => {
  const diff = [
    "@@ -20 +20 @@",
    "-line 20",
    "+changed line 20",
  ].join("\n");
  const lines = parseUnifiedDiff(diff);
  const oldLines = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`);
  const newLines = [...oldLines];
  newLines[19] = "changed line 20";

  const expanded = expandDiffContext(lines, { oldLines, newLines }, () => ({ before: 0, after: 0 }));

  assert.deepEqual(expanded.map((line) => line.text), [
    "@@ -20 +20 @@",
    "-line 20",
    "+changed line 20",
  ]);
});

test("expandDiffContext supports one-sided context", () => {
  const diff = [
    "@@ -20 +20 @@",
    "-line 20",
    "+changed line 20",
  ].join("\n");
  const lines = parseUnifiedDiff(diff);
  const oldLines = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`);
  const newLines = [...oldLines];
  newLines[19] = "changed line 20";

  const expanded = expandDiffContext(lines, { oldLines, newLines }, () => ({ before: 2, after: 0 }));

  assert.deepEqual(expanded.map((line) => line.text), [
    "@@ -20 +20 @@",
    " line 18",
    " line 19",
    "-line 20",
    "+changed line 20",
  ]);
});
