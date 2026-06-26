import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { DiffSources } from "./context.js";
import type { ReviewFile, ReviewFileStatus, ReviewScope } from "./types.js";

const execFileAsync = promisify(execFile);

interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

interface NameStatusEntry {
  status: ReviewFileStatus;
  path: string;
  oldPath: string | null;
}

async function git(args: string[], cwd: string, allowFailure = false): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
    if (allowFailure) {
      return {
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? err.message,
        code: typeof err.code === "number" ? err.code : 1,
      };
    }
    const message = (err.stderr ?? err.stdout ?? err.message).trim();
    throw new Error(message || `git ${args.join(" ")} failed`);
  }
}

export async function getRepoRoot(cwd: string): Promise<string> {
  const result = await git(["rev-parse", "--show-toplevel"], cwd);
  return result.stdout.trim();
}

export async function getCurrentBranch(repoRoot: string): Promise<string> {
  const branch = await git(["branch", "--show-current"], repoRoot, true);
  const branchName = branch.stdout.trim();
  if (branchName.length > 0) {
    return branchName;
  }

  const head = await git(["rev-parse", "--short", "HEAD"], repoRoot, true);
  const shortHead = head.stdout.trim();
  return shortHead.length > 0 ? shortHead : "HEAD";
}

async function hasHead(repoRoot: string): Promise<boolean> {
  const result = await git(["rev-parse", "--verify", "HEAD"], repoRoot, true);
  return result.code === 0;
}

function statusFromCode(code: string): ReviewFileStatus {
  switch (code) {
    case "M":
      return "modified";
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    default:
      return "unknown";
  }
}

function parseNameStatusZ(output: string): NameStatusEntry[] {
  const parts = output.split("\0").filter(Boolean);
  const entries: NameStatusEntry[] = [];

  for (let index = 0; index < parts.length;) {
    const rawStatus = parts[index++] ?? "";
    const code = rawStatus[0] ?? "";
    const status = statusFromCode(code);

    if (code === "R" || code === "C") {
      const oldPath = parts[index++] ?? null;
      const path = parts[index++] ?? null;
      if (oldPath != null && path != null) {
        entries.push({ status, path, oldPath });
      }
      continue;
    }

    const path = parts[index++] ?? null;
    if (path != null) {
      entries.push({ status, path, oldPath: code === "D" ? path : null });
    }
  }

  return entries;
}

function parseUntrackedZ(output: string): NameStatusEntry[] {
  return output
    .split("\0")
    .filter(Boolean)
    .map((path) => ({ status: "untracked" as const, path, oldPath: null }));
}

export interface ReviewListOptions {
  baseRef?: string;
}

export interface ReviewFileSelection {
  scope: ReviewScope;
  files: ReviewFile[];
}

function fileId(scope: ReviewScope, entry: NameStatusEntry, baseRef?: string): string {
  return `${scope}:${baseRef ?? ""}:${entry.status}:${entry.oldPath ?? ""}:${entry.path}`;
}

function toReviewFile(scope: ReviewScope, entry: NameStatusEntry, baseRef?: string): ReviewFile {
  return {
    id: fileId(scope, entry, baseRef),
    path: entry.path,
    oldPath: entry.oldPath,
    status: entry.status,
    baseRef,
  };
}

function splitFileLines(content: string): string[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

async function readWorktreeFile(repoRoot: string, path: string): Promise<string[] | null> {
  try {
    return splitFileLines(await readFile(join(repoRoot, path), "utf8"));
  } catch {
    return null;
  }
}

async function readGitObjectFile(repoRoot: string, ref: string, path: string): Promise<string[] | null> {
  const result = await git(["show", `${ref}:${path}`], repoRoot, true);
  if (result.code !== 0) return null;
  return splitFileLines(result.stdout);
}

async function readIndexFile(repoRoot: string, path: string): Promise<string[] | null> {
  const result = await git(["show", `:${path}`], repoRoot, true);
  if (result.code !== 0) return null;
  return splitFileLines(result.stdout);
}

function compareFiles(a: ReviewFile, b: ReviewFile): number {
  return a.path.localeCompare(b.path);
}

export async function listReviewFiles(repoRoot: string, scope: ReviewScope): Promise<ReviewFile[]> {
  return listReviewFilesWithOptions(repoRoot, scope, {});
}

export async function selectReviewFilesWithOptions(repoRoot: string, scope: ReviewScope | "auto", options: ReviewListOptions): Promise<ReviewFileSelection> {
  if (scope !== "auto") {
    return { scope, files: await listReviewFilesWithOptions(repoRoot, scope, options) };
  }

  const unstagedFiles = await listReviewFilesWithOptions(repoRoot, "unstaged", {});
  if (unstagedFiles.length > 0) {
    return { scope: "unstaged", files: unstagedFiles };
  }

  const stagedFiles = await listReviewFilesWithOptions(repoRoot, "staged", {});
  if (stagedFiles.length > 0) {
    return { scope: "staged", files: stagedFiles };
  }

  try {
    const branchFiles = await listReviewFilesWithOptions(repoRoot, "branch", options);
    if (branchFiles.length > 0) {
      return { scope: "branch", files: branchFiles };
    }
  } catch {
    // Auto mode treats a missing tracked branch as "no branch diff fallback".
  }

  throw new Error("No reviewable changes found. Auto scope tried unstaged changes, staged changes, and tracked branch changes.");
}

export async function listReviewFilesWithOptions(repoRoot: string, scope: ReviewScope, options: ReviewListOptions): Promise<ReviewFile[]> {
  const repositoryHasHead = await hasHead(repoRoot);

  if (scope === "branch") {
    if (!repositoryHasHead) return [];
    const baseRef = await resolveBaseRef(repoRoot, options.baseRef);
    const mergeBase = await getMergeBase(repoRoot, baseRef);
    const diffResult = await git(["diff", "--find-renames", "-M", "--name-status", "-z", mergeBase, "--"], repoRoot, true);
    const untrackedResult = await git(["ls-files", "--others", "--exclude-standard", "-z"], repoRoot, true);
    const entries = [...parseNameStatusZ(diffResult.stdout), ...parseUntrackedZ(untrackedResult.stdout)];
    const seen = new Set<string>();
    const files: ReviewFile[] = [];

    for (const entry of entries) {
      const id = fileId(scope, entry, baseRef);
      if (seen.has(id)) continue;
      seen.add(id);
      files.push(toReviewFile(scope, entry, baseRef));
    }

    return files.sort(compareFiles);
  }

  if (scope === "last-commit") {
    if (!repositoryHasHead) return [];
    const result = await git(["diff-tree", "--root", "--find-renames", "-M", "--name-status", "-z", "--no-commit-id", "-r", "HEAD"], repoRoot, true);
    return parseNameStatusZ(result.stdout).map((entry) => toReviewFile(scope, entry)).sort(compareFiles);
  }

  if (scope === "staged") {
    const args = repositoryHasHead
      ? ["diff", "--cached", "--find-renames", "-M", "--name-status", "-z", "HEAD", "--"]
      : ["diff", "--cached", "--find-renames", "-M", "--name-status", "-z", "--"];
    const result = await git(args, repoRoot, true);
    return parseNameStatusZ(result.stdout).map((entry) => toReviewFile(scope, entry)).sort(compareFiles);
  }

  const diffResult = await git(["diff", "--find-renames", "-M", "--name-status", "-z", "--"], repoRoot, true);
  const untrackedResult = await git(["ls-files", "--others", "--exclude-standard", "-z"], repoRoot, true);
  const entries = [...parseNameStatusZ(diffResult.stdout), ...parseUntrackedZ(untrackedResult.stdout)];
  const seen = new Set<string>();
  const files: ReviewFile[] = [];

  for (const entry of entries) {
    const id = fileId(scope, entry);
    if (seen.has(id)) continue;
    seen.add(id);
    files.push(toReviewFile(scope, entry));
  }

  return files.sort(compareFiles);
}

async function resolveBaseRef(repoRoot: string, requestedBaseRef?: string): Promise<string> {
  if (requestedBaseRef != null && requestedBaseRef.trim().length > 0) {
    return requestedBaseRef.trim();
  }

  const result = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], repoRoot, true);
  const upstream = result.stdout.trim();
  if (result.code !== 0 || upstream.length === 0) {
    throw new Error("No tracked branch is configured. Use --base <ref>, for example --base main or --base origin/main.");
  }
  return upstream;
}

async function getMergeBase(repoRoot: string, baseRef: string): Promise<string> {
  const result = await git(["merge-base", baseRef, "HEAD"], repoRoot, true);
  const mergeBase = result.stdout.trim();
  if (result.code !== 0 || mergeBase.length === 0) {
    throw new Error(`Could not find a merge-base between '${baseRef}' and HEAD.`);
  }
  return mergeBase;
}

async function addedFileDiff(repoRoot: string, path: string): Promise<string> {
  let content = "";
  try {
    content = await readFile(join(repoRoot, path), "utf8");
  } catch {
    content = "";
  }

  const lines = content.length === 0 ? [] : splitFileLines(content);

  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ].join("\n");
}

export async function getFileDiff(repoRoot: string, file: ReviewFile, scope: ReviewScope): Promise<string> {
  if ((scope === "unstaged" || scope === "branch") && file.status === "untracked") {
    return addedFileDiff(repoRoot, file.path);
  }

  const path = file.path;
  const common = ["--no-ext-diff", "--no-color", "--find-renames", "-M", "--unified=0"];

  if (scope === "last-commit") {
    const result = await git(["show", "--format=", ...common, "HEAD", "--", path], repoRoot, true);
    return result.stdout;
  }

  if (scope === "staged") {
    const result = await git(["diff", "--cached", ...common, "--", path], repoRoot, true);
    return result.stdout;
  }

  if (scope === "branch") {
    const baseRef = await resolveBaseRef(repoRoot, file.baseRef);
    const mergeBase = await getMergeBase(repoRoot, baseRef);
    const result = await git(["diff", ...common, mergeBase, "--", path], repoRoot, true);
    return result.stdout;
  }

  const result = await git(["diff", ...common, "--", path], repoRoot, true);
  return result.stdout;
}

export async function getFileSources(repoRoot: string, file: ReviewFile, scope: ReviewScope): Promise<DiffSources> {
  const path = file.path;
  const oldPath = file.oldPath ?? file.path;

  if ((scope === "unstaged" || scope === "branch") && file.status === "untracked") {
    return { oldLines: null, newLines: await readWorktreeFile(repoRoot, path) };
  }

  if (scope === "last-commit") {
    return {
      oldLines: await readGitObjectFile(repoRoot, "HEAD^", oldPath),
      newLines: await readGitObjectFile(repoRoot, "HEAD", path),
    };
  }

  if (scope === "staged") {
    const repositoryHasHead = await hasHead(repoRoot);
    return {
      oldLines: repositoryHasHead ? await readGitObjectFile(repoRoot, "HEAD", oldPath) : null,
      newLines: await readIndexFile(repoRoot, path),
    };
  }

  if (scope === "branch") {
    const baseRef = await resolveBaseRef(repoRoot, file.baseRef);
    const mergeBase = await getMergeBase(repoRoot, baseRef);
    return {
      oldLines: await readGitObjectFile(repoRoot, mergeBase, oldPath),
      newLines: await readWorktreeFile(repoRoot, path),
    };
  }

  return {
    oldLines: await readIndexFile(repoRoot, oldPath),
    newLines: await readWorktreeFile(repoRoot, path),
  };
}
