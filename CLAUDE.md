# QAgent Context

The canonical coding-agent instructions are in [AGENTS.md](./AGENTS.md). QAgent v0.2 is the local-first
Electron, CLI, and MCP rebuild; do not rely on v0.1 architecture, APIs, environment requirements, or
simulation code.

Read these references for the area being changed:

- [Architecture](./docs/ARCHITECTURE.md)
- [Threat model](./docs/THREAT_MODEL.md)
- [Data policy](./docs/DATA_POLICY.md)
- [Adapter guide](./docs/ADAPTERS.md)
- [Release process](./docs/RELEASING.md)

Use Node 24 and pnpm 11.15.1. Before handing off work, run the scoped checks and then the full gates in
`AGENTS.md`. Do not claim a provider, package, publication, merge, or end-to-end workflow is verified
unless that literal boundary was exercised and evidence was retained.
