import type { DiffLine } from "./types.js";

export function isChangeLine(line: DiffLine | undefined): boolean {
  return line?.kind === "add" || line?.kind === "remove";
}

export function isHunkLine(line: DiffLine | undefined): boolean {
  return line?.kind === "hunk";
}

export function isSearchableLine(line: DiffLine | undefined): boolean {
  return line?.kind === "add" || line?.kind === "remove" || line?.kind === "context";
}

export function findChangeGroupStart(lines: DiffLine[], selectedIndex: number, delta: 1 | -1): number | null {
  if (delta > 0) {
    for (let index = Math.max(0, selectedIndex + 1); index < lines.length; index += 1) {
      if (isChangeLine(lines[index]) && !isChangeLine(lines[index - 1])) {
        return index;
      }
    }
    return null;
  }

  for (let index = Math.min(lines.length - 1, selectedIndex - 1); index >= 0; index -= 1) {
    if (!isChangeLine(lines[index])) continue;
    while (index > 0 && isChangeLine(lines[index - 1])) {
      index -= 1;
    }
    return index;
  }

  return null;
}

export function findHunkStart(lines: DiffLine[], selectedIndex: number, delta: 1 | -1): number | null {
  if (delta > 0) {
    for (let index = Math.max(0, selectedIndex + 1); index < lines.length; index += 1) {
      if (isHunkLine(lines[index])) {
        return index;
      }
    }
    return null;
  }

  for (let index = Math.min(lines.length - 1, selectedIndex - 1); index >= 0; index -= 1) {
    if (isHunkLine(lines[index])) {
      return index;
    }
  }

  return null;
}

export function findHunkEnd(lines: DiffLine[], startIndex: number): number | null {
  if (!isHunkLine(lines[startIndex])) {
    return null;
  }

  let endIndex = startIndex;
  while (endIndex + 1 < lines.length && !isHunkLine(lines[endIndex + 1])) {
    endIndex += 1;
  }
  return endIndex;
}

export function findChangeGroupEnd(lines: DiffLine[], startIndex: number): number | null {
  if (!isChangeLine(lines[startIndex])) {
    return null;
  }

  let endIndex = startIndex;
  while (endIndex + 1 < lines.length && isChangeLine(lines[endIndex + 1])) {
    endIndex += 1;
  }
  return endIndex;
}

export function searchHitIndices(lines: DiffLine[], query: string): number[] {
  const needle = query.toLocaleLowerCase();
  if (needle.length === 0) return [];

  const hits: number[] = [];
  lines.forEach((line, index) => {
    if (isSearchableLine(line) && line.text.toLocaleLowerCase().includes(needle)) {
      hits.push(index);
    }
  });
  return hits;
}

export function findSearchHit(lines: DiffLine[], selectedIndex: number, query: string, delta: 1 | -1): number | null {
  const hits = searchHitIndices(lines, query);
  if (hits.length === 0) return null;

  if (delta > 0) {
    return hits.find((index) => index > selectedIndex) ?? hits[0] ?? null;
  }

  for (let index = hits.length - 1; index >= 0; index -= 1) {
    const hit = hits[index];
    if (hit != null && hit < selectedIndex) {
      return hit;
    }
  }

  return hits[hits.length - 1] ?? null;
}
