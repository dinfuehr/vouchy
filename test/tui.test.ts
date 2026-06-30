import assert from "node:assert/strict";
import test from "node:test";
import { stripAnsi } from "../src/terminal.js";
import { DiffReviewTui } from "../src/tui.js";
import type { DiffLine, DiffLineKind, ReviewComment, ReviewFile, ReviewResult } from "../src/types.js";

function file(id: string): ReviewFile {
  return { id, path: `${id}.ts`, oldPath: null, status: "modified" };
}

function line(kind: DiffLineKind, text: string = kind): DiffLine {
  return { kind, text, oldLine: null, newLine: null };
}

function comment(): ReviewComment {
  return {
    id: "comment-1",
    filePath: "first.ts",
    scope: "unstaged",
    side: "new",
    lineNumber: 1,
    body: "Needs a closer look.",
    diffLineText: "+changed",
  };
}

interface TuiFixture {
  render: () => void;
  diffs: Map<string, { loading: boolean; lines: DiffLine[]; error: string | null }>;
  sources: Map<string, { loading: boolean; sources: null; error: string | null }>;
  comments: ReviewComment[];
  statusMessage: string;
  resolveResult: ((result: ReviewResult | null) => void) | null;
  selectedFileIndex: number;
  selectedLineIndex: number;
  diffScrollTop: number;
  moveHunk: (delta: 1 | -1) => Promise<void>;
  moveFile: (delta: number) => void;
  selectFileIndex: (index: number) => void;
  handleInput: (data: string) => void;
  renderDiff: (width: number, height: number, startRow: number, startColumn: number) => string[];
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

test("Home key variants select the first row", () => {
  for (const key of ["\x1b[H", "\x1bOH", "\x1b[1~", "\x1b[7~"]) {
    const review = reviewWithLoadedDiffs([file("first")]);
    review.selectedLineIndex = 4;

    review.handleInput(key);

    assert.equal(review.selectedLineIndex, 0, key);
  }
});

test("End key variants select the last row", () => {
  for (const key of ["\x1b[F", "\x1bOF", "\x1b[4~", "\x1b[8~"]) {
    const review = reviewWithLoadedDiffs([file("first")]);

    review.handleInput(key);

    assert.equal(review.selectedLineIndex, 4, key);
  }
});

test("opening another file selects its first hunk", () => {
  const review = reviewWithLoadedDiffs([file("first"), file("second")]);

  review.moveFile(1);

  assert.equal(review.selectedFileIndex, 1);
  assert.equal(review.selectedLineIndex, 1);
});

test("opening a loaded file without hunks keeps the first row selected", () => {
  const review = reviewWithLoadedDiffs([file("first")]);
  const state = review.diffs.get("first");
  assert.ok(state);
  state.lines = [
    line("file", "No textual diff for this file."),
  ];

  review.selectFileIndex(0);

  assert.equal(review.selectedLineIndex, 0);
});

test("diff lines wrap instead of truncating on narrow screens", () => {
  const review = reviewWithLoadedDiffs([file("first")]);
  const state = review.diffs.get("first");
  assert.ok(state);
  state.lines = [
    { kind: "add", text: "+abcdefghijklmnopqrstuvwxyz", oldLine: null, newLine: 42 },
  ];
  review.diffScrollTop = 0;

  const rows = review.renderDiff(18, 3, 3, 1).map(stripAnsi);

  assert.equal(rows[0], "   42 +abcdefghijk");
  assert.equal(rows[1], "      lmnopqrstuvw");
  assert.equal(rows[2], "      xyz         ");
});

test("q quits immediately when there are no comments", () => {
  const review = reviewWithLoadedDiffs([file("first")]);
  let result: ReviewResult | null | undefined;
  review.resolveResult = (nextResult) => {
    result = nextResult;
  };

  review.handleInput("q");

  assert.equal(result, null);
});

test("q asks for confirmation before quitting with comments", () => {
  const review = reviewWithLoadedDiffs([file("first")]);
  let result: ReviewResult | null | undefined;
  review.resolveResult = (nextResult) => {
    result = nextResult;
  };
  review.comments.push(comment());

  review.handleInput("q");

  assert.equal(result, undefined);
  assert.match(review.statusMessage, /discard 1 comment/);

  review.handleInput("n");

  assert.equal(result, undefined);
  assert.equal(review.statusMessage, "Quit cancelled.");

  review.handleInput("q");
  review.handleInput("y");

  assert.equal(result, null);
});
