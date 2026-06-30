import assert from "node:assert/strict";
import test from "node:test";
import { DiffReviewTui } from "../src/tui.js";
import type { DiffLine, DiffLineKind, ReviewFile } from "../src/types.js";

function file(id: string): ReviewFile {
  return { id, path: `${id}.ts`, oldPath: null, status: "modified" };
}

function line(kind: DiffLineKind, text: string = kind): DiffLine {
  return { kind, text, oldLine: null, newLine: null };
}

interface TuiFixture {
  render: () => void;
  diffs: Map<string, { loading: boolean; lines: DiffLine[]; error: string | null }>;
  sources: Map<string, { loading: boolean; sources: null; error: string | null }>;
  selectedFileIndex: number;
  selectedLineIndex: number;
  moveHunk: (delta: 1 | -1) => Promise<void>;
}

function reviewWithLoadedDiffs(files: ReviewFile[]): TuiFixture {
  const review = new DiffReviewTui({ repoRoot: "/repo", scope: "unstaged", files }) as unknown as TuiFixture;
  review.render = () => undefined;

  for (const reviewFile of files) {
    review.diffs.set(reviewFile.id, {
      loading: false,
      lines: [
        line("file", `diff --git a/${reviewFile.path} b/${reviewFile.path}`),
        line("hunk", "@@ -1 +1 @@"),
        line("context"),
        line("hunk", "@@ -5 +5 @@"),
        line("add"),
      ],
      error: null,
    });
    review.sources.set(reviewFile.id, { loading: false, sources: null, error: null });
  }

  return review;
}

test("moveHunk wraps next from the last hunk to the first hunk", async () => {
  const review = reviewWithLoadedDiffs([file("first"), file("second")]);
  review.selectedFileIndex = 1;
  review.selectedLineIndex = 3;

  await review.moveHunk(1);

  assert.equal(review.selectedFileIndex, 0);
  assert.equal(review.selectedLineIndex, 1);
});

test("moveHunk wraps previous from the first hunk to the last hunk", async () => {
  const review = reviewWithLoadedDiffs([file("first"), file("second")]);
  review.selectedFileIndex = 0;
  review.selectedLineIndex = 1;

  await review.moveHunk(-1);

  assert.equal(review.selectedFileIndex, 1);
  assert.equal(review.selectedLineIndex, 3);
});
