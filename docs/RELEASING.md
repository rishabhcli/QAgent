# Release Process

QAgent v0.2 releases are built from an existing `v0.2.*` tag by
`.github/workflows/release.yml`. A successful local package is not a release, and a successful tag
build is not a published release until the final GitHub release and attestation verification steps
complete.

## Version And Source Invariants

- Use Node 24 and pnpm 11.15.1.
- Keep the root and `apps/desktop` versions identical.
- The tag must be exactly `v<workspace version>`.
- The tag commit must be the workflow provenance commit. A manual dispatch against another branch or
  commit fails before dependencies are installed.
- Update `CHANGELOG.md` and regenerate the configuration schema before creating the tag.
- Never rebuild an existing tag from different source. Create a new version instead.

## Required Gates

The release workflow blocks publication on schema drift, Prettier, zero-warning ESLint, TypeScript,
coverage, integration tests, package builds, production dependency audit, Git history secret scan,
CodeQL, and Electron/documentation E2E on macOS, Windows, and Linux.

Packaging then runs on:

| Target      | Runner           | Required distributables    |
| ----------- | ---------------- | -------------------------- |
| macOS arm64 | `macos-26`       | DMG and ZIP                |
| macOS x64   | `macos-26-intel` | DMG and ZIP                |
| Windows x64 | `windows-2025`   | Squirrel Setup EXE and ZIP |
| Linux x64   | `ubuntu-24.04`   | DEB, RPM, and ZIP          |

Each package job records the app version, tag, commit, platform, architecture, signing state,
notarization state, source-tree dirtiness, release channel, update source, and update eligibility
in `build-metadata.json`. A tagged build additionally fails unless the tag exists at `HEAD` and the
source checkout is clean, including untracked source files. Collection fails when those values do not
match the requested target.

The desktop worker bundle externalizes the `weave` package to keep its module graph loadable inside
Electron. `tsup` separately builds `dist/weave-runtime.js` from the installed official W&B Weave SDK;
the generated packaged `node_modules/weave/index.js` only forwards to that bundle. Packaging fails if
the real bundle is missing. This bridge contains no fake provider, fallback operation, or silent
mock, and production telemetry still uses authenticated W&B service calls.

## Signing And Labels

Configured macOS releases use Developer ID signing and Apple notarization. Configured Windows
releases use Authenticode for the packaged application and Squirrel installer. The workflow verifies
the final application signature, Apple staple, and Windows installer signature before recording a
signed result.

The evidence fields `signed` and `notarized` describe the application payload inside ZIP/DMG
containers. They do not claim that a ZIP or DMG container has a separate signature. Unsigned macOS
apps receive only the ad hoc signature required to run Electron locally; this is not a distribution
identity and remains `signed: false`. Those builds use environment or session credentials and do not
initialize macOS Keychain at startup; persistent safeStorage credentials are enabled only for a
stable signed application identity.

Artifact names expose missing trust properties:

- `-UNSIGNED` means no configured distribution identity was verified.
- `-UNNOTARIZED` means the macOS app was signed but Apple notarization was not completed.
- Files without either marker are emitted only after the configured platform verification succeeds.

Unsigned beta artifacts may be published for testing, but the release notes must call out the
operating-system warnings and manual installation steps. Do not describe them as production-signed.
`release:finalize` generates this warning in `RELEASE_TRUST.md`, and the publish job prepends it to
the generated GitHub release notes.

## Automatic Updates

The runtime uses an explicit `update-electron-app` source:

```text
type: ElectronPublicUpdateService
repository: rishabhcli/QAgent
host: https://update.electronjs.org
```

Automatic updates are currently enabled only for macOS when all of these are true:

- the packaged version is stable, not a prerelease;
- `QAGENT_ENABLE_AUTO_UPDATE=true` was set by the release build;
- `QAGENT_RELEASE_TAG` exactly matches `v<app version>`;
- the release tag resolves to the clean checked-out commit; and
- macOS has both a verified distribution signature and notarization.

The Electron public update service ignores draft and prerelease GitHub releases, so v0.2 beta builds
always record `updateEnabled: false`, even when signed. Linux uses its package manager and never
enables Electron auto-update. Windows also records `updateEnabled: false` until the workflow
publishes the complete Squirrel feed (`RELEASES` and the full NuGet package) alongside the installer.
`QAGENT_DISABLE_AUTO_UPDATE=true` disables checks for installed smoke tests and controlled
environments.

## Installed Artifact Smoke

Every package job installs or mounts its final collected artifact and launches the installed
executable:

- macOS launches `QAgent.app/Contents/MacOS/QAgent` from the final DMG.
- Windows silently installs the final Squirrel Setup EXE, stops the installer-launched process, and
  launches `app-<version>/QAgent.exe`.
- Linux installs the final DEB and launches the executable reported by `dpkg`.

All platform ZIPs are independently expanded or integrity-tested, and the Linux RPM file list is
validated. Those archive checks are not described as installed launch proof: the installed
application proof remains DMG, Setup EXE, and DEB respectively.

Surface smoke verifies the real renderer URL, preload bridge, absence of renderer `process` and
`require`, and captures a screenshot, process log, source artifact digest, and exact installed
executable path. The harness launches the installed executable as a real child process and attaches
to a loopback-only Chromium DevTools port. It does not re-enable Electron's disabled Node inspector
fuse or weaken the packaged renderer sandbox. A failure writes `installed-smoke-failure.json` and
`shell-stream.log` before the job fails.

Credential-backed live smoke is separate:

```bash
pnpm release:smoke-installed -- \
  --executable=/absolute/path/to/QAgent \
  --artifact=/absolute/path/to/final-installer \
  --target=darwin-arm64 \
  --output=release/installed-smoke-live \
  --mode=live
```

Live mode requires `QAGENT_SMOKE_MODEL_PROVIDER`, `QAGENT_SMOKE_MODEL`, and the corresponding real
provider credential. It selects the temporary repository through the installed app's native
directory chooser, abruptly terminates an active packaged run, and relaunches the same installed
app. The proof fails unless the durable record contains interruption and resume events, a positive
recovery count, a successful structured provider call, evidence-backed specialist handoffs, and a
dedicated local branch that resolves to a commit while the original checkout remains clean. The
browser evidence receiver must visibly load a persisted screenshot linked to browser evidence
events. Local publication must finish at the verified-branch boundary with no GitHub publication
record or event. The redacted startup/process stream is capped at 128 KiB and must be nonempty. A
deterministic model double or pre-seeded renderer does not satisfy this proof.

## Checksums, SBOM, And Attestations

Platform jobs create provenance attestations for the collected distributables and installed-smoke
evidence. The publish job downloads them, verifies every attestation, and rejects missing, duplicate,
renamed, relabeled, or changed artifacts.

`scripts/finalize-release.ts` requires all four targets and writes:

- `SHA256SUMS.txt`, sorted byte-for-byte by the flat GitHub release asset name;
- `release-evidence.json`, binding all targets to one version, tag, and commit; and
- the canonical list of distributables that may be uploaded.

`qagent.cdx.json` is a CycloneDX application SBOM generated from production workspace dependencies.
The SBOM attestation uses `SHA256SUMS.txt` as its exact subject list. A separate provenance
attestation covers the checksum file, release evidence, SBOM file, and changelog. After publication,
`gh release verify <tag>` must succeed.

Consumers can verify downloaded assets in one directory:

```bash
sha256sum --check SHA256SUMS.txt
gh attestation verify QAgent-<version>-<platform>-<arch>.<ext> \
  --repo rishabhcli/QAgent
gh release verify v<version> --repo rishabhcli/QAgent
```

## Local Preparation

Before tagging, run the complete release gates with the pinned toolchain:

```bash
pnpm install --frozen-lockfile
pnpm schema
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:coverage
pnpm test:integration
pnpm test:e2e
pnpm build
pnpm security:audit
pnpm package
```

Local output beneath `apps/desktop/out/` is development evidence only. Do not claim signing,
notarization, installed-artifact smoke, attestation, GitHub publication, or updater availability
unless the corresponding verification actually completed. A nonrelease package may record
`sourceDirty: true`; it cannot carry a release tag or enable updates.
