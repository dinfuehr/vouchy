import type { DiffLine } from "./types.js";

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parseUnifiedDiff(diff: string): DiffLine[] {
  const lines = diff.replace(/\r\n/g, "\n").split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }

  const parsed: DiffLine[] = [];
  let oldLine: number | null = null;
  let newLine: number | null = null;

  for (const line of lines) {
    const hunk = HUNK_HEADER.exec(line);
    if (hunk != null) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      parsed.push({ kind: "hunk", text: line, oldLine: null, newLine: null });
      continue;
    }

    if (oldLine == null || newLine == null) {
      const kind = line.startsWith("diff --git") || line.startsWith("--- ") || line.startsWith("+++ ") ? "file" : "meta";
      parsed.push({ kind, text: line, oldLine: null, newLine: null });
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      parsed.push({ kind: "add", text: line, oldLine: null, newLine });
      newLine += 1;
      continue;
    }

    if (line.startsWith("-") && !line.startsWith("---")) {
      parsed.push({ kind: "remove", text: line, oldLine, newLine: null });
      oldLine += 1;
      continue;
    }

    if (line.startsWith(" ")) {
      parsed.push({ kind: "context", text: line, oldLine, newLine });
      oldLine += 1;
      newLine += 1;
      continue;
    }

    parsed.push({ kind: "meta", text: line, oldLine: null, newLine: null });
  }

  return parsed;
}
