# Release Process

1. Set the exact beta or stable version across the workspace and update `CHANGELOG.md`.
2. Regenerate and diff the configuration schema with `pnpm schema`.
3. Run formatting, ESLint, TypeScript, coverage, integration, Electron, accessibility, secret scan,
   CodeQL, production audit, and package jobs.
4. Produce macOS arm64/x64 DMG and ZIP, Windows x64 installer and ZIP, and Linux x64 DEB, RPM, and ZIP.
5. Sign and notarize configured platforms. Name unsupported unsigned beta files with `UNSIGNED` and
   do not enable their automatic update channel.
6. Generate CycloneDX SBOMs, build provenance, and `SHA256SUMS.txt` from final artifacts.
7. Exercise the installed artifact against a temporary copy of `fixtures/sample-web-app` and retain
   the resulting evidence manifest and screenshots.
8. Publish the GitHub release only after every required job succeeds.

Repository description and topics should describe local-first autonomous QA. Superseded automated
dependency pull requests may be closed only after the new lockfile and CI matrix are merged.
