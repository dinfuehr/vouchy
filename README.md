# vouchy

Vibe-coded TUI version to https://github.com/badlogic/pi-diff-review: an SSH-friendly terminal UI for reviewing git diffs and collecting comments for a coding agent.

## Run

```bash
npm install
npm run build
node dist/src/cli.js
```

## Make It Available As `vouchy`

From this checkout, build the package and link its `bin` entries into your current Node installation:

```bash
npm install
npm run build
npm link
```

Verify that your shell can find it:

```bash
command -v vouchy
vouchy --version
```

After that, run it from any git repository:

```bash
vouchy
```

To remove the local link later, run `npm unlink -g vouchy`.

By default, the submitted review prompt is copied to your clipboard as well as printed. To print without copying:

```bash
vouchy --no-copy
```

Submitted comments are also stored under `~/.vouchy/comments` for agent handoff. To print and clear pending stored comments for the current repository:

```bash
vouchy --take-comments
```

## Keys

- `j` / `k`: move through the diff
- `<n>j` / `<n>k`: move `<n>` selectable rows
- `<n>g`: jump to file line `<n>`, or the closest displayed line when that line is outside the current diff output
- `g` / `G`: jump to the first or last row
- `f` / Space / Ctrl-F: page forward
- `b` / Ctrl-B: page backward
- `n`: next hunk, or next search hit when search is active
- `p` / `N`: previous hunk, or previous search hit when search is active
- `F` / Ctrl-P: open the fuzzy file picker
- `/`: search displayed changed and context lines in the current file
- `+`: add 3 context lines around the current hunk
- `-`: remove 3 context lines from the current hunk
- `u`: add 3 context lines above the current hunk
- `d`: add 3 context lines below the current hunk, or delete the selected comment when a comment row is selected
- Alt-`u`: remove 3 context lines above the current hunk
- Alt-`d`: remove 3 context lines below the current hunk
- `=`: reset the current hunk to the default 3 context lines
- `]` / `[` or left/right arrows: next or previous file
- `c`: add a comment on the selected diff line
- `e`: edit the selected comment
- `o`: add or edit overall feedback
- `S`: submit, copy, and print the generated feedback prompt
- `Esc`: cancel current input or clear active search; without either, cancel
- `q`: cancel

The command prints the generated review prompt after the TUI exits.
It also copies that prompt using the local clipboard tool when available, or OSC 52 terminal clipboard escape sequences as an SSH-friendly fallback. Use `--no-copy` to disable clipboard copying.
Comment input opens directly below the selected diff line. Saved comments appear there in yellow and can be selected with `j` / `k`.
Active search matches are highlighted in yellow, and matching lines have their line number marked.
The file picker shows `FILE: <query>` above the file list. Enter opens the selected file, Esc cancels, and Up/Down or Ctrl-N/Ctrl-P moves through matches. Rows include added/removed line counts once the diff is loaded.

A hunk is one contiguous section of the unified diff, including the changed lines and nearby context.
The header shows the comparison plus file and hunk progress, for example `feature -> main  file 1/3  hunk 2/20`.

## Scopes

```bash
vouchy --scope auto
vouchy --scope worktree
vouchy --scope staged
vouchy --scope last-commit
vouchy --scope branch
vouchy --scope tracked
vouchy --base main
```

`auto` is the default scope. It reviews unstaged/untracked changes first. If there are none, it reviews staged changes. If there are no staged changes and the current branch has a tracked upstream branch, it reviews the branch diff. If none of those apply, Vouchy exits with an error.

`worktree` reviews only unstaged and untracked changes. `staged` reviews only staged changes. `branch` compares the current working tree against the merge-base with the current branch's tracked upstream branch. `tracked` is an alias for `branch`. Use `--base main` or `--base origin/main` to review against a specific base branch instead.
