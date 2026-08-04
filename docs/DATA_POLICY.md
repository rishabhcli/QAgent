# Telemetry And Data Policy

QAgent is fully operational without QAgent-hosted infrastructure. Local SQLite, Git, artifacts, and a
local browser do not send data to QAgent maintainers.

## Local Data

Repository source, raw screenshots, DOM evidence, console/process logs, generated patches, run history,
and legacy repair knowledge remain under the configured QAgent home. Exports verify artifact checksums
before copying them. Retention applies locally and should be configured to match the repository's own
data policy.

Credentials remain in Electron's main process and the engine UtilityProcess; the sandboxed renderer
receives status records only. Persistent values use the asynchronous Electron safeStorage API when an
encrypted backend and a stable signed application identity are available. Source and unsigned macOS
builds, plus Linux `basic_text`, keep newly entered values in memory for the current session and never
write them as plaintext. Credential status checks do not initialize the operating-system vault;
Keychain, DPAPI, or a desktop keyring is accessed only when a persistent value is saved or decrypted.
Environment credentials are passed through a narrow engine allowlist. QAgent does not persist secrets
to SQLite or artifacts, and trusted repository commands do not inherit host provider, cloud,
database, SSH-agent, or token environment values unless the command explicitly declares them.

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

The authenticated entity/project check is separate from trace disclosure. A project probe sends no
run event. Once disclosure is accepted, trace events are delivered through a bounded local queue and
are removed only after the provider acknowledges the batch.

## Browser Providers

Local Chromium evidence stays on the machine. Browserbase receives target URLs and browser actions
when cloud mode is explicitly selected. QAgent stores captured evidence plus an allowlisted session ID
and sanitized Browserbase session/live-view URLs; API keys, connection URLs, WebSocket URLs, and
signing material are excluded.

## GitHub

GitHub receives repository, branch, commit, pull-request, and merge-policy operations only when
GitHub publication is configured. Push authentication uses an ephemeral credential helper that is
removed after the operation. QAgent never writes a tokenized remote URL. Provider-reported rules,
checks, reviews, queue state, and final state are stored as evidence; unavailable values remain
unavailable.

## Provenance

Displayed facts include their source, capture time, and availability. QAgent does not fabricate
metrics, GitHub activity, evaluations, or success. Provider token/cost values are nullable when the
provider does not report them.
