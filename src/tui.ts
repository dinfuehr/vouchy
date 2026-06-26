import { expandDiffContext, type DiffSources, type HunkContext } from "./context.js";
import { parseUnifiedDiff } from "./diff.js";
import { fuzzyMatch } from "./fuzzy.js";
import { getFileDiff, getFileSources } from "./git.js";
import { deleteBackward, deleteForward, deleteToStart, deleteWordBackward, insertText, lineInputState, moveCursorBy, moveCursorToEnd, moveCursorToStart, type LineInputState } from "./line-input.js";
import { findHunkEnd, findHunkStart, findSearchHit, isSearchableLine, searchHitIndices } from "./navigation.js";
import { ansi, color, formatStatus, isPrintableInput, moveCursor, padRight, truncate, visibleLength } from "./terminal.js";
import type { CommentSide, DiffLine, ReviewComment, ReviewFile, ReviewResult, ReviewScope } from "./types.js";

interface DiffReviewTuiOptions {
  repoRoot: string;
  scope: ReviewScope;
  files: ReviewFile[];
  comparisonLabel?: string;
}

type InputMode = "review" | "comment" | "overall" | "search" | "file-picker" | "help";

interface DiffState {
  loading: boolean;
  lines: DiffLine[];
  error: string | null;
}

interface SourceState {
  loading: boolean;
  sources: DiffSources | null;
  error: string | null;
}

type DiffViewRow =
  | { type: "line"; lineIndex: number; line: DiffLine }
  | { type: "comment"; lineIndex: number; comment: ReviewComment }
  | { type: "new-comment-input"; lineIndex: number }
  | { type: "edit-comment-input"; lineIndex: number; comment: ReviewComment };

type SelectableDiffRow =
  | { type: "line"; lineIndex: number }
  | { type: "comment"; lineIndex: number; commentId: string };

interface FilePickerMatch {
  file: ReviewFile;
  fileIndex: number;
  score: number;
  indices: number[];
}

const EMPTY_DIFF: DiffState = {
  loading: false,
  lines: [{ kind: "meta", text: "No textual diff for this file.", oldLine: null, newLine: null }],
  error: null,
};

const HUNK_DEFAULT_CONTEXT = 3;
const HUNK_CONTEXT_STEP = 3;

export class DiffReviewTui {
  private readonly repoRoot: string;
  private readonly scope: ReviewScope;
  private readonly files: ReviewFile[];
  private readonly comparisonLabel: string | null;
  private readonly diffs = new Map<string, DiffState>();
  private readonly diffLoads = new Map<string, Promise<void>>();
  private readonly sources = new Map<string, SourceState>();
  private readonly sourceLoads = new Map<string, Promise<void>>();
  private readonly hunkContext = new Map<string, HunkContext>();
  private readonly comments: ReviewComment[] = [];
  private nextCommentId = 1;
  private selectedFileIndex = 0;
  private selectedLineIndex = 0;
  private selectedCommentId: string | null = null;
  private editingCommentId: string | null = null;
  private diffScrollTop = 0;
  private fileScrollTop = 0;
  private mode: InputMode = "review";
  private inputState: LineInputState = lineInputState();
  private inputScrollLeft = 0;
  private numericPrefix = "";
  private filePickerSelectedIndex = 0;
  private filePickerScrollTop = 0;
  private overallComment = "";
  private searchQuery = "";
  private statusMessage = "";
  private inputCursorRow = 1;
  private inputCursorColumn = 1;
  private resolveResult: ((result: ReviewResult | null) => void) | null = null;
  private previousRawMode = false;

  constructor(options: DiffReviewTuiOptions) {
    this.repoRoot = options.repoRoot;
    this.scope = options.scope;
    this.files = options.files;
    this.comparisonLabel = options.comparisonLabel ?? null;
  }

  async run(): Promise<ReviewResult | null> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error("vouchy requires an interactive TTY.");
    }

    this.previousRawMode = process.stdin.isRaw ?? false;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdout.write(`${ansi.enterAlt}${ansi.hideCursor}${ansi.clear}`);

    process.stdin.on("data", this.handleInput);
    process.stdout.on("resize", this.render);

    void this.ensureCurrentDiff();
    void this.ensureAllDiffs();
    this.render();

    return new Promise<ReviewResult | null>((resolve) => {
      this.resolveResult = resolve;
    }).finally(() => {
      process.stdin.off("data", this.handleInput);
      process.stdout.off("resize", this.render);
      process.stdin.setRawMode(this.previousRawMode);
      process.stdin.pause();
      process.stdout.write(`${ansi.defaultCursor}${ansi.showCursor}${ansi.exitAlt}`);
    });
  }

  private readonly handleInput = (data: string): void => {
    if (this.mode === "file-picker") {
      this.handleFilePickerInput(data);
      return;
    }

    if (this.mode === "comment" || this.mode === "overall" || this.mode === "search") {
      this.handleTextInput(data);
      return;
    }

    if (this.mode === "help") {
      if (data === "\x1b" || data === "?" || data === "q") {
        this.mode = "review";
        this.render();
      }
      return;
    }

    if (data === "\x03") {
      this.finish(null);
      return;
    }

    const command = this.reviewCommandFromInput(data);
    if (command == null) {
      return;
    }

    if (command !== "j" && command !== "k" && command !== "g") {
      this.clearNumericPrefix();
    }

    switch (command) {
      case "q":
        this.finish(null);
        break;
      case "\x1b":
        if (this.hasActiveSearch()) {
          this.searchQuery = "";
          this.statusMessage = "Cleared search.";
          this.render();
        } else {
          this.finish(null);
        }
        break;
      case "?":
        this.mode = "help";
        this.render();
        break;
      case "j":
        this.moveLine(this.takeNumericPrefix() ?? 1);
        break;
      case "\x1b[B":
        this.moveLine(1);
        break;
      case "k":
        this.moveLine(-(this.takeNumericPrefix() ?? 1));
        break;
      case "\x1b[A":
        this.moveLine(-1);
        break;
      case "\x1b[6~":
      case " ":
      case "f":
      case "\x06":
        this.moveLine(this.diffViewportHeight());
        break;
      case "\x1b[5~":
      case "b":
      case "\x02":
        this.moveLine(-this.diffViewportHeight());
        break;
      case "g":
        this.selectLineNumberOrFirstRow();
        this.clampDiffScroll();
        this.render();
        break;
      case "\x1b[H":
        this.selectFirstRow();
        this.clampDiffScroll();
        this.render();
        break;
      case "G":
      case "\x1b[F":
        this.selectLastRow();
        this.clampDiffScroll();
        this.render();
        break;
      case "]":
      case "\x1b[C":
        this.moveFile(1);
        break;
      case "[":
      case "\x1b[D":
        this.moveFile(-1);
        break;
      case "n":
        if (this.hasActiveSearch()) {
          void this.moveSearchHit(1);
        } else {
          void this.moveHunk(1);
        }
        break;
      case "p":
      case "N":
        if (this.hasActiveSearch()) {
          void this.moveSearchHit(-1);
        } else {
          void this.moveHunk(-1);
        }
        break;
      case "/":
        this.startSearch();
        break;
      case "F":
      case "\x10":
        this.startFilePicker();
        break;
      case "+":
        void this.changeCurrentHunkContext(HUNK_CONTEXT_STEP, HUNK_CONTEXT_STEP);
        break;
      case "-":
        void this.changeCurrentHunkContext(-HUNK_CONTEXT_STEP, -HUNK_CONTEXT_STEP);
        break;
      case "u":
        void this.changeCurrentHunkContext(HUNK_CONTEXT_STEP, 0);
        break;
      case "\x1bu":
        void this.changeCurrentHunkContext(-HUNK_CONTEXT_STEP, 0);
        break;
      case "d":
        if (this.selectedCommentId != null) {
          this.deleteSelectedComment();
        } else {
          void this.changeCurrentHunkContext(0, HUNK_CONTEXT_STEP);
        }
        break;
      case "\x1bd":
        void this.changeCurrentHunkContext(0, -HUNK_CONTEXT_STEP);
        break;
      case "=":
        void this.resetCurrentHunkContext();
        break;
      case "c":
        this.startComment();
        break;
      case "e":
        this.startEditSelectedComment();
        break;
      case "o":
        this.mode = "overall";
        this.editingCommentId = null;
        this.setInputValue(this.overallComment);
        this.render();
        break;
      case "S":
        this.submit();
        break;
      default:
        break;
    }
  };

  private reviewCommandFromInput(data: string): string | null {
    if (/^\d+$/.test(data)) {
      this.numericPrefix += data;
      return null;
    }

    const countedCommand = /^(\d+)(.+)$/s.exec(data);
    if (countedCommand != null) {
      this.numericPrefix += countedCommand[1] ?? "";
      return countedCommand[2] ?? "";
    }

    return data;
  }

  private takeNumericPrefix(): number | null {
    if (this.numericPrefix.length === 0) return null;

    const value = Number.parseInt(this.numericPrefix, 10);
    this.clearNumericPrefix();

    if (!Number.isFinite(value)) {
      return Number.MAX_SAFE_INTEGER;
    }

    return Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, value));
  }

  private clearNumericPrefix(): void {
    this.numericPrefix = "";
  }

  private handleTextInput(data: string): void {
    if (data === "\x03") {
      this.finish(null);
      return;
    }

    if (data === "\x1b") {
      this.mode = "review";
      this.editingCommentId = null;
      this.setInputValue("");
      this.render();
      return;
    }

    if (data === "\r" || data === "\n") {
      if (this.mode === "comment") {
        this.saveComment();
      } else if (this.mode === "overall") {
        this.overallComment = this.inputState.value.trim();
        this.statusMessage = this.overallComment.length > 0 ? "Saved overall feedback." : "Cleared overall feedback.";
      } else {
        void this.saveSearch();
        return;
      }
      this.mode = "review";
      this.editingCommentId = null;
      this.setInputValue("");
      this.render();
      return;
    }

    if (data === "\x1b[D" || data === "\x02") {
      this.inputState = moveCursorBy(this.inputState, -1);
      this.render();
      return;
    }

    if (data === "\x1b[C" || data === "\x06") {
      this.inputState = moveCursorBy(this.inputState, 1);
      this.render();
      return;
    }

    if (data === "\x1b[H" || data === "\x1b[1~" || data === "\x1bOH" || data === "\x01") {
      this.inputState = moveCursorToStart(this.inputState);
      this.render();
      return;
    }

    if (data === "\x1b[F" || data === "\x1b[4~" || data === "\x1bOF" || data === "\x05") {
      this.inputState = moveCursorToEnd(this.inputState);
      this.render();
      return;
    }

    if (data === "\x1b[3~" || data === "\x04") {
      this.inputState = deleteForward(this.inputState);
      this.render();
      return;
    }

    if (data === "\x15") {
      this.inputState = deleteToStart(this.inputState);
      this.render();
      return;
    }

    if (data === "\x17") {
      this.inputState = deleteWordBackward(this.inputState);
      this.render();
      return;
    }

    if (data === "\x7f" || data === "\b") {
      this.inputState = deleteBackward(this.inputState);
      this.render();
      return;
    }

    if (isPrintableInput(data)) {
      this.inputState = insertText(this.inputState, data);
      this.render();
    }
  }

  private handleFilePickerInput(data: string): void {
    if (data === "\x03") {
      this.finish(null);
      return;
    }

    if (data === "\x1b") {
      this.cancelFilePicker();
      return;
    }

    if (data === "\r" || data === "\n") {
      this.selectFilePickerMatch();
      return;
    }

    if (data === "\x1b[B" || data === "\x0e" || data === "\t") {
      this.moveFilePickerSelection(1);
      return;
    }

    if (data === "\x1b[A" || data === "\x10" || data === "\x1b[Z") {
      this.moveFilePickerSelection(-1);
      return;
    }

    if (data === "\x1b[6~") {
      this.moveFilePickerSelection(this.filePickerViewportHeight());
      return;
    }

    if (data === "\x1b[5~") {
      this.moveFilePickerSelection(-this.filePickerViewportHeight());
      return;
    }

    if (data === "\x1b[D" || data === "\x02") {
      this.inputState = moveCursorBy(this.inputState, -1);
      this.render();
      return;
    }

    if (data === "\x1b[C" || data === "\x06") {
      this.inputState = moveCursorBy(this.inputState, 1);
      this.render();
      return;
    }

    if (data === "\x1b[H" || data === "\x1b[1~" || data === "\x1bOH" || data === "\x01") {
      this.inputState = moveCursorToStart(this.inputState);
      this.render();
      return;
    }

    if (data === "\x1b[F" || data === "\x1b[4~" || data === "\x1bOF" || data === "\x05") {
      this.inputState = moveCursorToEnd(this.inputState);
      this.render();
      return;
    }

    if (data === "\x1b[3~" || data === "\x04") {
      this.updateFilePickerQuery(() => {
        this.inputState = deleteForward(this.inputState);
      });
      return;
    }

    if (data === "\x15") {
      this.updateFilePickerQuery(() => {
        this.inputState = deleteToStart(this.inputState);
      });
      return;
    }

    if (data === "\x17") {
      this.updateFilePickerQuery(() => {
        this.inputState = deleteWordBackward(this.inputState);
      });
      return;
    }

    if (data === "\x7f" || data === "\b") {
      this.updateFilePickerQuery(() => {
        this.inputState = deleteBackward(this.inputState);
      });
      return;
    }

    if (isPrintableInput(data)) {
      this.updateFilePickerQuery(() => {
        this.inputState = insertText(this.inputState, data);
      });
    }
  }

  private setInputValue(value: string): void {
    this.inputState = lineInputState(value);
    this.inputScrollLeft = 0;
  }

  private finish(result: ReviewResult | null): void {
    const resolve = this.resolveResult;
    if (resolve == null) return;
    this.resolveResult = null;
    resolve(result);
  }

  private submit(): void {
    this.finish({
      repoRoot: this.repoRoot,
      scope: this.scope,
      baseRef: this.currentFile()?.baseRef,
      files: this.files,
      overallComment: this.overallComment,
      comments: [...this.comments],
    });
  }

  private ensureCurrentDiff(): Promise<void> {
    const file = this.currentFile();
    if (file == null) return Promise.resolve();
    return Promise.all([this.ensureDiffForFile(file), this.ensureSourcesForFile(file)]).then(() => undefined);
  }

  private async ensureAllDiffs(): Promise<void> {
    for (const file of this.files) {
      await this.ensureDiffForFile(file);
    }
    this.render();
  }

  private ensureDiffForFile(file: ReviewFile): Promise<void> {
    const state = this.diffs.get(file.id);
    if (state != null && !state.loading) {
      return Promise.resolve();
    }

    const existingLoad = this.diffLoads.get(file.id);
    if (existingLoad != null) {
      return existingLoad;
    }

    this.diffs.set(file.id, { loading: true, lines: [], error: null });
    this.render();

    const load = (async () => {
      try {
        const diff = await getFileDiff(this.repoRoot, file, this.scope);
        const lines = parseUnifiedDiff(diff);
        this.diffs.set(file.id, lines.length > 0 ? { loading: false, lines, error: null } : EMPTY_DIFF);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.diffs.set(file.id, { loading: false, lines: [], error: message });
      } finally {
        this.diffLoads.delete(file.id);
      }

      if (this.currentFile()?.id === file.id) {
        this.clampLineIndex();
      }
      this.render();
    })();

    this.diffLoads.set(file.id, load);
    return load;
  }

  private ensureSourcesForFile(file: ReviewFile): Promise<void> {
    const state = this.sources.get(file.id);
    if (state != null && !state.loading) {
      return Promise.resolve();
    }

    const existingLoad = this.sourceLoads.get(file.id);
    if (existingLoad != null) {
      return existingLoad;
    }

    this.sources.set(file.id, { loading: true, sources: null, error: null });

    const load = (async () => {
      try {
        const sources = await getFileSources(this.repoRoot, file, this.scope);
        this.sources.set(file.id, { loading: false, sources, error: null });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.sources.set(file.id, { loading: false, sources: null, error: message });
      } finally {
        this.sourceLoads.delete(file.id);
      }

      if (this.currentFile()?.id === file.id) {
        this.clampLineIndex();
        this.render();
      }
    })();

    this.sourceLoads.set(file.id, load);
    return load;
  }

  private currentFile(): ReviewFile | null {
    return this.files[this.selectedFileIndex] ?? null;
  }

  private currentDiff(): DiffState {
    const file = this.currentFile();
    if (file == null) return EMPTY_DIFF;
    return this.diffs.get(file.id) ?? { loading: true, lines: [], error: null };
  }

  private currentRawLines(): DiffLine[] {
    const diff = this.currentDiff();
    if (diff.error != null) {
      return [{ kind: "meta", text: `Error: ${diff.error}`, oldLine: null, newLine: null }];
    }
    if (diff.loading) {
      return [{ kind: "meta", text: "Loading diff...", oldLine: null, newLine: null }];
    }
    return diff.lines;
  }

  private currentLines(): DiffLine[] {
    const file = this.currentFile();
    const rawLines = this.currentRawLines();
    if (file == null) return rawLines;

    const sourceState = this.sources.get(file.id);
    return expandDiffContext(rawLines, sourceState?.sources ?? null, (hunkOrdinal) => this.currentHunkContext(file, hunkOrdinal));
  }

  private diffRows(): DiffViewRow[] {
    const comments = this.currentFileComments();
    const rows: DiffViewRow[] = [];

    this.currentLines().forEach((line, lineIndex) => {
      rows.push({ type: "line", lineIndex, line });

      if (this.mode === "comment" && this.editingCommentId == null && lineIndex === this.selectedLineIndex) {
        rows.push({ type: "new-comment-input", lineIndex });
      }

      for (const comment of comments.get(this.commentKeyForLine(line)) ?? []) {
        if (this.mode === "comment" && this.editingCommentId === comment.id) {
          rows.push({ type: "edit-comment-input", lineIndex, comment });
        } else {
          rows.push({ type: "comment", lineIndex, comment });
        }
      }
    });

    return rows;
  }

  private selectableRows(): SelectableDiffRow[] {
    const rows: SelectableDiffRow[] = [];

    for (const row of this.diffRows()) {
      if (row.type === "line") {
        rows.push({ type: "line", lineIndex: row.lineIndex });
      } else if (row.type === "comment" || row.type === "edit-comment-input") {
        rows.push({ type: "comment", lineIndex: row.lineIndex, commentId: row.comment.id });
      }
    }

    return rows;
  }

  private selectedSelectableRowIndex(rows: SelectableDiffRow[]): number {
    if (this.selectedCommentId != null) {
      const commentIndex = rows.findIndex((row) => row.type === "comment" && row.commentId === this.selectedCommentId);
      if (commentIndex >= 0) {
        return commentIndex;
      }
      this.selectedCommentId = null;
    }

    const lineIndex = rows.findIndex((row) => row.type === "line" && row.lineIndex === this.selectedLineIndex);
    return lineIndex >= 0 ? lineIndex : 0;
  }

  private selectedViewRowIndex(rows: DiffViewRow[]): number {
    if (this.mode === "comment" && this.editingCommentId == null) {
      const inputIndex = rows.findIndex((row) => row.type === "new-comment-input" && row.lineIndex === this.selectedLineIndex);
      if (inputIndex >= 0) {
        return inputIndex;
      }
    }

    if (this.selectedCommentId != null) {
      const commentIndex = rows.findIndex((row) =>
        (row.type === "comment" || row.type === "edit-comment-input") && row.comment.id === this.selectedCommentId
      );
      if (commentIndex >= 0) {
        return commentIndex;
      }
      this.selectedCommentId = null;
    }

    const lineIndex = rows.findIndex((row) => row.type === "line" && row.lineIndex === this.selectedLineIndex);
    return lineIndex >= 0 ? lineIndex : 0;
  }

  private selectRow(row: SelectableDiffRow): void {
    this.selectedLineIndex = row.lineIndex;
    this.selectedCommentId = row.type === "comment" ? row.commentId : null;
    this.clampLineIndex();
  }

  private selectFirstRow(): void {
    const rows = this.selectableRows();
    if (rows.length === 0) {
      this.selectLine(0);
      return;
    }
    this.selectRow(rows[0]);
  }

  private selectLastRow(): void {
    const rows = this.selectableRows();
    if (rows.length === 0) {
      this.selectLine(Math.max(0, this.currentLines().length - 1));
      return;
    }
    this.selectRow(rows[rows.length - 1]);
  }

  private selectLineNumberOrFirstRow(): void {
    const lineNumber = this.takeNumericPrefix();
    if (lineNumber == null) {
      this.selectFirstRow();
      return;
    }

    this.selectClosestFileLine(lineNumber);
  }

  private selectClosestFileLine(targetLineNumber: number): void {
    const lines = this.currentLines();
    let bestIndex: number | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    lines.forEach((line, index) => {
      const lineNumber = this.fileLineNumber(line);
      if (lineNumber == null) return;

      const distance = Math.abs(lineNumber - targetLineNumber);
      if (distance < bestDistance) {
        bestIndex = index;
        bestDistance = distance;
      }
    });

    if (bestIndex == null) {
      this.selectFirstRow();
      return;
    }

    this.selectLine(bestIndex);
  }

  private fileLineNumber(line: DiffLine): number | null {
    if (line.kind === "remove") return line.oldLine;
    if (line.kind === "add" || line.kind === "context") return line.newLine ?? line.oldLine;
    return null;
  }

  private currentHunkOrdinal(): number | null {
    const lines = this.currentLines();
    let ordinal = -1;
    for (let index = 0; index <= this.selectedLineIndex && index < lines.length; index += 1) {
      if (lines[index]?.kind === "hunk") {
        ordinal += 1;
      }
    }
    return ordinal >= 0 ? ordinal : null;
  }

  private hunkStartIndexForOrdinal(ordinal: number): number | null {
    let current = -1;
    const lines = this.currentLines();
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index]?.kind !== "hunk") continue;
      current += 1;
      if (current === ordinal) return index;
    }
    return null;
  }

  private hunkContextKey(file: ReviewFile, hunkOrdinal: number): string {
    return `${file.id}:${hunkOrdinal}`;
  }

  private defaultHunkContext(): HunkContext {
    return { before: HUNK_DEFAULT_CONTEXT, after: HUNK_DEFAULT_CONTEXT };
  }

  private currentHunkContext(file: ReviewFile, hunkOrdinal: number): HunkContext {
    return this.hunkContext.get(this.hunkContextKey(file, hunkOrdinal)) ?? this.defaultHunkContext();
  }

  private setHunkContext(file: ReviewFile, hunkOrdinal: number, context: HunkContext): void {
    const key = this.hunkContextKey(file, hunkOrdinal);
    if (context.before === HUNK_DEFAULT_CONTEXT && context.after === HUNK_DEFAULT_CONTEXT) {
      this.hunkContext.delete(key);
      return;
    }
    this.hunkContext.set(key, context);
  }

  private async changeCurrentHunkContext(deltaBefore: number, deltaAfter: number): Promise<void> {
    const file = this.currentFile();
    const hunkOrdinal = this.currentHunkOrdinal();
    if (file == null || hunkOrdinal == null) {
      this.statusMessage = "Select a hunk to change context.";
      this.render();
      return;
    }

    const currentContext = this.currentHunkContext(file, hunkOrdinal);
    const nextContext = {
      before: Math.max(0, currentContext.before + deltaBefore),
      after: Math.max(0, currentContext.after + deltaAfter),
    };

    if (nextContext.before === currentContext.before && nextContext.after === currentContext.after) {
      this.statusMessage = `Hunk context is already ${currentContext.before} up / ${currentContext.after} down.`;
      this.render();
      return;
    }

    if (deltaBefore > 0 || deltaAfter > 0) {
      const state = this.sources.get(file.id);
      if (state == null || state.loading) {
        this.statusMessage = "Loading file context...";
        this.render();
        await this.ensureSourcesForFile(file);
      }

      const loaded = this.sources.get(file.id);
      if (loaded?.error != null) {
        this.statusMessage = `Could not load file context: ${loaded.error}`;
        this.render();
        return;
      }
      if (loaded?.sources == null || (loaded.sources.oldLines == null && loaded.sources.newLines == null)) {
        this.statusMessage = "No file context is available for this hunk.";
        this.render();
        return;
      }
    }

    this.setHunkContext(file, hunkOrdinal, nextContext);

    const startIndex = this.hunkStartIndexForOrdinal(hunkOrdinal);
    if (startIndex != null) {
      this.selectedLineIndex = startIndex;
      this.selectedCommentId = null;
    }

    this.statusMessage = `Hunk context set to ${nextContext.before} up / ${nextContext.after} down.`;
    this.clampDiffScroll();
    this.render();
  }

  private resetCurrentHunkContext(): void {
    const file = this.currentFile();
    const hunkOrdinal = this.currentHunkOrdinal();
    if (file == null || hunkOrdinal == null) {
      this.statusMessage = "Select a hunk to reset context.";
      this.render();
      return;
    }

    this.hunkContext.delete(this.hunkContextKey(file, hunkOrdinal));
    const startIndex = this.hunkStartIndexForOrdinal(hunkOrdinal);
    if (startIndex != null) {
      this.selectedLineIndex = startIndex;
      this.selectedCommentId = null;
    }
    this.statusMessage = "Hunk context reset to 3 lines.";
    this.clampDiffScroll();
    this.render();
  }

  private hasActiveSearch(): boolean {
    return this.searchQuery.length > 0;
  }

  private startSearch(): void {
    this.mode = "search";
    this.editingCommentId = null;
    this.setInputValue(this.searchQuery);
    this.render();
  }

  private async saveSearch(): Promise<void> {
    const query = this.inputState.value.trim();
    this.mode = "review";
    this.editingCommentId = null;
    this.setInputValue("");

    if (query.length === 0) {
      this.searchQuery = "";
      this.statusMessage = "Cleared search.";
      this.render();
      return;
    }

    this.searchQuery = query;
    this.statusMessage = "Searching...";
    this.render();
    await this.ensureCurrentDiff();

    const target = findSearchHit(this.currentLines(), this.selectedLineIndex - 1, this.searchQuery, 1);
    if (target == null) {
      this.statusMessage = "No search hits in this file.";
      this.render();
      return;
    }

    this.selectLine(target);
    this.statusMessage = "";
    this.render();
  }

  private async moveSearchHit(delta: 1 | -1): Promise<void> {
    if (!this.hasActiveSearch()) return;

    await this.ensureCurrentDiff();
    const target = findSearchHit(this.currentLines(), this.selectedLineIndex, this.searchQuery, delta);
    if (target == null) {
      this.statusMessage = "No search hits in this file.";
      this.render();
      return;
    }

    this.selectLine(target);
    this.statusMessage = "";
    this.render();
  }

  private startFilePicker(): void {
    this.mode = "file-picker";
    this.editingCommentId = null;
    this.selectedCommentId = null;
    this.setInputValue("");
    this.filePickerSelectedIndex = Math.max(0, this.selectedFileIndex);
    this.filePickerScrollTop = 0;
    this.clampFilePickerScroll();
    this.render();
  }

  private cancelFilePicker(): void {
    this.mode = "review";
    this.setInputValue("");
    this.statusMessage = "";
    this.render();
  }

  private selectFilePickerMatch(): void {
    const match = this.currentFilePickerMatch();
    if (match == null) {
      this.statusMessage = "No matching file.";
      this.render();
      return;
    }

    this.mode = "review";
    this.setInputValue("");
    this.statusMessage = "";
    this.selectFileIndex(match.fileIndex);
    this.render();
  }

  private updateFilePickerQuery(update: () => void): void {
    const previousMatch = this.currentFilePickerMatch();
    update();
    this.syncFilePickerSelection(previousMatch?.fileIndex ?? this.selectedFileIndex);
    this.render();
  }

  private syncFilePickerSelection(preferredFileIndex: number): void {
    const matches = this.filePickerMatches();
    if (matches.length === 0) {
      this.filePickerSelectedIndex = 0;
      this.filePickerScrollTop = 0;
      return;
    }

    const preferredIndex = matches.findIndex((match) => match.fileIndex === preferredFileIndex);
    this.filePickerSelectedIndex = preferredIndex >= 0 ? preferredIndex : 0;
    this.clampFilePickerScroll(matches.length);
  }

  private moveFilePickerSelection(delta: number): void {
    const matches = this.filePickerMatches();
    if (matches.length === 0) return;

    this.filePickerSelectedIndex = Math.max(0, Math.min(matches.length - 1, this.filePickerSelectedIndex + delta));
    this.clampFilePickerScroll(matches.length);
    this.render();
  }

  private currentFilePickerMatch(): FilePickerMatch | null {
    return this.filePickerMatches()[this.filePickerSelectedIndex] ?? null;
  }

  private filePickerMatches(): FilePickerMatch[] {
    const query = this.inputState.value.trim();
    if (query.length === 0) {
      return this.files.map((file, fileIndex) => ({ file, fileIndex, score: 0, indices: [] }));
    }

    const matches: FilePickerMatch[] = [];
    this.files.forEach((file, fileIndex) => {
      const match = fuzzyMatch(file.path, query);
      if (match == null) return;
      matches.push({ file, fileIndex, score: match.score, indices: match.indices });
    });

    return matches.sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path));
  }

  private clampFilePickerScroll(matchCount = this.filePickerMatches().length): void {
    const height = this.filePickerViewportHeight();
    if (this.filePickerSelectedIndex < this.filePickerScrollTop) {
      this.filePickerScrollTop = this.filePickerSelectedIndex;
    }
    if (this.filePickerSelectedIndex >= this.filePickerScrollTop + height) {
      this.filePickerScrollTop = this.filePickerSelectedIndex - height + 1;
    }
    this.filePickerScrollTop = Math.max(0, Math.min(Math.max(0, matchCount - height), this.filePickerScrollTop));
  }

  private filePickerViewportHeight(): number {
    return Math.max(1, this.layout().contentHeight - 1);
  }

  private moveLine(delta: number): void {
    const rows = this.selectableRows();
    if (rows.length === 0) return;

    const currentIndex = this.selectedSelectableRowIndex(rows);
    const nextIndex = Math.max(0, Math.min(rows.length - 1, currentIndex + delta));
    this.selectRow(rows[nextIndex]);
    this.clampDiffScroll();
    this.render();
  }

  private moveFile(delta: number): void {
    if (this.files.length === 0) return;
    this.selectFileIndex(this.selectedFileIndex + delta);
    this.render();
  }

  private selectFileIndex(index: number): void {
    if (this.files.length === 0) return;
    this.selectedFileIndex = Math.min(this.files.length - 1, Math.max(0, index));
    this.selectedLineIndex = 0;
    this.selectedCommentId = null;
    this.editingCommentId = null;
    this.diffScrollTop = 0;
    this.clampFileScroll();
    void this.ensureCurrentDiff();
  }

  private async moveHunk(delta: 1 | -1): Promise<void> {
    if (this.files.length === 0) return;

    const originalFileIndex = this.selectedFileIndex;
    const originalLineIndex = this.selectedLineIndex;
    const originalCommentId = this.selectedCommentId;
    const originalDiffScrollTop = this.diffScrollTop;
    const originalFileScrollTop = this.fileScrollTop;

    await this.ensureCurrentDiff();

    const currentTarget = findHunkStart(this.currentLines(), this.selectedLineIndex, delta);
    if (currentTarget != null) {
      this.selectHunk(currentTarget);
      this.statusMessage = "";
      this.render();
      return;
    }

    for (let fileIndex = this.selectedFileIndex + delta; fileIndex >= 0 && fileIndex < this.files.length; fileIndex += delta) {
      this.selectedFileIndex = fileIndex;
      this.selectedLineIndex = 0;
      this.selectedCommentId = null;
      this.diffScrollTop = 0;
      this.clampFileScroll();
      this.statusMessage = delta > 0 ? "Loading next file..." : "Loading previous file...";
      this.render();

      await this.ensureCurrentDiff();

      const lines = this.currentLines();
      const target = findHunkStart(lines, delta > 0 ? -1 : lines.length, delta);
      if (target != null) {
        this.selectHunk(target);
        this.statusMessage = "";
        this.render();
        return;
      }
    }

    this.selectedFileIndex = originalFileIndex;
    this.selectedLineIndex = originalLineIndex;
    this.selectedCommentId = originalCommentId;
    this.diffScrollTop = originalDiffScrollTop;
    this.fileScrollTop = originalFileScrollTop;
    this.statusMessage = delta > 0 ? "No next hunk." : "No previous hunk.";
    this.render();
  }

  private selectLine(index: number): void {
    this.selectedLineIndex = index;
    this.selectedCommentId = null;
    this.clampLineIndex();
    this.clampDiffScroll();
    this.clampFileScroll();
  }

  private selectHunk(startIndex: number): void {
    const lines = this.currentLines();
    const endIndex = findHunkEnd(lines, startIndex);
    if (endIndex == null) {
      this.selectLine(startIndex);
      return;
    }

    this.selectedLineIndex = startIndex;
    this.selectedCommentId = null;
    this.clampLineIndex();

    const height = this.diffViewportHeight();
    const rows = this.diffRows();
    const startRowIndex = rows.findIndex((row) => row.type === "line" && row.lineIndex === startIndex);
    const endRowIndex = rows.findIndex((row) => row.type === "line" && row.lineIndex === endIndex);
    const maxScrollTop = Math.max(0, rows.length - height);

    if (startRowIndex < 0 || endRowIndex < 0) {
      this.clampDiffScroll();
      this.clampFileScroll();
      return;
    }

    const hunkHeight = endRowIndex - startRowIndex + 1;

    if (hunkHeight >= height) {
      this.diffScrollTop = startRowIndex;
    } else {
      let scrollTop = Math.max(0, startRowIndex);
      if (scrollTop + height - 1 < endRowIndex) {
        scrollTop = endRowIndex - height + 1;
      }
      this.diffScrollTop = scrollTop;
    }

    this.diffScrollTop = Math.max(0, Math.min(maxScrollTop, this.diffScrollTop));
    this.clampFileScroll();
  }

  private clampLineIndex(): void {
    const max = Math.max(0, this.currentLines().length - 1);
    this.selectedLineIndex = Math.max(0, Math.min(max, this.selectedLineIndex));
  }

  private clampDiffScroll(): void {
    const height = this.diffViewportHeight();
    const rows = this.diffRows();
    const selectedRowIndex = this.selectedViewRowIndex(rows);
    const maxScrollTop = Math.max(0, rows.length - height);

    if (selectedRowIndex < this.diffScrollTop) {
      this.diffScrollTop = selectedRowIndex;
    }
    if (selectedRowIndex >= this.diffScrollTop + height) {
      this.diffScrollTop = selectedRowIndex - height + 1;
    }
    this.diffScrollTop = Math.max(0, Math.min(maxScrollTop, this.diffScrollTop));
  }

  private clampFileScroll(): void {
    const height = this.fileViewportHeight();
    if (this.selectedFileIndex < this.fileScrollTop) {
      this.fileScrollTop = this.selectedFileIndex;
    }
    if (this.selectedFileIndex >= this.fileScrollTop + height) {
      this.fileScrollTop = this.selectedFileIndex - height + 1;
    }
    this.fileScrollTop = Math.max(0, this.fileScrollTop);
  }

  private startComment(): void {
    const file = this.currentFile();
    if (file == null) return;
    this.mode = "comment";
    this.selectedCommentId = null;
    this.editingCommentId = null;
    this.setInputValue("");
    this.clampCommentInputScroll();
    this.render();
  }

  private clampCommentInputScroll(): void {
    this.clampDiffScroll();
  }

  private selectedComment(): ReviewComment | null {
    if (this.selectedCommentId == null) return null;
    return this.comments.find((comment) => comment.id === this.selectedCommentId) ?? null;
  }

  private startEditSelectedComment(): void {
    const comment = this.selectedComment();
    if (comment == null) {
      this.statusMessage = "Select a comment to edit.";
      this.render();
      return;
    }

    this.mode = "comment";
    this.editingCommentId = comment.id;
    this.setInputValue(comment.body);
    this.clampDiffScroll();
    this.render();
  }

  private deleteSelectedComment(): void {
    const comment = this.selectedComment();
    if (comment == null) {
      this.statusMessage = "Select a comment to delete.";
      this.selectedCommentId = null;
      this.render();
      return;
    }

    const index = this.comments.findIndex((candidate) => candidate.id === comment.id);
    if (index >= 0) {
      this.comments.splice(index, 1);
    }

    this.selectedCommentId = null;
    this.editingCommentId = null;
    this.statusMessage = "Deleted comment.";
    this.clampDiffScroll();
    this.render();
  }

  private selectedCommentTarget(): { side: CommentSide; lineNumber: number | null; text: string | null } {
    const line = this.currentLines()[this.selectedLineIndex];
    if (line == null) {
      return { side: "file", lineNumber: null, text: null };
    }

    if (line.kind === "remove") {
      return { side: "old", lineNumber: line.oldLine, text: line.text };
    }

    if (line.kind === "context" && line.newLine == null && line.oldLine != null) {
      return { side: "old", lineNumber: line.oldLine, text: line.text };
    }

    if (line.kind === "add" || line.kind === "context") {
      return { side: "new", lineNumber: line.newLine, text: line.text };
    }

    return { side: "file", lineNumber: null, text: line.text };
  }

  private saveComment(): void {
    const file = this.currentFile();
    const body = this.inputState.value.trim();
    if (file == null || body.length === 0) {
      this.statusMessage = "Skipped empty comment.";
      return;
    }

    if (this.editingCommentId != null) {
      const comment = this.comments.find((candidate) => candidate.id === this.editingCommentId);
      if (comment == null) {
        this.selectedCommentId = null;
        this.statusMessage = "Comment no longer exists.";
        return;
      }

      comment.body = body;
      this.selectedCommentId = comment.id;
      this.statusMessage = "Updated comment.";
      return;
    }

    const target = this.selectedCommentTarget();
    const comment: ReviewComment = {
      id: `comment-${this.nextCommentId++}`,
      filePath: file.oldPath != null && file.oldPath !== file.path ? `${file.oldPath} -> ${file.path}` : file.path,
      scope: this.scope,
      side: target.side,
      lineNumber: target.lineNumber,
      body,
      diffLineText: target.text,
    };
    this.comments.push(comment);
    this.selectedCommentId = comment.id;
    this.statusMessage = `Added comment ${this.comments.length}.`;
  }

  private currentCommentFilePath(): string | null {
    const file = this.currentFile();
    if (file == null) return null;
    return file.oldPath != null && file.oldPath !== file.path ? `${file.oldPath} -> ${file.path}` : file.path;
  }

  private commentKeyForLine(line: DiffLine): string {
    if (line.kind === "remove" && line.oldLine != null) {
      return `old:${line.oldLine}`;
    }
    if ((line.kind === "add" || line.kind === "context") && line.newLine != null) {
      return `new:${line.newLine}`;
    }
    return `file:${line.text}`;
  }

  private currentFileComments(): Map<string, ReviewComment[]> {
    const filePath = this.currentCommentFilePath();
    const comments = new Map<string, ReviewComment[]>();
    if (filePath == null) return comments;

    for (const comment of this.comments) {
      if (comment.filePath !== filePath || comment.scope !== this.scope) continue;
      const key = comment.side === "file" || comment.lineNumber == null
        ? `file:${comment.diffLineText ?? ""}`
        : `${comment.side}:${comment.lineNumber}`;
      const existing = comments.get(key);
      if (existing == null) {
        comments.set(key, [comment]);
      } else {
        existing.push(comment);
      }
    }

    return comments;
  }

  private terminalSize(): { width: number; height: number } {
    return {
      width: Math.max(40, process.stdout.columns ?? 100),
      height: Math.max(12, process.stdout.rows ?? 30),
    };
  }

  private layout(): { width: number; height: number; leftWidth: number; diffWidth: number; contentHeight: number } {
    const { width, height } = this.terminalSize();
    const footerHeight = this.mode === "overall"
      ? 3
      : this.mode === "file-picker" || this.mode === "comment" || this.mode === "search"
        ? 1
      : this.statusMessage.length > 0
        ? 2
        : 1;
    const contentHeight = Math.max(1, height - 3 - footerHeight);
    const leftWidth = width >= 84 ? Math.min(40, Math.max(24, Math.floor(width * 0.32))) : 0;
    const diffWidth = leftWidth > 0 ? width - leftWidth - 1 : width;
    return { width, height, leftWidth, diffWidth, contentHeight };
  }

  private diffViewportHeight(): number {
    return this.layout().contentHeight;
  }

  private fileViewportHeight(): number {
    return this.layout().contentHeight;
  }

  private readonly render = (): void => {
    const { width, height, leftWidth, diffWidth, contentHeight } = this.layout();
    this.clampLineIndex();
    this.clampDiffScroll();
    this.clampFileScroll();

    const lines: string[] = [];
    lines.push(this.renderHeader(width));
    lines.push(padRight("", width));
    if (this.mode === "help") {
      lines.push(...this.renderHelp(width, contentHeight));
    } else if (this.mode === "file-picker") {
      lines.push(...this.renderFilePicker(width, contentHeight));
    } else {
      const fileLines = leftWidth > 0 ? this.renderFileList(leftWidth, contentHeight) : [];
      const diffStartColumn = leftWidth > 0 ? leftWidth + 2 : 1;
      const diffLines = this.renderDiff(diffWidth, contentHeight, 3, diffStartColumn);

      for (let index = 0; index < contentHeight; index += 1) {
        if (leftWidth > 0) {
          lines.push(`${fileLines[index] ?? padRight("", leftWidth)} ${diffLines[index] ?? padRight("", diffWidth)}`);
        } else {
          lines.push(diffLines[index] ?? padRight("", diffWidth));
        }
      }
    }
    lines.push(padRight("", width));
    lines.push(...this.renderFooter(width));

    while (lines.length < height) {
      lines.push(padRight("", width));
    }

    const cursorControl = this.mode === "comment" || this.mode === "overall" || this.mode === "search" || this.mode === "file-picker"
      ? `${ansi.blinkingBarCursor}${ansi.showCursor}${moveCursor(this.inputCursorRow, this.inputCursorColumn)}`
      : ansi.hideCursor;
    process.stdout.write(`${ansi.clear}${lines.slice(0, height).join("\n")}${cursorControl}`);
  };

  private renderHeader(width: number): string {
    const file = this.currentFile();
    const filePart = file == null ? "file 0/0" : `file ${this.selectedFileIndex + 1}/${this.files.length}`;
    const pathPart = file == null ? "none" : file.path;
    const scopePart = this.comparisonLabel ?? `scope=${this.scope}`;
    const hunkPart = this.renderHunkProgress();
    const summary = `vouchy  ${scopePart}  ${filePart}  ${hunkPart}  ${pathPart}  comments=${this.comments.length}`;
    return padRight(color(truncate(summary, width), ansi.bold), width);
  }

  private renderHunkProgress(): string {
    const progress = this.hunkProgress();
    if (progress.total === 0 && !progress.complete) {
      return "hunk ...";
    }
    if (progress.total === 0) {
      return "hunk 0/0";
    }
    if (progress.current == null) {
      return progress.complete ? `hunk ?/${progress.total}` : "hunk ?/...";
    }
    return progress.complete ? `hunk ${progress.current}/${progress.total}` : `hunk ${progress.current}/...`;
  }

  private hunkProgress(): { current: number | null; total: number; complete: boolean } {
    let current: number | null = null;
    let total = 0;
    let complete = true;

    for (let fileIndex = 0; fileIndex < this.files.length; fileIndex += 1) {
      const file = this.files[fileIndex];
      if (file == null) continue;

      const state = this.diffs.get(file.id);
      if (state == null || state.loading) {
        complete = false;
        continue;
      }

      const lines = fileIndex === this.selectedFileIndex ? this.currentLines() : state.lines;
      const hunkStarts = this.hunkStarts(lines);
      if (fileIndex === this.selectedFileIndex) {
        const localIndex = this.currentLocalHunkIndex(hunkStarts);
        if (localIndex != null) {
          current = total + localIndex + 1;
        }
      }
      total += hunkStarts.length;
    }

    return { current, total, complete };
  }

  private hunkStarts(lines: DiffLine[]): number[] {
    const starts: number[] = [];
    lines.forEach((line, index) => {
      if (line.kind === "hunk") {
        starts.push(index);
      }
    });
    return starts;
  }

  private currentLocalHunkIndex(hunkStarts: number[]): number | null {
    if (hunkStarts.length === 0) return null;
    let currentIndex = 0;
    for (let index = 0; index < hunkStarts.length; index += 1) {
      if (hunkStarts[index] <= this.selectedLineIndex) {
        currentIndex = index;
      } else {
        break;
      }
    }
    return currentIndex;
  }

  private renderFileList(width: number, height: number): string[] {
    const lines: string[] = [];
    const visibleFiles = this.files.slice(this.fileScrollTop, this.fileScrollTop + height);

    for (let offset = 0; offset < height; offset += 1) {
      const file = visibleFiles[offset];
      if (file == null) {
        lines.push(padRight("", width));
        continue;
      }

      const index = this.fileScrollTop + offset;
      const marker = index === this.selectedFileIndex ? ">" : " ";
      const commentCount = this.comments.filter((comment) => comment.filePath.endsWith(file.path)).length;
      const suffix = commentCount > 0 ? ` (${commentCount})` : "";
      const text = `${marker} ${formatStatus(file.status)} ${file.path}${suffix}`;
      const rendered = index === this.selectedFileIndex
        ? color(padRight(text, width), ansi.reverse)
        : padRight(text, width);
      lines.push(rendered);
    }

    return lines;
  }

  private renderFilePicker(width: number, height: number): string[] {
    const matches = this.filePickerMatches();
    this.clampFilePickerScroll(matches.length);
    this.inputCursorRow = 3;
    const lines = [this.renderInputLine("FILE: ", width, 1)];
    const listHeight = Math.max(0, height - 1);

    if (matches.length === 0) {
      lines.push(padRight(color("No matching files.", ansi.dim), width));
      while (lines.length < height) {
        lines.push(padRight("", width));
      }
      return lines;
    }

    const visibleMatches = matches.slice(this.filePickerScrollTop, this.filePickerScrollTop + listHeight);
    lines.push(...visibleMatches.map((match, offset) =>
      this.renderFilePickerRow(match, width, this.filePickerScrollTop + offset === this.filePickerSelectedIndex)
    ));

    while (lines.length < height) {
      lines.push(padRight("", width));
    }
    return lines;
  }

  private renderFilePickerRow(match: FilePickerMatch, width: number, selected: boolean): string {
    const marker = selected ? ">" : match.fileIndex === this.selectedFileIndex ? "*" : " ";
    const prefix = `${marker} ${formatStatus(match.file.status)} `;
    const commentCount = this.commentCountForFile(match.file);
    const stats = this.diffStatsForFile(match.fileIndex);
    const addedText = stats == null ? "+..." : `+${stats.added}`;
    const removedText = stats == null ? "-..." : `-${stats.removed}`;
    const hunkText = stats == null ? "..." : `${stats.hunks}`;
    const commentLabel = commentCount === 1 ? "comment" : "comments";
    const hunkLabel = stats?.hunks === 1 ? "hunk" : "hunks";
    const suffix = `  ${addedText} ${removedText}  ${commentCount} ${commentLabel}  ${hunkText} ${hunkLabel}`;
    const pathWidth = Math.max(0, width - visibleLength(prefix) - visibleLength(suffix));
    const path = truncate(match.file.path, pathWidth);
    const styles = selected ? [ansi.reverse] : [];
    const rendered = [
      this.styleSegment(prefix, styles),
      this.renderMatchedPath(path, match.indices, selected),
      this.styleSegment(suffix, styles),
    ].join("");

    return this.padStyledRight(rendered, width, selected);
  }

  private renderMatchedPath(path: string, indices: number[], selected: boolean): string {
    if (indices.length === 0) {
      return this.styleSegment(path, selected ? [ansi.reverse] : []);
    }

    const indexSet = new Set(indices);
    const baseStyles = selected ? [ansi.reverse] : [];
    const hitStyles = selected ? [ansi.reverse, ansi.bold, ansi.yellow] : [ansi.bold, ansi.yellow];
    let rendered = "";
    let segment = "";
    let segmentIsHit: boolean | null = null;

    [...path].forEach((char, index) => {
      const isHit = indexSet.has(index);
      if (segmentIsHit == null || segmentIsHit === isHit) {
        segment += char;
        segmentIsHit = isHit;
        return;
      }

      rendered += this.styleSegment(segment, segmentIsHit ? hitStyles : baseStyles);
      segment = char;
      segmentIsHit = isHit;
    });

    if (segment.length > 0) {
      rendered += this.styleSegment(segment, segmentIsHit ? hitStyles : baseStyles);
    }
    return rendered;
  }

  private diffStatsForFile(fileIndex: number): { added: number; removed: number; hunks: number } | null {
    const file = this.files[fileIndex];
    if (file == null) return null;

    const state = this.diffs.get(file.id);
    if (state == null || state.loading || state.error != null) {
      return null;
    }
    let added = 0;
    let removed = 0;
    let hunks = 0;
    for (const line of state.lines) {
      if (line.kind === "add") {
        added += 1;
      } else if (line.kind === "remove") {
        removed += 1;
      } else if (line.kind === "hunk") {
        hunks += 1;
      }
    }
    return { added, removed, hunks };
  }

  private commentCountForFile(file: ReviewFile): number {
    return this.comments.filter((comment) => comment.filePath.endsWith(file.path)).length;
  }

  private renderDiff(width: number, height: number, startRow: number, startColumn: number): string[] {
    const rows = this.diffRows();
    const rendered: string[] = [];

    for (let rowIndex = this.diffScrollTop; rowIndex < rows.length && rendered.length < height; rowIndex += 1) {
      const row = rows[rowIndex];
      if (row == null) continue;

      if (row.type === "line") {
        rendered.push(this.renderDiffLine(row.line, width, row.lineIndex === this.selectedLineIndex && this.selectedCommentId == null));
        continue;
      }

      if (row.type === "new-comment-input" || row.type === "edit-comment-input") {
        this.inputCursorRow = startRow + rendered.length;
        rendered.push(this.renderInputLine("    › ", width, startColumn, ansi.yellow));
        continue;
      }

      rendered.push(this.renderCommentRow(row.comment, width));
    }

    while (rendered.length < height) {
      rendered.push(padRight("", width));
    }

    return rendered;
  }

  private renderCommentRow(comment: ReviewComment, width: number): string {
    const indent = "      ";
    const commentText = truncate(comment.body.trim(), Math.max(0, width - indent.length));
    const plain = padRight(`${indent}${commentText}`, width);

    if (this.selectedCommentId === comment.id) {
      return color(plain, `${ansi.reverse}${ansi.yellow}`);
    }

    return padRight(`${indent}${color(commentText, ansi.yellow)}`, width);
  }

  private formatLineNumber(line: DiffLine): string {
    if (line.kind === "add") return String(line.newLine ?? "").padStart(5, " ");
    if (line.kind === "remove") return String(line.oldLine ?? "").padStart(5, " ");
    if (line.kind === "context") return String(line.newLine ?? line.oldLine ?? "").padStart(5, " ");
    return "     ";
  }

  private renderDiffLine(line: DiffLine, width: number, selected: boolean): string {
    const lineNumber = this.formatLineNumber(line);
    const textWidth = Math.max(0, width - visibleLength(lineNumber) - 1);
    const text = truncate(line.text, textWidth);
    const searchHit = this.lineMatchesSearch(line);
    const numberStyles = this.diffLineStyles(line, selected);

    if (searchHit) {
      numberStyles.push(ansi.bold, ansi.yellow);
    }

    const rendered = [
      this.styleSegment(lineNumber, numberStyles),
      this.styleSegment(" ", selected ? [ansi.reverse] : []),
      this.renderDiffText(line, text, selected, searchHit),
    ].join("");

    return this.padStyledRight(rendered, width, selected);
  }

  private renderDiffText(line: DiffLine, text: string, selected: boolean, searchHit: boolean): string {
    if (!searchHit || this.searchQuery.length === 0) {
      return this.styleSegment(text, this.diffLineStyles(line, selected));
    }

    const needle = this.searchQuery.toLocaleLowerCase();
    const lowerText = text.toLocaleLowerCase();
    const baseStyles = this.diffLineStyles(line, selected);
    const hitStyles = selected ? [ansi.reverse, ansi.bold, ansi.yellow] : [ansi.bold, ansi.yellow];
    let rendered = "";
    let index = 0;

    while (index < text.length) {
      const matchIndex = lowerText.indexOf(needle, index);
      if (matchIndex < 0) {
        rendered += this.styleSegment(text.slice(index), baseStyles);
        break;
      }

      rendered += this.styleSegment(text.slice(index, matchIndex), baseStyles);
      rendered += this.styleSegment(text.slice(matchIndex, matchIndex + needle.length), hitStyles);
      index = matchIndex + needle.length;
    }

    return rendered;
  }

  private lineMatchesSearch(line: DiffLine): boolean {
    return this.hasActiveSearch() && isSearchableLine(line) && line.text.toLocaleLowerCase().includes(this.searchQuery.toLocaleLowerCase());
  }

  private diffLineStyles(line: DiffLine, selected: boolean): string[] {
    const styles = selected ? [ansi.reverse] : [];
    const lineColor = this.diffLineColor(line);
    if (lineColor != null) {
      styles.push(lineColor);
    }
    return styles;
  }

  private diffLineColor(line: DiffLine): string | null {
    if (line.kind === "add") return ansi.green;
    if (line.kind === "remove") return ansi.red;
    if (line.kind === "hunk") return ansi.cyan;
    if (line.kind === "meta" || line.kind === "file") return ansi.gray;
    return null;
  }

  private styleSegment(text: string, styles: string[]): string {
    if (text.length === 0) return "";
    if (styles.length === 0) return text;
    return `${styles.join("")}${text}${ansi.reset}`;
  }

  private padStyledRight(value: string, width: number, selected: boolean): string {
    const padding = " ".repeat(Math.max(0, width - visibleLength(value)));
    if (!selected || padding.length === 0) {
      return `${value}${padding}`;
    }
    return `${value}${ansi.reverse}${padding}${ansi.reset}`;
  }

  private renderFooter(width: number): string[] {
    if (this.mode === "comment") {
      return [padRight("Enter saves. Esc cancels. Ctrl-W word. Ctrl-U to start.", width)];
    }

    if (this.mode === "file-picker") {
      const matches = this.filePickerMatches();
      const summary = `${matches.length}/${this.files.length} files. Enter opens. Esc cancels. Up/Down or Ctrl-N/Ctrl-P choose.`;
      return [padRight(color(summary, ansi.dim), width)];
    }

    if (this.mode === "search") {
      const inputLine = this.renderInputLine("SEARCH: ", width, 1);
      this.inputCursorRow = this.terminalSize().height;
      return [inputLine];
    }

    if (this.mode === "overall") {
      const inputLine = this.renderInputLine("Overall › ", width, 1);
      this.inputCursorRow = this.terminalSize().height - 2;
      return [
        inputLine,
        padRight("Enter saves. Esc cancels. Ctrl-W word. Ctrl-U to start.", width),
        padRight("", width),
      ];
    }

    const help = this.hasActiveSearch()
      ? this.renderSearchFooterText()
      : "j/k move  n next  N/p prev  F/C-p files  / search  +/-/u/d context  [] file  c/e comment  o overall  S submit  q quit  ? help";
    if (this.statusMessage.length === 0) {
      return [padRight(help, width)];
    }

    return [
      padRight(help, width),
      padRight(color(this.statusMessage, ansi.dim), width),
    ];
  }

  private renderSearchFooterText(): string {
    const hits = searchHitIndices(this.currentLines(), this.searchQuery);
    const currentHit = hits.indexOf(this.selectedLineIndex);
    const progress = currentHit >= 0 ? `${currentHit + 1}/${hits.length}` : `${hits.length}`;
    const noun = hits.length === 1 ? "hit" : "hits";
    return `SEARCH: ${this.searchQuery}  ${progress} ${noun} in file`;
  }

  private renderInputLine(prefix: string, width: number, startColumn: number, inputColor?: string): string {
    const inputChars = [...this.inputState.value];
    const prefixWidth = visibleLength(prefix);
    const visibleInputWidth = Math.max(1, width - prefixWidth - 1);

    if (this.inputState.cursor < this.inputScrollLeft) {
      this.inputScrollLeft = this.inputState.cursor;
    }
    if (this.inputState.cursor > this.inputScrollLeft + visibleInputWidth) {
      this.inputScrollLeft = this.inputState.cursor - visibleInputWidth;
    }

    const visibleInput = inputChars.slice(this.inputScrollLeft, this.inputScrollLeft + visibleInputWidth).join("");
    this.inputCursorColumn = Math.max(startColumn, Math.min(startColumn + width - 1, startColumn + prefixWidth + (this.inputState.cursor - this.inputScrollLeft)));
    const renderedInput = inputColor != null ? color(visibleInput, inputColor) : visibleInput;
    return padRight(`${prefix}${renderedInput}`, width);
  }

  private renderHelp(width: number, height: number): string[] {
    const help = [
      "Keys",
      "",
      "j/down        move down",
      "k/up          move up",
      "Nj/Nk         move N selectable rows",
      "g             first row",
      "Ng            nearest displayed file line N",
      "G             last row",
      "f/space/C-f   page down",
      "b/C-b         page up",
      "n             next hunk, or next search hit when search is active",
      "N or p        previous hunk, or previous search hit when search is active",
      "F/C-p         fuzzy file picker",
      "/             search changed and context lines in current file",
      "+             add 3 context lines around current hunk",
      "-             remove 3 context lines from current hunk",
      "u             add 3 context lines above current hunk",
      "d             add 3 context lines below current hunk",
      "Alt-u         remove 3 context lines above current hunk",
      "Alt-d         remove 3 context lines below current hunk",
      "=             reset current hunk context to 3 lines",
      "]/right       next file",
      "[/left        previous file",
      "c             add comment on selected diff line",
      "e             edit selected comment",
      "d on comment  delete selected comment",
      "o             edit overall feedback",
      "S             submit and print feedback prompt",
      "q             cancel",
      "Esc           clear active search, otherwise cancel",
      "",
      "Comments on added/context lines target the new line. Comments on removed lines target the old line.",
      "The final prompt is printed after the TUI exits, so it can be pasted into or consumed by a coding agent.",
    ];
    return Array.from({ length: height }, (_, index) => padRight(help[index] ?? "", width));
  }
}
