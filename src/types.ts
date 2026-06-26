export type ReviewScope = "unstaged" | "staged" | "last-commit" | "branch";

export type ReviewFileStatus = "modified" | "added" | "deleted" | "renamed" | "copied" | "untracked" | "unknown";

export interface ReviewFile {
  id: string;
  path: string;
  oldPath: string | null;
  status: ReviewFileStatus;
  baseRef?: string;
}

export type DiffLineKind = "meta" | "file" | "hunk" | "context" | "add" | "remove";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

export type CommentSide = "old" | "new" | "file";

export interface ReviewComment {
  id: string;
  filePath: string;
  scope: ReviewScope;
  side: CommentSide;
  lineNumber: number | null;
  body: string;
  diffLineText: string | null;
}

export interface ReviewResult {
  repoRoot: string;
  scope: ReviewScope;
  baseRef?: string;
  files: ReviewFile[];
  overallComment: string;
  comments: ReviewComment[];
}
