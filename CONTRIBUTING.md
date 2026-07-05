# Contributing

Thanks for helping improve Codex Auto Runner.

This project is intentionally narrow: it is a local companion that resumes an existing Codex goal thread when quota recovers. Contributions should preserve that safety boundary and avoid anything that looks like quota bypassing, hidden automation, or unattended high-risk action.

## Good Contributions

- Better Codex discovery on Windows and future platform support.
- More reliable quota parsing, reset-time handling, and task state transitions.
- Stronger privacy checks, log redaction, and local-runtime file hygiene.
- UI improvements for the local dashboard and task setup flow.
- Documentation for real long-running Codex workflows.
- Small, reproducible bug reports with logs that have been redacted.

## Safety Rules

- Do not add quota bypass, token abuse, or account-limit circumvention.
- Do not auto-approve high-risk actions.
- Do not auto-push, auto-deploy, or mutate repositories without explicit user configuration.
- Do not commit local Codex state, private paths, API tokens, logs, SQLite databases, or generated runtime files.
- Keep network access explicit and visible to the user.

## Local Checks

Run these before opening a pull request:

```bash
pnpm privacy:check
pnpm typecheck
pnpm test
```

For UI changes, also run:

```bash
pnpm --filter @car/web build
```

## Pull Request Checklist

- The change preserves the local-only safety model.
- New runtime files are ignored by Git.
- User paths, tokens, quota data, and Codex private state are not committed.
- Public-facing text is updated in both `README.md` and `README.en.md` when relevant.
- Tests or a clear manual verification note are included.
