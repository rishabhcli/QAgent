# Security Policy

## Supported Versions

| Version  | Status                                               |
| -------- | ---------------------------------------------------- |
| 0.2 beta | Security fixes on `main` and the latest beta release |
| 0.1.x    | Historical; critical disclosure assessment only      |
| Earlier  | Unsupported                                          |

## Report A Vulnerability

Do not open a public issue. Use [GitHub private vulnerability
reporting](https://github.com/rishabhcli/QAgent/security/advisories/new) and include the affected
version or commit, impact, reproduction steps, and any suggested remediation.

The maintainers aim to acknowledge a report within five business days. Assessment, disclosure timing,
fix availability, and credit are coordinated in the private advisory.

## Security Boundaries

QAgent executes commands from explicitly trusted repositories. Workspace trust is a user security
decision, not a code sandbox: a trusted test or start command can run arbitrary code as the current
operating-system user.

QAgent reduces the surrounding risk by:

- resolving canonical repository and command working-directory paths;
- containing mutations in a dedicated Git worktree outside the active checkout;
- rejecting patch traversal, absolute paths, `.git`, and secret-like files;
- preventing automatic merge for authentication, workflow, dependency, lockfile, migration,
  secret-policy, and `.qagent.yml` changes;
- sandboxing the Electron renderer with context isolation, no Node integration, CSP, blocked
  navigation/windows, and validated narrow IPC;
- encrypting persistent credentials through Electron `safeStorage` when the OS provides a secure
  backend;
- disabling persistent Linux credentials when `safeStorage` reports the unencrypted `basic_text`
  backend;
- redacting credentials, authorization headers, environment values, and secret-like text before
  optional trace delivery;
- preserving checksums and provenance for local artifacts.

Read [docs/THREAT_MODEL.md](./docs/THREAT_MODEL.md) for assets, trust boundaries, threats, controls,
and accepted limitations.

## Secrets

Never commit, attach, or paste real provider credentials. Runtime credentials may come from an
operating-system key store, the current environment, or an in-memory session. They must not appear in
SQLite events, artifacts, logs, model prompts, error messages, exports, telemetry, fixtures, or tests.

If a credential is exposed, revoke it at the provider and report the location privately. Removing it
from the current branch is not sufficient when it has entered Git history or a release artifact.

## Dependency Findings

Release automation fails on unaccepted critical or high production advisories. A temporary exception
requires a dated, scoped record under `docs/security/accepted-risks/` with reachability, mitigation,
owner, and expiry. `continue-on-error` is not permitted for the production dependency audit.
