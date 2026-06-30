#!/usr/bin/env node
import { copyToClipboard } from "./clipboard.js";
import { storeSubmittedComments, takeStoredComments } from "./comment-store.js";
import { getCurrentBranch, getRepoRoot, selectReviewFilesWithOptions } from "./git.js";
import { composeReviewPrompt } from "./prompt.js";
import { DiffReviewTui } from "./tui.js";
import type { ReviewResult, ReviewScope } from "./types.js";

const VERSION = "0.1.0";

interface CliOptions {
  cwd: string;
  scope: ReviewScope | "auto";
  baseRef?: string;
  copy: boolean;
  takeComments: boolean;
  help: boolean;
  version: boolean;
}

function usage(): string {
  return [
    "Usage: vouchy [options]",
    "",
    "Options:",
    "  --scope <scope>  Review scope: auto, unstaged, staged, last-commit, branch/tracked (default: auto)",
    "  --base <ref>     Base ref for branch scope (default: current branch upstream)",
    "  --cwd <path>     Repository directory (default: current directory)",
    "  --copy           Copy the submitted prompt to the clipboard, best-effort (default)",
    "  --no-copy        Do not copy the submitted prompt to the clipboard",
    "  --take-comments  Print stored submitted comments for this repository and remove them",
    "  -h, --help       Show help",
    "  -v, --version    Show version",
    "",
    "Inside the TUI:",
    "  j/k scroll, Nj/Nk count, Ng go to nearest displayed file line, f/b page, n next, N/p previous, F/C-p files, / search, +/-/u/d hunk context, c/e comment, d deletes selected comment, o overall, S submit, q quit",
  ].join("\n");
}

function parseScope(value: string): ReviewScope | "auto" {
  if (value === "tracked") {
    return "branch";
  }
  if (value === "auto" || value === "unstaged" || value === "staged" || value === "last-commit" || value === "branch") {
    return value;
  }
  throw new Error(`Unknown scope '${value}'. Expected auto, unstaged, staged, last-commit, branch, or tracked.`);
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    cwd: process.cwd(),
    scope: "auto",
    copy: true,
    takeComments: false,
    help: false,
    version: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "-h":
      case "--help":
        options.help = true;
        break;
      case "-v":
      case "--version":
        options.version = true;
        break;
      case "--scope":
        options.scope = parseScope(argv[++index] ?? "");
        break;
      case "--base":
        options.baseRef = argv[++index] ?? "";
        if (options.baseRef.length === 0) {
          throw new Error("--base requires a git ref.");
        }
        options.scope = "branch";
        break;
      case "--cwd":
        options.cwd = argv[++index] ?? "";
        if (options.cwd.length === 0) {
          throw new Error("--cwd requires a path.");
        }
        break;
      case "--copy":
      case "--clipboard":
        options.copy = true;
        break;
      case "--no-copy":
      case "--no-clipboard":
        options.copy = false;
        break;
      case "--take-comments":
        options.takeComments = true;
        break;
      default:
        if (arg.startsWith("--scope=")) {
          options.scope = parseScope(arg.slice("--scope=".length));
        } else if (arg.startsWith("--base=")) {
          options.baseRef = arg.slice("--base=".length);
          if (options.baseRef.length === 0) {
            throw new Error("--base requires a git ref.");
          }
          options.scope = "branch";
        } else if (arg.startsWith("--cwd=")) {
          options.cwd = arg.slice("--cwd=".length);
        } else if (arg === "--copy=true" || arg === "--clipboard=true") {
          options.copy = true;
        } else if (arg === "--copy=false" || arg === "--clipboard=false") {
          options.copy = false;
        } else if (arg === "--take-comments=true") {
          options.takeComments = true;
        } else if (arg === "--take-comments=false") {
          options.takeComments = false;
        } else {
          throw new Error(`Unknown argument '${arg}'.`);
        }
    }
  }

  return options;
}

function hasSubmittedComments(result: ReviewResult): boolean {
  return result.overallComment.trim().length > 0 || result.comments.some((comment) => comment.body.trim().length > 0);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    console.log(usage());
    return;
  }

  if (options.version) {
    console.log(VERSION);
    return;
  }

  const repoRoot = await getRepoRoot(options.cwd);

  if (options.takeComments) {
    const comments = await takeStoredComments(repoRoot);
    if (comments.length === 0) {
      throw new Error(`No stored comments found for ${repoRoot}.`);
    }
    process.stdout.write(`${comments}\n`);
    return;
  }

  const selection = await selectReviewFilesWithOptions(repoRoot, options.scope, { baseRef: options.baseRef });
  const scope = selection.scope;
  const files = selection.files;
  if (files.length === 0) {
    const baseSuffix = scope === "branch" && options.baseRef != null
      ? ` against '${options.baseRef}'`
      : "";
    console.log(`No reviewable files found for scope '${scope}'${baseSuffix}.`);
    return;
  }

  const comparisonLabel = scope === "branch"
    ? `${await getCurrentBranch(repoRoot)} -> ${files[0]?.baseRef ?? options.baseRef ?? "base"}`
    : undefined;

  const result = await new DiffReviewTui({
    repoRoot,
    scope,
    files,
    comparisonLabel,
  }).run();

  if (result == null) {
    process.stderr.write("Review cancelled.\n");
    process.exitCode = 130;
    return;
  }

  const prompt = composeReviewPrompt(result);
  if (hasSubmittedComments(result)) {
    try {
      await storeSubmittedComments(repoRoot, prompt);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Could not save comments for --take-comments: ${message}\n`);
    }
  }

  if (options.copy) {
    const clipboard = copyToClipboard(prompt);
    if (clipboard.ok) {
      process.stderr.write(`Copied review prompt to clipboard${clipboard.method != null ? ` via ${clipboard.method}` : ""}.\n`);
    } else {
      process.stderr.write("Could not copy review prompt to clipboard.\n");
    }
  }

  console.log(prompt);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`vouchy: ${message}\n`);
  process.exitCode = 1;
});
