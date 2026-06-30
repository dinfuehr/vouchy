import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { commentsDirectory, storeSubmittedComments, takeStoredComments } from "../src/comment-store.js";

const execFileAsync = promisify(execFile);

async function temporaryHome(t: TestContext): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "vouchy-home-"));
  t.after(() => {
    void rm(home, { recursive: true, force: true });
  });
  return home;
}

async function temporaryRepo(t: TestContext): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "vouchy-repo-"));
  t.after(() => {
    void rm(repo, { recursive: true, force: true });
  });
  await execFileAsync("git", ["init"], { cwd: repo, encoding: "utf8" });
  const result = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: repo, encoding: "utf8" });
  return result.stdout.trim();
}

test("storeSubmittedComments writes comments and takeStoredComments drains them", async (t) => {
  const home = await temporaryHome(t);
  const repoRoot = "/repo/one";
  const otherRepoRoot = "/repo/two";
  const storedPath = await storeSubmittedComments(repoRoot, "first comment\n", { homeDir: home });
  await storeSubmittedComments(otherRepoRoot, "other comment", { homeDir: home });

  assert.ok(storedPath?.startsWith(commentsDirectory({ homeDir: home })));
  const storedPayload = JSON.parse(await readFile(storedPath ?? "", "utf8")) as { repoRoot: string; comments: string };
  assert.equal(storedPayload.repoRoot, "/repo/one");
  assert.equal(storedPayload.comments, "first comment");
  assert.equal(await takeStoredComments(repoRoot, { homeDir: home }), "first comment");
  assert.equal(await takeStoredComments(repoRoot, { homeDir: home }), "");
  assert.equal(await takeStoredComments(otherRepoRoot, { homeDir: home }), "other comment");
});

test("--take-comments prints stored comments for the current repo and removes them", async (t) => {
  const home = await temporaryHome(t);
  const repoRoot = await temporaryRepo(t);
  await storeSubmittedComments(repoRoot, "review feedback", { homeDir: home });
  await storeSubmittedComments("/other/repo", "other feedback", { homeDir: home });

  const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, "--cwd", repoRoot, "--take-comments"], {
    encoding: "utf8",
    env: { ...process.env, VOUCHY_HOME: home },
  });

  assert.equal(stderr, "");
  assert.equal(stdout, "review feedback\n");
  assert.equal(await takeStoredComments(repoRoot, { homeDir: home }), "");
  assert.equal(await takeStoredComments("/other/repo", { homeDir: home }), "other feedback");
});

test("--take-comments errors when no comments exist for the current repo", async (t) => {
  const home = await temporaryHome(t);
  const repoRoot = await temporaryRepo(t);
  const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));

  await assert.rejects(
    execFileAsync(process.execPath, [cliPath, "--cwd", repoRoot, "--take-comments"], {
      encoding: "utf8",
      env: { ...process.env, VOUCHY_HOME: home },
    }),
    (error: unknown) => {
      const failure = error as { stdout?: string; stderr?: string; code?: number };
      assert.equal(failure.stdout, "");
      assert.equal(failure.code, 1);
      assert.match(failure.stderr ?? "", /No stored comments found/);
      return true;
    }
  );
});
