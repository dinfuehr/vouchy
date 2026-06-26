import assert from "node:assert/strict";
import test from "node:test";
import { parseUnifiedDiff } from "../src/diff.js";

test("parseUnifiedDiff tracks old and new line numbers", () => {
  const lines = parseUnifiedDiff([
    "diff --git a/a.txt b/a.txt",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -2,3 +2,4 @@",
    " keep",
    "-old",
    "+new",
    "+extra",
    " tail",
  ].join("\n"));

  assert.equal(lines[4]?.kind, "context");
  assert.equal(lines[4]?.oldLine, 2);
  assert.equal(lines[4]?.newLine, 2);
  assert.equal(lines[5]?.kind, "remove");
  assert.equal(lines[5]?.oldLine, 3);
  assert.equal(lines[5]?.newLine, null);
  assert.equal(lines[6]?.kind, "add");
  assert.equal(lines[6]?.oldLine, null);
  assert.equal(lines[6]?.newLine, 3);
  assert.equal(lines[7]?.newLine, 4);
  assert.equal(lines[8]?.oldLine, 4);
  assert.equal(lines[8]?.newLine, 5);
});
