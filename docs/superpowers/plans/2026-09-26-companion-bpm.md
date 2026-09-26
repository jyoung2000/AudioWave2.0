# Companion-Measured BPM Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Files in the companion's watched folders that carry no BPM tag get one measured from their own audio — ffmpeg decodes a minute from the middle, the shared `estimateTempo` hears it — written as `bpmSource: 'analysis'`, pushed to the hub on the next sync, and shown in the companion's Library with an honest "measured" mark.

**Architecture:** One new main-process module `windows-companion/src/main/tempo-analysis.ts` (decode via the embedded helper's ffmpeg discovery, estimate via `@now-playing/audio-core/tempo`, the same test seam pattern as the hub's `preview-bpm.ts`); a low-priority queue drained after each scan finishes, one file at a time, abandoned when a new scan starts; `store.upsertTrack` carries the answer. The Library view gains a Tempo column with `≈` on measured values.

**Tech Stack:** TypeScript 6, Electron main process, `@now-playing/audio-core/tempo` (shipped in sub-project 1), `local-helper`'s `resolveTool('ffmpeg')`, Vitest (`windows-companion/tests/integration`), the existing DOM harness for the view.

**Spec:** `docs/superpowers/specs/2026-09-26-metadata-enrichment-and-preview-design.md` (sub-project 3). Execution pre-approved by the owner (2026-09-26, "I approve piece 2 and 3 and any needed approvals"); keyless-first rule applies — this feature uses no network at all.

## Global Constraints

- Analysis runs only when ffmpeg is present (`resolveTool('ffmpeg')` from the embedded helper); absent, the Library view says "Tempo needs ffmpeg" once (NP-PRIN-002) and nothing else changes.
- One file at a time, lowest priority: a running or newly started scan, a backup, or an AWSP stream cancels/defers the pass (`AbortSignal`, same pattern as `ScanCallbacks.signal`).
- A measured value never overwrites a tag (`bpmSource: 'tag'`) or a hub answer; only `bpm === null` rows are analysed, and confidence below the estimator's own gate stays null.
- Decode is `-ss <middle> -t 60 -ac 1 -ar 22050 -f s16le` to a pipe; nothing is written to disk; the PCM cap and timeout mirror `docker-container/src/enrichment/preview-bpm.ts`.
- Fix-forward; never push except the final task; commits end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Review Focus

1. A file whose tag already says 128 must never be re-measured to something else. Pinned in Task 2.
2. ffmpeg absent: the pass skips entirely, the view explains once, and a later install picks the queue back up on the next scan. Pinned in Tasks 1–3.
3. A scan starting mid-analysis aborts the in-flight decode within its timeout, and those files are re-queued by the scan's own completion. Pinned in Task 2.
4. A corrupt/undecodable file yields null and moves on — never a crash, never a retry loop. Pinned in Task 1.
5. The `≈` mark appears only on `bpmSource: 'analysis'` rows, so a person can tell measured from tagged. Pinned in Task 3.

---

### Task 1: `analyzeFileTempo` — decode a minute from the middle and listen

**Files:**
- Create: `windows-companion/src/main/tempo-analysis.ts`
- Test: `windows-companion/tests/integration/tempo-analysis.test.ts`

**Interfaces:**
- Consumes: `estimateTempo` from `@now-playing/audio-core/tempo`; `resolveTool('ffmpeg', …)` from the embedded helper's `tools` module (fact-check its import path from `windows-companion` at implementation; `helper.ts:133` reaches the same discovery).
- Produces: `analyzeFileTempo(deps: { ffmpegPath: string; signal?: AbortSignal; ffmpegArgsOverride?: string[] }, file: { absolutePath: string; durationMs: number | null }): Promise<{ bpm: number; confidence: number } | null>`; exported `ANALYSIS_ARGS(startSeconds: number)` so the security-bearing arguments are pinned by a test (`-ss`, `-t 60`, `-ac 1`, `-ar 22050`, `-f s16le`, output `pipe:1`, input the file path — no network protocols involved).

- [ ] **Step 1: Write the failing test.** Same fake-ffmpeg seam as `preview-bpm.test.ts` (node runs a click-track script, `ffmpegArgsOverride: ['-e', CLICK_SCRIPT]`): 120 BPM clicks → `{ bpm: 120 }`; a fake that exits 1 → null; a fake that never exits → null within the timeout; `ANALYSIS_ARGS(30)` contains `'-ss', '30'` before `'-i'` and `'-t', '60'`; abort via `AbortSignal` mid-decode → null promptly.
- [ ] **Step 2: Run it** — module not found. `npx vitest run --project integration windows-companion/tests/integration/tempo-analysis.test.ts`
- [ ] **Step 3: Implement** — spawn ffmpeg, collect capped PCM (reuse the constants from `preview-bpm.ts`: 22050 Hz, 20 s decode timeout, 40 s-of-PCM cap), convert s16le → Float32Array, `estimateTempo`. `startSeconds = max(0, durationMs/2000 − 30)`.
- [ ] **Step 4: Run to green**, then the whole companion integration project.
- [ ] **Step 5: Commit** — `companion: a tempo measured from the file itself — a minute from the middle, through ffmpeg, into the shared estimator`.

### Task 2: The after-scan pass

**Files:**
- Modify: `windows-companion/src/main/index.ts` (after the `scanFolder` loop's `finally` — the scan owner queues the pass)
- Modify: `windows-companion/src/main/store.ts` (a `tracksNeedingTempo(limit)` query: `bpm IS NULL`, readable files only)
- Test: `windows-companion/tests/integration/tempo-pass.test.ts`

**Interfaces:**
- Produces: `runTempoPass(store, deps, signal)` — drains `tracksNeedingTempo` one at a time; each answer `store.upsertTrack({ ...record, track: { ...track, bpm, bpmSource: 'analysis' } })`; skipped entirely when `resolveTool('ffmpeg')` is absent; a new scan's controller aborts it and the scan's completion starts a fresh pass.

- [ ] **Step 1: Failing test:** seed the store with three tracks — one tagged 128, one `bpm null` with a real generated WAV (the `_shell`-style click WAV written to a temp folder), one pointing at a missing file. After `runTempoPass` with the fake-ffmpeg seam: the tagged row untouched (Review Focus 1), the null row measured with `bpmSource 'analysis'`, the missing-file row still null, no throw (Focus 4). Second test: abort mid-pass → remaining rows untouched (Focus 3). Third: `ffmpegPath null` → no rows touched, a single notice recorded (Focus 2).
- [ ] **Steps 2–4:** RED → implement → GREEN + whole project.
- [ ] **Step 5: Commit** — `companion: after a scan, the files with no tempo get measured — one at a time, behind everything else`.

### Task 3: The Library view says which tempos were measured

**Files:**
- Modify: `windows-companion/src/renderer/views/Library.tsx` (Tempo column: the value; `≈` prefix + `title="Measured from the audio"` when `bpmSource === 'analysis'`; the one-line "Tempo needs ffmpeg" note when ffmpeg is absent and null-bpm rows exist)
- Test: `windows-companion/tests/dom/companion-shell.dom.test.tsx` (extend)

- [ ] Steps: failing DOM assertions (tagged row plain `128`, measured row `≈120` with the title, the ffmpeg note), implement, green, commit — `companion: the Library names each tempo's provenance — a tag is plain, a measurement wears ≈`.

### Task 4: Gates, docs, push

- [ ] `node scripts/verify.mjs` — all gates; fix forward.
- [ ] Append the shipped record to `.agents/plans/2026-09-21-airwave-oneshot.md`; extend the Hermes prompt §3.4 (companion) with: "add a folder of untagged music; tempos appear with ≈ within a few minutes of the scan; a tagged file's tempo is never changed; without ffmpeg the view says so once."
- [ ] Commit docs, push `claude/airwave-oneshot-build`.

## Self-review
- Spec sub-project 3 coverage: decode+estimate (T1), scan hook & priority & skip rules (T2), the view (T3), sync-to-hub rides the existing store→sync path (bpm already travels; asserted in T2's store assertions), docs/push (T4). Placeholders: T1's helper-import path is named as a fact-check with its anchor (`helper.ts:133`). Review Focus items each name their pinning task.
