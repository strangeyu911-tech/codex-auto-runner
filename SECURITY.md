# Security Policy

Codex Auto Runner is a local automation tool. It interacts with Codex Desktop state, local repositories, and local quota information, so privacy and safety are part of the core product contract.

## Reporting Security Issues

Please do not post real account identifiers, local Codex state, API tokens, quota dumps, logs, SQLite databases, or private repository paths in public issues.

For public reports, include:

- What went wrong.
- Which component is affected.
- The expected safe behavior.
- A redacted reproduction path.
- Any relevant command output with secrets and local paths removed.

If the report contains sensitive information, contact the maintainer privately through the GitHub profile contact method and share only the minimum redacted details needed to verify the issue.

## In Scope

- Local daemon HTTP API behavior.
- Token handling for the local API.
- Log redaction and privacy checks.
- Codex executable discovery and path handling.
- Task execution boundaries, approval behavior, and validation stops.

## Out of Scope

- Bypassing or expanding Codex account limits.
- Attacks against OpenAI, Codex, or third-party services.
- Social engineering.
- Denial-of-service testing.

## Safety Expectations

- The daemon must bind to `127.0.0.1` unless the user explicitly changes it.
- Local API tokens must not be committed.
- Logs must redact secrets and private account identifiers.
- The runner must stop when quota is unknown, login is required, validation fails, or human judgment is needed.
- The runner must not automatically push, deploy, or accept high-risk approvals.
