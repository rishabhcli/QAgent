# Migrating From v0.1

v0.2 is intentionally breaking. Preserve any v0.1 deployment until you have verified the local beta
workflow. The `v0.1.0` Git tag remains the historical source boundary.

## Removed

- Operational Next.js APIs and hosted multi-user dashboard assumptions
- Expo mobile app and its incompatible authentication flow
- Marimo, Remotion demo media, planned-only ADK code, hackathon simulations, and stale screenshots
- Process-local run data and duplicate API/domain records
- Mandatory Redis, Browserbase, Weave, and Vercel runtime dependencies

## Project Setup

Run `qagent init /path/to/repository`, review the generated `.qagent.yml`, then register and trust the
canonical path with `qagent project add /path/to/repository --trust`. Run Doctor before the first repair.

## Redis Knowledge

`qagent migrate redis --url <redis-url>` imports legacy fix knowledge with `legacy-redis` provenance.
Credentials and unrelated keys are never imported. Verify the reported entry count and retain the
legacy backup until the new local database has been tested.

There is no operational HTTP API compatibility shim and no automatic migration of sessions, users,
fake metrics, mobile state, or cloud deployment records.
