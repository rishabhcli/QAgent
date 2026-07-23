# Telemetry And Data Policy

QAgent is fully operational without QAgent-hosted infrastructure. Local SQLite, Git, artifacts, and a
local browser do not send data to QAgent maintainers.

## Local Data

Repository source, raw screenshots, DOM evidence, console/process logs, generated patches, run history,
and legacy repair knowledge remain under the configured QAgent home. Exports verify artifact checksums
before copying them. Retention applies locally and should be configured to match the repository's own
data policy.

Credentials are stored through Electron safeStorage when available, supplied by the process
environment, or held for the current session. QAgent does not persist secrets to SQLite or artifacts.

## Model Providers

Repair requires one configured model endpoint. Model adapters send the triage and patch context shown
in the run detail to the selected provider. QAgent does not silently route to another model. Consult
the chosen provider's data terms and use an OpenAI-compatible local endpoint when source must not leave
the machine.

## Weave

Weave is optional. It activates only after valid credentials are connected and the user accepts a
disclosure describing what will leave the machine. Local operation continues when Weave is disabled,
unconfigured, queued, or failed.

Before operation post-processing sends trace inputs or outputs, local redaction removes authorization
headers, tokens, environment values, and secret-like content. Source files, screenshots, DOM snapshots,
and raw artifacts are excluded unless the user separately opts into artifact upload.

The UI reports trace state as disabled, local, queued, synced, or failed with a timestamp. A Weave
failure never changes the run result.

## Provenance

Displayed facts include their source, capture time, and availability. QAgent does not fabricate
metrics, GitHub activity, evaluations, or success. Provider token/cost values are nullable when the
provider does not report them.
