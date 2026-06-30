import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

interface CommentStoreOptions {
  homeDir?: string;
}

interface StoredComments {
  repoRoot: string;
  comments: string;
  createdAt: string;
}

function storeHomeDir(options: CommentStoreOptions): string {
  return options.homeDir ?? process.env.VOUCHY_HOME ?? homedir();
}

function absoluteRepoRoot(repoRoot: string): string {
  return resolve(repoRoot);
}

export function commentsDirectory(options: CommentStoreOptions = {}): string {
  return join(storeHomeDir(options), ".vouchy", "comments");
}

export async function storeSubmittedComments(repoRoot: string, comments: string, options: CommentStoreOptions = {}): Promise<string | null> {
  const content = comments.trimEnd();
  if (content.length === 0) return null;

  const directory = commentsDirectory(options);
  await mkdir(directory, { recursive: true, mode: 0o700 });

  const createdAt = new Date().toISOString();
  const timestamp = createdAt.replace(/[:.]/g, "-");
  const sequence = process.hrtime.bigint().toString().padStart(20, "0");
  const path = join(directory, `${timestamp}-${sequence}-${process.pid}-${randomUUID()}.json`);
  const payload: StoredComments = {
    repoRoot: absoluteRepoRoot(repoRoot),
    comments: content,
    createdAt,
  };
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return path;
}

export async function takeStoredComments(repoRoot: string, options: CommentStoreOptions = {}): Promise<string> {
  const directory = commentsDirectory(options);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return "";
    }
    throw error;
  }

  const targetRepoRoot = absoluteRepoRoot(repoRoot);
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => join(directory, entry.name))
    .sort();

  const comments: string[] = [];
  const consumedFiles: string[] = [];
  for (const file of files) {
    const payload = JSON.parse(await readFile(file, "utf8")) as StoredComments;
    if (payload.repoRoot !== targetRepoRoot) continue;
    comments.push(payload.comments);
    consumedFiles.push(file);
  }

  await Promise.all(consumedFiles.map((file) => rm(file, { force: true })));

  return comments
    .map((comment) => comment.trimEnd())
    .filter((comment) => comment.length > 0)
    .join("\n\n");
}
