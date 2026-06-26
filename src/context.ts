import type { DiffLine } from "./types.js";

export interface DiffSources {
  oldLines: string[] | null;
  newLines: string[] | null;
}

export interface HunkContext {
  before: number;
  after: number;
}

interface HunkInfo {
  ordinal: number;
  start: number;
  end: number;
  firstOld: number | null;
  lastOld: number | null;
  firstNew: number | null;
  lastNew: number | null;
}

type SourceSide = "old" | "new";

export function expandDiffContext(lines: DiffLine[], sources: DiffSources | null, contextForHunk: (hunkOrdinal: number) => HunkContext): DiffLine[] {
  if (sources == null || (sources.oldLines == null && sources.newLines == null)) {
    return lines;
  }

  const hunks = hunkInfos(lines);
  if (hunks.length === 0) {
    return lines;
  }

  const expanded: DiffLine[] = [];
  let nextHunk = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const hunk = hunks[nextHunk];
    if (hunk == null || index !== hunk.start) {
      const line = lines[index];
      if (line != null) expanded.push(line);
      continue;
    }

    const hunkLine = lines[index];
    if (hunkLine != null) expanded.push(hunkLine);

    const context = contextForHunk(hunk.ordinal);
    const before = Math.max(0, context.before);
    const after = Math.max(0, context.after);
    if (before > 0) {
      expanded.push(...contextBefore(hunk, hunks[nextHunk - 1] ?? null, sources, before));
    }

    for (let lineIndex = hunk.start + 1; lineIndex <= hunk.end; lineIndex += 1) {
      const line = lines[lineIndex];
      if (line != null) expanded.push(line);
    }

    if (after > 0) {
      expanded.push(...contextAfter(hunk, hunks[nextHunk + 1] ?? null, sources, after));
    }

    index = hunk.end;
    nextHunk += 1;
  }

  return expanded;
}

function hunkInfos(lines: DiffLine[]): HunkInfo[] {
  const starts: number[] = [];
  lines.forEach((line, index) => {
    if (line.kind === "hunk") starts.push(index);
  });

  return starts.map((start, ordinal) => {
    const end = (starts[ordinal + 1] ?? lines.length) - 1;
    const lineRange = lines.slice(start + 1, end + 1);
    const oldNumbers = lineRange.map((line) => line.oldLine).filter((line): line is number => line != null);
    const newNumbers = lineRange.map((line) => line.newLine).filter((line): line is number => line != null);

    return {
      ordinal,
      start,
      end,
      firstOld: oldNumbers[0] ?? null,
      lastOld: oldNumbers.at(-1) ?? null,
      firstNew: newNumbers[0] ?? null,
      lastNew: newNumbers.at(-1) ?? null,
    };
  });
}

function contextBefore(hunk: HunkInfo, previous: HunkInfo | null, sources: DiffSources, extra: number): DiffLine[] {
  const side = sourceSide(hunk, sources);
  if (side == null) return [];

  const firstLine = firstLineForSide(hunk, side);
  if (firstLine == null) return [];

  const sourceLines = sourceLinesForSide(sources, side);
  if (sourceLines == null) return [];

  const previousLast = previous == null ? null : lastLineForSide(previous, side);
  const existing = existingLinesForSide(hunk, side);
  const start = Math.max(1, previousLast == null ? 1 : previousLast + 1, firstLine - extra);
  const result: DiffLine[] = [];

  for (let lineNumber = start; lineNumber < firstLine; lineNumber += 1) {
    if (existing.has(lineNumber)) continue;
    const line = sourceContextLine(sourceLines, side, lineNumber);
    if (line != null) result.push(line);
  }

  return result;
}

function contextAfter(hunk: HunkInfo, next: HunkInfo | null, sources: DiffSources, extra: number): DiffLine[] {
  const side = sourceSide(hunk, sources);
  if (side == null) return [];

  const lastLine = lastLineForSide(hunk, side);
  if (lastLine == null) return [];

  const sourceLines = sourceLinesForSide(sources, side);
  if (sourceLines == null) return [];

  const nextFirst = next == null ? null : firstLineForSide(next, side);
  const existing = existingLinesForSide(hunk, side);
  const end = Math.min(sourceLines.length, nextFirst == null ? sourceLines.length : nextFirst - 1, lastLine + extra);
  const result: DiffLine[] = [];

  for (let lineNumber = lastLine + 1; lineNumber <= end; lineNumber += 1) {
    if (existing.has(lineNumber)) continue;
    const line = sourceContextLine(sourceLines, side, lineNumber);
    if (line != null) result.push(line);
  }

  return result;
}

function sourceSide(hunk: HunkInfo, sources: DiffSources): SourceSide | null {
  if (sources.newLines != null && (hunk.firstNew != null || hunk.lastNew != null)) return "new";
  if (sources.oldLines != null && (hunk.firstOld != null || hunk.lastOld != null)) return "old";
  return null;
}

function firstLineForSide(hunk: HunkInfo, side: SourceSide): number | null {
  return side === "new" ? hunk.firstNew : hunk.firstOld;
}

function lastLineForSide(hunk: HunkInfo, side: SourceSide): number | null {
  return side === "new" ? hunk.lastNew : hunk.lastOld;
}

function sourceLinesForSide(sources: DiffSources, side: SourceSide): string[] | null {
  return side === "new" ? sources.newLines : sources.oldLines;
}

function existingLinesForSide(hunk: HunkInfo, side: SourceSide): Set<number> {
  const result = new Set<number>();
  const first = firstLineForSide(hunk, side);
  const last = lastLineForSide(hunk, side);
  if (first == null || last == null) return result;
  for (let lineNumber = first; lineNumber <= last; lineNumber += 1) {
    result.add(lineNumber);
  }
  return result;
}

function sourceContextLine(sourceLines: string[], side: SourceSide, lineNumber: number): DiffLine | null {
  const text = sourceLines[lineNumber - 1];
  if (text == null) return null;
  return {
    kind: "context",
    text: ` ${text}`,
    oldLine: side === "old" ? lineNumber : null,
    newLine: side === "new" ? lineNumber : null,
  };
}
