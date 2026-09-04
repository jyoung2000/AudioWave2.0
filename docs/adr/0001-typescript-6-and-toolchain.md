# ADR-0001: TypeScript 6.0.x, pnpm 10, Vite 8, Vitest 5, ESLint 10

**Status:** accepted · **Date:** 2026-09-03

## Context
The registry's `latest` TypeScript is 7.0.2 (the Go-based compiler). `typescript-eslint` 8.69 declares `typescript >=4.8.4 <6.1.0`; ESLint 10 and Vite 8 are current stable. Node 22.22 is the LTS in the build image.

## Decision
- TypeScript **6.0.3** (the last JS-based major, fully supported by typescript-eslint). Strict mode plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`.
- pnpm 10 workspace with `node-linker=hoisted` (electron-builder and Vite worker/worklet resolution behave predictably; documented trade-off: phantom dependencies are guarded by lint and per-package `package.json` declarations).
- Vite 8 (Rolldown) for the three UIs and the component gallery; esbuild 0.28 for the hub server and Electron main/preload bundles (native modules external).
- Vitest 5 with named projects (unit, dom, contracts, integration, security); Playwright 1.62 for e2e/a11y/visual.
- Zod 4 as the single schema source; JSON Schema/OpenAPI generated with `z.toJSONSchema`.

## Consequences
- Upgrade to TypeScript 7 when typescript-eslint supports it; no source changes expected.
- In this sandbox the Playwright bundled browser revision (1234) differs from the pre-installed Chromium (1194); tests honour `NP_CHROMIUM_PATH` to point at an explicit executable. CI installs the matching browser normally.
