# ADR-0005: electron-builder for Windows installer + portable + release metadata

**Status:** accepted · **Date:** 2026-09-03

## Context
The companion needs a Windows x64 installer, a portable build, a checksum file and a machine-readable `latest.json` that the PWA can consume; signing must be optional via CI secrets.

## Decision
electron-builder 26 (`nsis` + `portable` targets, `artifactName` templates, optional `win.certificateSubjectName`/`CSC_LINK` secrets), followed by `scripts/release-metadata.mjs` that computes SHA-256 for every artifact and writes `latest.json` matching `ReleaseMetadata` in contracts. The GitHub Actions workflow runs on `windows-latest`, type-checks, tests, packages, and attaches artifacts plus `latest.json` and `SHA256SUMS.txt` to the release.

## Consequences
- Unsigned local builds are labelled `signed: false`; the PWA shows the signing state.
- Electron Forge was not chosen only because electron-builder's `portable` target and metadata generation are simpler; either is maintained.
