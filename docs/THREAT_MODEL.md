# Threat Model

## Assets

- The developer's active checkout, Git history, and unpublished work
- Model, browser, GitHub, and telemetry credentials
- Files and processes outside a registered project
- Protected branches, repository policy, and publication identity
- Integrity and provenance of evidence, patches, and run history

## Untrusted Inputs

Repositories, `.qagent.yml`, web pages, process output, model responses, diffs, Git remotes, provider
responses, imported Redis records, MCP clients, and renderer messages are untrusted.

## Controls

1. Commands require explicit trust of a resolved canonical repository path.
2. Mutations occur in a dedicated worktree, not the active checkout.
3. Command `cwd` values and filesystem paths must remain contained after resolution.
4. Patch parsing rejects traversal, absolute paths, `.git`, secrets, and oversized diffs.
5. Structured provider responses are validated before use; failures remain visible.
6. A durable lease permits one active mutation run per project.
7. Dirty checkouts block publication. High-risk changes cannot auto-merge.
8. GitHub branch protection, reviews, checks, merge queues, and permissions remain authoritative.
9. Electron uses a sandboxed renderer, context isolation, no Node integration, CSP, blocked navigation
   and windows, a custom secure protocol, and schema-validated IPC.
10. Persistent credentials require an operating-system encrypted safeStorage backend. Linux
    `basic_text` permits environment or session credentials only.
11. Artifacts are atomically written, checksummed, and read through a contained artifact root.
12. Optional telemetry is locally redacted and cannot block execution.

## Accepted Limitations

Workspace trust is not OS-level sandboxing. A trusted command can execute arbitrary code as the user.
A malicious browser or model may produce misleading evidence or patches. Tests can be incomplete.
GitHub credentials can act within their provider permissions. Users must review the captured evidence,
diff, executed verification, and repository policy before granting broad autonomy.

## Security Regression Tests

Tests cover traversal and symlink containment, sensitive patch paths, trust decisions, IPC validation,
redaction, leases, cancellation, dirty publication, high-risk merge policy, credential backend states,
and artifact integrity. Release gates also include secret scanning, CodeQL, and a blocking high/critical
production advisory audit.
