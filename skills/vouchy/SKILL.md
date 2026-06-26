---
name: vouchy
description: Run or coordinate the local vouchy terminal workflow for git changes. Use when the user asks for an SSH-friendly diff review, wants to add comments to changed files before asking Codex to edit, mentions vouchy, or asks to invoke a diff review workflow from Codex.
---

# Vouchy

## Overview

Use the `vouchy` CLI to let the user walk git changes in a terminal UI, attach comments to diff lines or whole files, and print a Codex-ready feedback prompt. The review interaction itself needs a real interactive terminal.

## Workflow

1. Check whether an interactive TTY is available for the user-facing command. If Codex cannot hand keyboard input to the command, ask the user to run it in their SSH terminal and paste the generated prompt.
2. Prefer an installed `vouchy` command. If this checkout is available, build and run it directly:

```bash
npm run build
node dist/src/cli.js
```

3. Pass a scope when needed:

```bash
vouchy --scope auto
vouchy --scope worktree
vouchy --scope staged
vouchy --scope last-commit
vouchy --scope branch
vouchy --scope tracked
vouchy --base main
```

`auto` is the default scope. It reviews unstaged/untracked changes first, then staged changes, then the tracked branch diff when the current branch has an upstream. `worktree` reviews only unstaged and untracked changes. `branch` compares the current working tree against the merge-base with the current branch's tracked upstream branch. `tracked` is an alias for `branch`. `--base <ref>` implies branch scope and uses that ref instead of the tracked upstream.

4. After the command exits, use the stdout feedback prompt as the user's requested changes. Do not discard line references or overall feedback.

## Terminal Keys

- `j` / `k`: move through the diff
- `f` / Space / Ctrl-F: page forward
- `b` / Ctrl-B: page backward
- `n` / `p`: next or previous hunk
- `]` / `[` or left/right arrows: next or previous file
- `c`: add a comment on the selected diff line
- `o`: add or edit overall feedback
- `S`: submit and print the feedback prompt
- `q`: cancel

If no interactive TTY is available, ask the user to run the command themselves and paste the output. Do not simulate a human review without their comments.
