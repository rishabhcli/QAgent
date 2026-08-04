# Adapter Guide

Adapters isolate external systems from the durable domain. They live in `packages/adapters`, consume
`@qagent/contracts`, and return validated data with provenance.

## Requirements

- Validate configuration and every external response.
- Expose unavailable values explicitly; never use a fake success or metric.
- Record provider name, model or endpoint, timestamp, status, and a redacted error.
- Accept `AbortSignal` for bounded cancellation and enforce configured timeouts.
- Keep credentials out of prompts where unnecessary, events, artifacts, logs, and exceptions.
- Use deterministic doubles only from tests.
- Add unit, failure, cancellation, and credential-backed smoke coverage appropriate to the boundary.

## Status Vocabulary

`unconfigured` means required settings are absent. `configured` means settings exist but no current
probe is proven. `healthy` means a bounded connection test succeeded. `end-to-end verified` means a
scheduled credential-backed workflow proved the complete behavior. Documentation and UI must not
promote a lower status.

Run `pnpm test:adapters` to write a timestamped, source-attributed report to
`release/adapter-smoke.json`. The scheduled `Credential-backed adapter smoke` workflow runs the same
command with configured repository secrets and always retains that report as evidence. Weave remains
configured-only until `QAGENT_SMOKE_WEAVE_DISCLOSURE_ACCEPTED=true` explicitly permits its redacted
probe. Set `QAGENT_SMOKE_GITHUB_PR_NUMBER` to add a read-only inspection of that pull request's
mergeability, review decision, checks, merge queue, and current final state. A repository-only probe
is reported as `configured`; `healthy` requires the pull-request inspection as well. This remains
read-only provider evidence, not `end-to-end-verified` publication.

## Model Providers

Implement `ModelProvider.complete`. The request supplies a Zod schema; return only after parsing the
provider's structured response through it. Record reported token values when available and `null`
otherwise. Model errors are run failures, never a routing signal to a hidden fallback.

Doctor and credential smoke call the selected model and validate an actual structured response.
Credential presence without a valid response is `configured` at most.

## Browsers

Local mode requires a discovered, explicitly configured, or QAgent-managed Chromium executable.
Browserbase mode does not inspect local Chrome. It requires both `BROWSERBASE_API_KEY` and the exact
project ID, verifies that project through the provider API, then creates bounded Stagehand sessions.
Only allowlisted session IDs and sanitized Browserbase session/live-view URLs enter provenance.
Navigation, actions, evidence capture, and close operations honor cancellation and deadlines.
Unsuccessful actions and evidence failures remain visible and retain any safely captured screenshot,
DOM, console, and session metadata.

## Publishers

A publisher must prove authenticated identity, repository access, push and pull-request permissions,
branch rules and classic protection, checks, required reviews, merge queue behavior, conflict
handling, auto-merge eligibility, final merge state, and post-merge verification. GitHub pushes use a
per-operation credential helper and a credential-free HTTPS remote; tokens never enter a stored
remote. Pull-request creation first looks up the head/base pair so retries are idempotent by branch.
Until the full publication path reaches and verifies its provider-reported terminal state, the adapter
may leave a verified local branch but cannot be called end-to-end verified. GitHub is the only v0.2
publisher implementation.

## Telemetry

Trace adapters receive already-redacted operations and expose local, queued, synced, failed, and
disabled states. Weave verifies the exact entity/project independently of disclosure acceptance.
After disclosure, trace batches are locally redacted, bounded, acknowledged, retryable, and
explicitly flushable. Delivery is best-effort and must not affect the run outcome. Artifact upload is
a separate opt-in.

The current desktop connection-page observations, sanitized source URLs, and capture time are in
[Connection Journey Evidence](./CONNECTION_JOURNEY_EVIDENCE.md).
