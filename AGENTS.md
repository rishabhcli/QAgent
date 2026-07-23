# QAgent Agent Guide

Read this file, `README.md`, and the relevant document under `docs/` before changing QAgent.

## Product Boundary

QAgent v0.2 is a breaking, local-first beta for individual web developers. A shared engine powers an
Electron desktop app, CLI, and MCP server. SQLite, local artifacts, Git worktrees, and local
Chrome/Chromium are the default runtime. GitHub, Browserbase, Weave, Redis migration, Vercel, and
Daytona are optional adapters.

Never reintroduce the v0.1 operational Next.js API, Expo, Marimo, Remotion demo media, planned-only
ADK code, process-local state, duplicate transport models, fake metrics, random evaluations, fake
GitHub data, or silent runtime mocks.

## Workspace

```text
apps/desktop          Electron Forge 7 + Vite + React 19
apps/docs             Next 16 static documentation
packages/contracts    Shared Zod schemas and public records
packages/core         QAgentEngine and durable run state machine
packages/storage      SQLite/Drizzle, migrations, leases, artifacts
packages/adapters     Process, Git, browser, models, GitHub, telemetry, Redis import
packages/cli          Human and JSON/NDJSON CLI
packages/mcp          Trusted-project MCP server over stdio
fixtures              Deterministic real web fixture
tests                 Unit, integration, interface, Electron, visual, accessibility
```

Use the existing workspace; do not add Turborepo or a parallel HTTP domain layer.

## Required Toolchain

- Node 24 (`.nvmrc`)
- pnpm 11.15.1 (exact `packageManager`)
- TypeScript 5.9 strict mode
- Prettier and zero-warning ESLint

```bash
pnpm install --frozen-lockfile
pnpm schema
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:coverage
pnpm build
```

## Invariants

- Every execution path requires explicit trust of the resolved canonical project path.
- Every mutation occurs in a dedicated Git worktree. Never alter the active checkout.
- Commands are structured executable/argument arrays with contained `cwd` values, not shell strings.
- Patch paths are parsed and must exclude traversal, absolute paths, `.git`, and secrets.
- Authentication, workflows, dependencies/lockfiles, migrations, secrets policy, and `.qagent.yml`
  changes may open a PR but never auto-merge.
- A dirty original checkout may be analyzed but cannot be published.
- Invalid or unavailable providers fail visibly. Test doubles stay in tests.
- Unknown metrics remain `null` or explicitly unavailable; never coerce them to zero.
- Every external fact carries source, capture time, and availability provenance.
- Credentials never enter events, artifacts, logs, model context unnecessarily, telemetry, or exports.
- Weave is opt-in after disclosure, locally redacted, and never blocks a run.

## Contracts And Storage

Change public behavior in `packages/contracts` first. Desktop IPC, CLI, MCP, storage, and core must
consume those schemas. Regenerate `packages/contracts/schema/qagent.schema.json` and the docs copy with
`pnpm schema` after configuration changes.

Durable schema changes require a numbered forward migration and tests against a real temporary SQLite
database. Do not edit already released migrations. Ordered events must remain monotonic and valid
under concurrent readers. Project leases must expire and recover without allowing simultaneous
mutation.

## Desktop Security

Keep the renderer sandboxed with context isolation and no Node integration. Use the custom secure
protocol, a strict CSP, blocked navigation/windows, validated IPC, and a minimal preload bridge. File,
database, Git, process, and model work belongs in the UtilityProcess.

Persistent credentials require Electron safeStorage. If Linux reports `basic_text`, allow environment
or session credentials only and show the limitation. Never add a plaintext fallback.

## Testing

Unit-test transitions, config detection/validation, provider parsing, redaction, risk policy, leases,
retries, migrations, and merge decisions. Integration tests use real SQLite, temporary Git repos and
worktrees, real child processes, and local Chromium. Deterministic model providers are permitted only
inside tests.

Desktop, CLI, and MCP must expose the same IDs, events, artifacts, failures, and cancellation behavior.
Electron tests cover onboarding, repair, policy block, outages, cancellation, recovery, dirty checkout,
missing keyring, and managed-browser installation across supported platforms.

Keep at least 85% line and 80% branch coverage for core packages. Release gates are formatting,
zero-warning ESLint, TypeScript, tests, packaging, secret scan, CodeQL, and blocking unaccepted
critical/high production advisories.

## Open Source And Release

Documentation must describe current evidence, not aspirations. Product screenshots come from the real
fixture workflow. Unsigned beta packages are labeled clearly and do not receive automatic updates.
Releases include checksums, CycloneDX SBOMs, provenance, changelog, and macOS, Windows, and Linux
artifacts described in `docs/RELEASING.md`.

Preserve AGPL-3.0 and the historical `v0.1.0` tag.
