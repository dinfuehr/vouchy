import type { ReviewComment, ReviewFile, ReviewResult, ReviewScope } from "./types.js";

function scopeLabel(scope: ReviewScope): string {
  switch (scope) {
    case "unstaged":
      return "unstaged changes";
    case "staged":
      return "staged changes";
    case "last-commit":
      return "last commit";
    case "branch":
      return "branch";
  }
}

function formatLocation(comment: ReviewComment): string {
  if (comment.side === "file" || comment.lineNumber == null) {
    return `${comment.filePath}`;
  }

  const suffix = comment.side === "old" ? "old" : "new";
  return `${comment.filePath}:${comment.lineNumber} (${suffix})`;
}

function changedFileSummary(files: ReviewFile[]): string[] {
  return files.map((file) => {
    const path = file.oldPath != null && file.oldPath !== file.path
      ? `${file.oldPath} -> ${file.path}`
      : file.path;
    return `- ${file.status}: ${path}`;
  });
}

export function composeReviewPrompt(result: ReviewResult): string {
  const lines: string[] = [];
  const overallComment = result.overallComment.trim();
  const comments = result.comments.filter((comment) => comment.body.trim().length > 0);

  lines.push("Please address the following diff review feedback.");
  lines.push("");
  lines.push(`Scope: ${scopeLabel(result.scope)}${result.baseRef != null ? ` against ${result.baseRef}` : ""}`);
  lines.push("");

  if (overallComment.length > 0) {
    lines.push("Overall feedback:");
    lines.push(overallComment);
    lines.push("");
  }

  if (comments.length > 0) {
    lines.push("Review comments:");
    comments.forEach((comment, index) => {
      lines.push(`${index + 1}. ${formatLocation(comment)}`);
      lines.push(`   ${comment.body.trim()}`);
      if (comment.diffLineText != null && comment.diffLineText.trim().length > 0) {
        lines.push(`   Diff line: ${comment.diffLineText}`);
      }
      lines.push("");
    });
  }

  if (overallComment.length === 0 && comments.length === 0) {
    lines.push("No specific comments were captured.");
    lines.push("");
  }

  lines.push("Changed files:");
  lines.push(...changedFileSummary(result.files));

  return lines.join("\n").trimEnd();
}
