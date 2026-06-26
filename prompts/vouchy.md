---
description: Run the local terminal diff review workflow and apply the submitted feedback
argument-hint: [--scope auto|worktree|staged|last-commit|branch|tracked] [--base REF]
---

Use the local Vouchy diff review workflow for this repository.

1. If an interactive terminal is available to the user, ask them to run:

   ```bash
   vouchy $ARGUMENTS
   ```

   If the package is not installed, run it from the project checkout with:

   ```bash
   npm run build
   node dist/src/cli.js $ARGUMENTS
   ```

2. Wait for the generated feedback prompt from stdout.
3. Treat that prompt as the user's review feedback and address it in the current repository.

If you cannot access an interactive TTY, do not fake the review. Ask the user to run the command in their SSH terminal and paste the generated feedback prompt.
