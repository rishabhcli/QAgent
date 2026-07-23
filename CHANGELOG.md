# Changelog

All notable changes are documented here. QAgent uses semantic versioning; beta releases may include
breaking changes called out in their release notes.

## [0.2.0-beta.1] - Unreleased

### Breaking

- Replaced the hosted operational Next.js product with a local-first Electron desktop application,
  CLI, and MCP server backed by one shared engine.
- Removed the Expo client, Marimo dashboard, Remotion media, planned ADK surface, simulation paths,
  process-local run state, and duplicate HTTP models.
- Made `.qagent.yml` and explicit workspace trust the execution contract. v0.1 operational APIs are
  not compatible.

### Added

- SQLite WAL persistence with migrations, ordered events, artifacts, leases, cancellation, and
  restart recovery.
- Isolated Git worktree repair workflow, risk policy, GitHub publication, check polling, and merge
  boundaries.
- OpenAI, Anthropic, Google, and OpenAI-compatible/Ollama structured model adapters.
- Local Stagehand browser mode, browser detection, and managed Chromium installation path.
- Secure Electron process model, safeStorage credential handling, guided onboarding, and provenance-
  aware Projects, Runs, Tests, and Settings views.
- Static open-source documentation, generated configuration JSON Schema, deterministic repair fixture,
  and cross-platform release automation.
- Optional locally redacted Weave tracing and one-way legacy Redis knowledge import.

### Fixed

- Replaced permissive security auditing with blocking release policy.
- Replaced unreliable truthy environment parsing with explicit validation.
- Removed mobile authentication mismatch, stale E2E contracts, simulated metrics, fake GitHub data,
  silent mocks, and ambiguous unavailable-as-zero values.

## [0.1.0]

Historical hackathon release. Source remains available at the `v0.1.0` tag.
