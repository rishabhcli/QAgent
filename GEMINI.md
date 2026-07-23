# QAgent Context

Follow [AGENTS.md](./AGENTS.md). QAgent v0.2 is a breaking local-first beta: Electron desktop, CLI,
and MCP share one durable SQLite engine and contract package. All mutations use isolated Git
worktrees, providers fail visibly, and cloud adapters are optional.

Run with Node 24 and pnpm 11.15.1. Keep secrets local, validate external data, preserve provenance, and
never add simulated runtime results or transport-specific domain models. Architecture and security
details are under `docs/`.
