# QAgent v0.2 Architecture

## Decision

QAgent v0.2 is a local-first desktop product with one engine exposed through Electron, CLI, and MCP.
The v0.1 hosted operational API is not retained. This is a breaking beta boundary.

## Workspace

| Path                 | Ownership                                                                  |
| -------------------- | -------------------------------------------------------------------------- |
| `apps/desktop`       | Electron process model, secure IPC, and React experience                   |
| `apps/docs`          | Static Next.js documentation exported to GitHub Pages                      |
| `packages/contracts` | Zod schemas and public records shared by every interface                   |
| `packages/core`      | Transactional run state machine and `QAgentEngine`                         |
| `packages/storage`   | SQLite WAL, migrations, leases, artifacts, retention, export               |
| `packages/adapters`  | Untrusted external boundaries: process, Git, browser, model, GitHub, Weave |
| `packages/cli`       | Human, JSON, and NDJSON command interface                                  |
| `packages/mcp`       | Trusted-project MCP server over stdio                                      |

The workspace deliberately does not use Turborepo. pnpm owns dependency installation and recursive
scripts; each package remains buildable by its own declared command.

## Process Model

The Electron renderer is sandboxed, has context isolation, and has no Node.js integration. It reaches
a fixed allowlist of validated operations through a narrow context bridge. Electron main owns window
policy, the `qagent://` protocol, safeStorage, and UtilityProcess lifecycle. The engine, SQLite native
module, filesystem, Git, and child-process access live in the UtilityProcess.

Target sites never render in QAgent. Stagehand launches a separate local Chrome-compatible browser;
QAgent represents target state through screenshots, DOM evidence, logs, URLs, and checksummed artifact
references.

## Run State

```text
preflight -> discover -> test -> triage -> patch -> verify -> publish
          -> wait_checks -> merge -> postverify -> learn -> complete
```

The terminal outcomes are `succeeded`, `failed`, `cancelled`, and `policy_blocked`. State updates and
ordered events are committed to SQLite. A per-project execution lease permits only one mutation run.
An interrupted running record can reacquire its lease and validate its persisted worktree on restart.

`QAgentEngine.startRun(request)` returns a `RunHandle` with an asynchronous event stream,
cancellation, and a final result promise. Every `RunEvent` includes schema version, UUID, run ID,
monotonic sequence, stage, kind, timestamp, provenance, artifact IDs, and a kind-specific payload.

## Isolation And Publication

Preflight resolves the canonical Git root, requires stored trust for that path, records whether the
active checkout is dirty, and creates a new branch/worktree under QAgent home. Commands run only from
contained working directories. Patch paths are parsed structurally and cannot address `.git`, secrets,
absolute paths, or traversal targets.

A verified local branch is always the first publication result. GitHub publication then rebases once,
pushes the branch, opens a PR, observes repository checks/policy, and enables or records merge when
allowed. Dirty original checkouts and high-risk changes block automated publication or merge according
to policy. The active checkout is never rewritten.

## Persistence

SQLite runs in WAL mode with foreign keys, a bounded busy timeout, and numbered migrations. It stores
projects, trust, tests, runs, events, artifacts, diagnoses, patches, verifications, provider calls,
integration health, knowledge, and leases. Artifact bytes are written atomically beneath QAgent home
with SHA-256 checksums and restrictive permissions.

Unknown external values are `null` or an explicit unavailable state. They are not coerced to zero.
Provider source and capture time are attached where information enters the system.

## Compatibility

Desktop IPC, CLI, and MCP may evolve only through `@qagent/contracts`. There is no supported v0.1 HTTP
compatibility layer. Versioned migrations cover durable v0.2 storage; `qagent migrate redis` is a
one-way, credential-free import of legacy repair knowledge.
