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
probe.

## Model Providers

Implement `ModelProvider.complete`. The request supplies a Zod schema; return only after parsing the
provider's structured response through it. Record reported token values when available and `null`
otherwise. Model errors are run failures, never a routing signal to a hidden fallback.

## Publishers

A publisher must prove permissions, branch protection, required reviews, checks, merge queue behavior,
conflict handling, auto-merge eligibility, final merge state, and post-merge verification. Until that
conformance path exists, the adapter may leave a verified local branch but cannot be certified for
autonomous publication. GitHub is the only v0.2 certified publisher.

## Telemetry

Trace adapters receive already-redacted operations and expose local, queued, synced, failed, and
disabled states. They are best-effort and must not affect the run outcome. Artifact upload is a
separate opt-in.
