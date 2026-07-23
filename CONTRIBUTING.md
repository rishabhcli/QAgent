# Contributing to QAgent

QAgent welcomes fixes, tests, documentation, provider adapters, and carefully scoped product changes.
The project is AGPL-3.0 and uses Developer Certificate of Origin sign-off.

Please follow the [Code of Conduct](./CODE_OF_CONDUCT.md). Report vulnerabilities through the
private process in [SECURITY.md](./SECURITY.md), not a public issue.

## Set Up

Install Node 24 and use the exact package manager declared by the repository:

```bash
corepack enable
corepack prepare pnpm@11.15.1 --activate
pnpm install --frozen-lockfile
pnpm schema
```

Cloud credentials are not required for the unit and deterministic integration suites. Never add real
credentials to fixtures, snapshots, logs, issues, or pull requests.

## Make A Change

1. Create a focused branch from `main`.
2. Preserve the shared contract boundary. Desktop, CLI, and MCP must consume `@qagent/contracts` and
   `@qagent/core` instead of creating new transport-specific records.
3. Add tests proportional to the behavioral risk. Test-only model doubles must never be reachable in
   runtime packages.
4. Update documentation and the generated configuration schema when public behavior changes.
5. Add a DCO sign-off to every commit: `git commit -s`.

Changes to contracts, migrations, trust, IPC, credential handling, patch containment, publication, or
automatic merge policy require an architecture decision record in `docs/adr/`.

## Required Checks

Run the same gates used in CI:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:coverage
pnpm build
```

Desktop work should also run the relevant Electron Playwright flow on the current platform. Packaging
or release changes must prove at least one local package and leave the platform matrix green in CI.

## Code Expectations

- Use strict TypeScript. Do not introduce `any` without a narrow, documented boundary.
- Validate all external data with Zod or the relevant structured protocol parser.
- Keep commands as executable/argument arrays; do not concatenate untrusted shell strings.
- Resolve paths and prove containment before reading, writing, executing, or applying a patch.
- Record unavailable values as unavailable or `null`, never as a fabricated zero.
- Record provider source, timestamp, status, and error without leaking inputs or credentials.
- Keep first-party ESLint output warning-free and let Prettier own formatting.
- Use deterministic data in tests. Random benchmark scores, fake stars, mock product metrics, and
  silent runtime fallbacks are not accepted.

## Adapter Contributions

Read [docs/ADAPTERS.md](./docs/ADAPTERS.md). An adapter is not labeled end-to-end verified until a
scheduled credential-backed workflow proves its complete external behavior. Unit tests and a
successful connection test support the lower `available` and `healthy` labels but do not certify it.

GitHub is the only publishing adapter certified for v0.2. A new publisher must implement repository
permissions, branch protection, required reviews, checks, merge queues, conflict policy, and
post-merge verification before certification.

## Pull Requests

Describe the user-visible problem, the chosen boundary, test evidence, security/privacy impact, and
remaining limitations. Screenshots must come from the real product state they claim to show.

Maintainers may ask to split unrelated work. Green automation is necessary but does not replace
review for security, contracts, migrations, or autonomous publication.
