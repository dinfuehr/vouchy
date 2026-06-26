import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getCurrentBranch, getFileDiff, listReviewFilesWithOptions, selectReviewFilesWithOptions } from "../src/git.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function createRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "vouchy-"));
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  writeFileSync(join(repo, "file.txt"), "base\n");
  git(repo, ["add", "file.txt"]);
  git(repo, ["commit", "-q", "-m", "base"]);
  return repo;
}

test("branch scope compares against an explicit base ref", async () => {
  const repo = createRepo();
  try {
    git(repo, ["checkout", "-q", "-b", "feature"]);
    writeFileSync(join(repo, "file.txt"), "branch\n");
    git(repo, ["add", "file.txt"]);
    git(repo, ["commit", "-q", "-m", "branch"]);
    writeFileSync(join(repo, "file.txt"), "working\n");
    writeFileSync(join(repo, "new.txt"), "untracked\n");

    const files = await listReviewFilesWithOptions(repo, "branch", { baseRef: "main" });
    assert.deepEqual(files.map((file) => file.path).sort(), ["file.txt", "new.txt"]);
    assert.equal(files.find((file) => file.path === "file.txt")?.baseRef, "main");

    const diff = await getFileDiff(repo, files.find((file) => file.path === "file.txt")!, "branch");
    assert.match(diff, /\+working/);
    assert.doesNotMatch(diff, /\+branch/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("getCurrentBranch returns the checked out branch name", async () => {
  const repo = createRepo();
  try {
    git(repo, ["checkout", "-q", "-b", "feature"]);
    assert.equal(await getCurrentBranch(repo), "feature");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("branch scope defaults to the current upstream branch", async () => {
  const remote = mkdtempSync(join(tmpdir(), "vouchy-remote-"));
  const repo = createRepo();
  try {
    git(remote, ["init", "-q", "--bare"]);
    git(repo, ["remote", "add", "origin", remote]);
    git(repo, ["push", "-q", "-u", "origin", "main"]);
    git(repo, ["checkout", "-q", "-b", "feature"]);
    git(repo, ["push", "-q", "-u", "origin", "feature"]);
    writeFileSync(join(repo, "file.txt"), "working\n");

    const files = await listReviewFilesWithOptions(repo, "branch", {});
    assert.equal(files.length, 1);
    assert.equal(files[0]?.path, "file.txt");
    assert.equal(files[0]?.baseRef, "origin/feature");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});

test("file diffs are fetched without git context", async () => {
  const repo = createRepo();
  try {
    const original = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`);
    writeFileSync(join(repo, "long.txt"), `${original.join("\n")}\n`);
    git(repo, ["add", "long.txt"]);
    git(repo, ["commit", "-q", "-m", "long file"]);

    const changed = [...original];
    changed[19] = "changed line 20";
    writeFileSync(join(repo, "long.txt"), `${changed.join("\n")}\n`);

    const files = await listReviewFilesWithOptions(repo, "unstaged", {});
    const file = files.find((entry) => entry.path === "long.txt");
    assert.ok(file);

    const diff = await getFileDiff(repo, file, "unstaged");
    assert.match(diff, /-line 20/);
    assert.match(diff, /\+changed line 20/);
    assert.doesNotMatch(diff, /^ line 19$/m);
    assert.doesNotMatch(diff, /^ line 21$/m);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("unstaged scope only lists unstaged changes", async () => {
  const repo = createRepo();
  try {
    writeFileSync(join(repo, "file.txt"), "staged\n");
    git(repo, ["add", "file.txt"]);

    const stagedOnly = await listReviewFilesWithOptions(repo, "unstaged", {});
    assert.deepEqual(stagedOnly, []);

    writeFileSync(join(repo, "file.txt"), "unstaged\n");
    const files = await listReviewFilesWithOptions(repo, "unstaged", {});
    assert.deepEqual(files.map((file) => file.path), ["file.txt"]);

    const diff = await getFileDiff(repo, files[0]!, "unstaged");
    assert.match(diff, /-staged/);
    assert.match(diff, /\+unstaged/);
    assert.doesNotMatch(diff, /-base/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("auto scope prefers unstaged changes over staged changes", async () => {
  const repo = createRepo();
  try {
    writeFileSync(join(repo, "staged.txt"), "base\n");
    writeFileSync(join(repo, "unstaged.txt"), "base\n");
    git(repo, ["add", "staged.txt", "unstaged.txt"]);
    git(repo, ["commit", "-q", "-m", "more files"]);

    writeFileSync(join(repo, "staged.txt"), "staged\n");
    git(repo, ["add", "staged.txt"]);
    writeFileSync(join(repo, "unstaged.txt"), "unstaged\n");

    const selection = await selectReviewFilesWithOptions(repo, "auto", {});
    assert.equal(selection.scope, "unstaged");
    assert.deepEqual(selection.files.map((file) => file.path), ["unstaged.txt"]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("auto scope falls back to staged changes", async () => {
  const repo = createRepo();
  try {
    writeFileSync(join(repo, "file.txt"), "staged\n");
    git(repo, ["add", "file.txt"]);

    const selection = await selectReviewFilesWithOptions(repo, "auto", {});
    assert.equal(selection.scope, "staged");
    assert.deepEqual(selection.files.map((file) => file.path), ["file.txt"]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("auto scope falls back to the tracked branch diff", async () => {
  const remote = mkdtempSync(join(tmpdir(), "vouchy-remote-"));
  const repo = createRepo();
  try {
    git(remote, ["init", "-q", "--bare"]);
    git(repo, ["remote", "add", "origin", remote]);
    git(repo, ["push", "-q", "-u", "origin", "main"]);
    git(repo, ["checkout", "-q", "-b", "feature"]);
    git(repo, ["push", "-q", "-u", "origin", "feature"]);
    writeFileSync(join(repo, "file.txt"), "branch\n");
    git(repo, ["add", "file.txt"]);
    git(repo, ["commit", "-q", "-m", "branch change"]);

    const selection = await selectReviewFilesWithOptions(repo, "auto", {});
    assert.equal(selection.scope, "branch");
    assert.deepEqual(selection.files.map((file) => file.path), ["file.txt"]);
    assert.equal(selection.files[0]?.baseRef, "origin/feature");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});

test("auto scope errors when no fallback has reviewable changes", async () => {
  const repo = createRepo();
  try {
    await assert.rejects(
      () => selectReviewFilesWithOptions(repo, "auto", {}),
      /No reviewable changes found/,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
