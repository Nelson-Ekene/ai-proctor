# AI Proctoring Chrome Extension: Build Plan for Claude Code

Source: `AI_Proctoring_Extension_PRD.pdf` (Oct 2, 2026). Keep the PRD in the repo at `docs/PRD.pdf`.

**How to use this file:** put it at the repo root as `BUILD_PLAN.md`, copy the "CLAUDE.md" block in section 2 into `CLAUDE.md`, then work through the phases in order. Each phase has a ready-to-paste prompt, a definition of done, and tests. Do one phase per Claude Code session (use `/clear` between phases), and commit at the end of each.

---

## 1. Product in one paragraph

A Chrome (Manifest V3) extension samples webcam frames (5 random per 30 s), monitors audio on-device (clip saved only on anomaly), and logs browser events. Any anomaly becomes a **violation** (type, time, severity, confidence, evidence). A backend turns violations into a weighted **risk score (0-100, Low/Medium/High)**. A dashboard lets human reviewers see the score, timeline and evidence. **The system never passes, fails, blocks or disqualifies anyone.**

## 2. CLAUDE.md (paste into repo root)

```markdown
# Project: AI Proctoring Extension
Read BUILD_PLAN.md and docs/PRD.pdf before starting any task.

## Hard rules
- Advisory only. No pass/fail/disqualify/block/end-test state anywhere in code, UI copy, API or DB.
- No face recognition, no biometric templates, no identity verification.
- No screen recording or capture of test content. No full video/audio recording.
- Raw media leaves the device only as sampled frames or anomaly audio clips.
- Browser events: store event type + timestamp only (no URLs, no page content, no keystrokes).
- Every violation must link to evidence. Every score must be reproducible from violations + the policy snapshot.
- All thresholds, weights, severities, window sizes, sampling rates come from the Policy object, never hard-coded outside DEFAULT_POLICY.

## Stack
TypeScript everywhere, pnpm workspaces, Vitest, ESLint + Prettier, zod for schemas.
Extension: Vite + @crxjs/vite-plugin, MV3. Backend: Fastify + Postgres (Drizzle) + S3-compatible storage (MinIO in dev).
Dashboard: React + Vite + TanStack Query + Tailwind. On-device ML: MediaPipe Tasks Vision (WASM) + Silero VAD (onnxruntime-web).

## Conventions
- Pure logic (scoring, sampling, merging, rule engine) lives in `packages/core` with no DOM/Chrome/Node APIs, 100% unit tested.
- Never put camera/mic code in the service worker (MV3 limitation). Use an offscreen document.
- Small commits, one phase at a time. Run `pnpm test && pnpm lint && pnpm typecheck` before declaring done.
```

## 3. Architecture

```
Candidate browser (extension)                 Backend (Fastify)              Dashboard (React)
 ├─ Service worker (orchestrator)              ├─ REST API                    ├─ Session list (ranked)
 │   session token, policy, queue, upload      ├─ Risk engine (packages/core) ├─ Risk report + timeline
 ├─ Offscreen doc (camera + mic + models)      ├─ Evidence store (S3)         ├─ Evidence viewer
 │   video sampler, audio monitor              ├─ Postgres                    ├─ Policy settings
 ├─ Content script (browser rule engine)       └─ Audit log, retention job    └─ Export (PDF, JSON)
 └─ Popup / consent + setup-check page
```

Data flow: detectors emit **anomalies** to the orchestrator, which opens a **capture window**, packages evidence, and uploads it. Backend converts anomalies to **violations** (merge, severity, confidence), recomputes the score, stores the policy snapshot. Policy flows back down to the extension at session start.

## 4. Monorepo layout

```
/
├─ BUILD_PLAN.md, CLAUDE.md, docs/PRD.pdf
├─ packages/
│   ├─ core/        # types, zod schemas, DEFAULT_POLICY, scoring, sampler, merger, rule engine (pure TS)
│   ├─ sdk/         # host-page SDK: start session, receive events
│   └─ ui/          # (optional) shared React components
├─ apps/
│   ├─ extension/   # MV3 extension
│   ├─ api/         # Fastify backend
│   └─ dashboard/   # React admin app
├─ infra/           # docker-compose (postgres, minio), seed scripts
└─ e2e/             # Playwright tests (with fake camera/mic flags)
```

## 5. Core contracts (build these first, everything depends on them)

### 5.1 Policy (all values are PRD defaults; admin-configurable per org or exam)

```ts
DEFAULT_POLICY = {
  weights: { browser: 0.40, video: 0.40, audio: 0.20 },   // must sum to 1
  severityPoints: { low: 5, medium: 15, high: 30 },
  bands: { lowMax: 29, mediumMax: 59 },                    // High = 60-100
  severityByType: { /* from violation catalogue below */ },
  sampling: { framesPerWindow: 5, windowSeconds: 30 },     // 5 slots of 6 s, 1 random moment per slot
  audio: { bufferSeconds: 10, maxClipSeconds: 30 },
  capture: { eventsBeforeSeconds: 30, eventsAfterSeconds: 15, burstFrames: 3 },
  merge: { windowSeconds: 60 },        // ASSUMPTION: PRD says "short span", pick 60 s, configurable
  inactivity: { seconds: 60 },         // ASSUMPTION: not specified in PRD
  gazeAway: { sustainedSeconds: 5 },   // ASSUMPTION: not specified in PRD
  retentionDays: 30,                   // ASSUMPTION: open question in PRD
}
```

### 5.2 Violation catalogue (default severity, confidence source)

| Type | Category | Severity | Confidence |
|---|---|---|---|
| fullscreen_exit | browser | medium | 1.0 |
| tab_switch_or_blur | browser | medium | 1.0 |
| copy_paste | browser | low | 1.0 |
| refresh_attempt | browser | low | 1.0 |
| inactivity | browser | low | 1.0 |
| no_face | video | medium | model |
| multiple_faces | video | high | model |
| phone_detected | video | high | model |
| book_or_notes | video | medium | model |
| gaze_away_sustained | video | low | model |
| speech_detected | audio | medium | model |
| multiple_voices | audio | high | model |

### 5.3 Scoring (pure function, the heart of the product)

```
S_c  = min(100, Σ points(severity_i) × confidence_i × count_i?)   // see note
Risk = w_b·S_b + w_v·S_v + w_a·S_a
band = Low (<=29) | Medium (30-59) | High (>=60)
```

Note: the PRD merges repeats into one violation "with a count" but does not say whether the count multiplies points. **Default: count does NOT multiply (one merged violation = one contribution).** Put this behind a policy flag `merge.countMultipliesPoints=false` and flag it as an open question in the README.

Required test (from the PRD example): browser 50, video 60, audio 25 with weights 40/40/20 gives **49.0, Medium**.

Output shape: `{ risk, band, categories: [{category, weight, score, contribution}], violations: [...], policySnapshot }`.

### 5.4 Data model (Postgres)

`organisations`, `exams`, `policies` (org/exam scoped, versioned), `sessions` (token, candidate_ref, exam_id, policy_snapshot jsonb, started_at, ended_at, risk, band), `violations` (session_id, type, category, severity, confidence, first_ts, last_ts, count), `evidence` (violation_id, kind: frame|audio|event_sequence, storage_key, ts), `consents`, `users`/`roles` (admin, reviewer), `audit_log` (actor, action, target, ts).

### 5.5 REST API (v1)

- `POST /v1/sessions` (integrator, API key): start session, returns session token + policy snapshot
- `GET /v1/sessions/current` (session token): returns the session and its policy snapshot (named to avoid confusion with the ranked list `GET /v1/sessions`)
- `POST /v1/sessions/:id/consents` (session token): records accept or decline, with a timestamp and the notice version
- `POST /v1/sessions/:id/anomalies` (session token): anomaly + evidence manifest
- `PUT /v1/sessions/:id/evidence/:evidenceId` (session token): upload frame/clip (or presigned URL flow)
- `POST /v1/sessions/:id/end`
- `GET /v1/sessions` (ranked by risk), `GET /v1/sessions/:id/report`, `GET /v1/sessions/:id/report.pdf|json`
- `GET/PUT /v1/policies`, `GET /v1/audit`
- Every GET of a session/evidence/export and every policy change writes an `audit_log` row.

---

## 6. Phases

### Phase 0: Scaffold (0.5 day)

**Prompt:** "Read BUILD_PLAN.md sections 4 and 5. Scaffold the pnpm monorepo exactly as laid out. Set up TypeScript project references, Vitest, ESLint, Prettier, a root `pnpm test/lint/typecheck`, GitHub Actions CI, and `infra/docker-compose.yml` with Postgres and MinIO. No feature code yet."

**Done when:** `pnpm install && pnpm test && pnpm lint && pnpm typecheck` pass on an empty skeleton; `docker compose up` starts Postgres and MinIO.

### Phase 1: `packages/core`, the pure logic (1-2 days)

Build, with tests first:
1. Types + zod schemas: Policy, Anomaly, Violation, Evidence, Report. Policy validation: weights sum to 1, bands ordered, all numbers positive.
2. `DEFAULT_POLICY` and the violation catalogue (5.1, 5.2).
3. `sampleFrameTimes(windowStart, policy, rng)`: split the window into N equal slots, one random moment per slot. Inject the RNG so tests are deterministic. Test: always exactly N times, one per slot, strictly ordered.
4. `mergeViolations(anomalies, policy)`: same type within merge window becomes one violation with count, first_ts, last_ts, max confidence.
5. `computeRisk(violations, policy)` per 5.3, including the 49.0 example test, the 100 cap per category, weights not summing to 1 rejected.
6. Browser rule engine as a pure state machine: input = raw events (fullscreenchange, visibilitychange, blur, focus, copy, paste, beforeunload/refresh keys, activity pings), output = anomalies and the rolling event log (type + timestamp only). Include inactivity timer logic driven by an injected clock.
7. Capture window builder: given an anomaly time and the rolling log, return events from -30 s to +15 s.

**Done when:** core has ≥95% coverage, zero runtime dependencies besides zod.

### Phase 2: Extension shell, session start, consent (2 days)

1. MV3 manifest: permissions `offscreen`, `storage`, `alarms`, `tabs`; host permissions only for the exam origin(s) from config; `externally_connectable` for the host exam site; no broad `<all_urls>`.
2. SDK (`packages/sdk`): `Proctor.start({ sessionToken, apiBase })` messages the extension via `chrome.runtime.sendMessage`; emits `ready`, `consent_declined`, `ended`.
3. Service worker orchestrator: holds session state in `chrome.storage.session`, fetches policy snapshot, survives worker restarts (no in-memory-only state).
4. Consent page (plain-language: what is captured, why, how long) with required accept, stored to backend as a `consents` record. No capture before consent.
5. Pre-test setup check page: camera + mic permission, live preview, a face-detected check, mic level check, and a lightweight device performance check. Report pass/needs-attention (this is a setup check, not an exam result).
6. Visible recording indicator (badge + in-page overlay via content script) while camera/mic are on.

**Done when:** a mock host page can start a session; declining consent means nothing starts; indicator shows during capture.

### Phase 3: Browser rule engine in the extension (1 day)

Content script feeds raw DOM events into the Phase 1 state machine; service worker adds `chrome.tabs`/`chrome.windows` signals for tab switch and window focus. Anomalies go to the orchestrator. Log is a rolling buffer (type + timestamp, last ≥60 s).

**Done when:** manual test page triggers each of the 5 browser violation types; the log contains no URLs, text or keystrokes (assert in a test).

### Phase 4: Video sampler + on-device analysis (3 days)

1. Offscreen document (`reasons: ["USER_MEDIA"]`) opens `getUserMedia`, owns the camera stream.
2. Sampler uses `sampleFrameTimes` to grab 5 frames per 30 s into an `OffscreenCanvas`.
3. Models (MediaPipe Tasks Vision, bundled locally, **no remote model fetches at runtime**): face detector (count: 0 = no_face, >1 = multiple_faces), face landmarker (head pose / iris proxy for gaze), object detector (phone, book; person for additional person).
4. Per-frame findings with confidence. Gaze-away becomes a violation only when sustained across consecutive samples for `gazeAway.sustainedSeconds`. Apply a minimum confidence threshold (policy-configurable) before raising an anomaly.
5. Only frames tied to an anomaly (plus the burst) are kept and uploaded; all other sampled frames are analysed and discarded.
6. Degrade gracefully on slow devices: measure inference time, lower sampling/model size if over budget, record this in the session metadata.

**Done when:** with Chrome's fake camera feed and fixture images, each video violation type is detected; non-anomalous frames are never persisted or uploaded.

### Phase 5: Audio monitor (2 days)

1. In the same offscreen document, mic stream into an AudioWorklet, then Silero VAD (onnxruntime-web, bundled).
2. Ring buffer of `audio.bufferSeconds` (10 s) in memory only. Nothing uploaded while silent.
3. On speech: emit `speech_detected`, save buffer + audio until silence, capped at 30 s, encode to a compact clip (Opus/WebM via MediaRecorder or WAV for MVP).
4. **Multiple voices:** this is the hardest requirement. MVP approach: heuristic overlap/speaker-change detection using speaker embeddings on short windows, with confidence output. Isolate behind an interface `MultiVoiceDetector` so the model can be swapped; ship a clearly labelled lower-confidence implementation and record accuracy in the pilot. Do not claim more accuracy than measured.

**Done when:** a fixture WAV with one speaker raises `speech_detected` with clip; silence produces no upload; the clip never exceeds 30 s.

### Phase 6: Anomaly trigger, capture window, upload queue (2 days)

1. Orchestrator: on any anomaly, build the capture package: browser events -30/+15 s, burst of 3 extra frames, audio clip if present.
2. Upload client with encrypted transport (HTTPS only), retry with exponential backoff, and an IndexedDB offline queue that survives browser restarts and drains on reconnect. Idempotency keys so retries never double-count a violation.
3. Queue size cap and priority (anomaly evidence before low-value events). On session end, flush.
4. Route the best-effort consent decline record (Phase 2) through the offline queue so it eventually reaches the server.
5. Use `chrome.alarms` for upload retry scheduling (survives service-worker restarts). If it turns out not to be needed, remove the `alarms` permission before release.
6. Delete each evidence frame from the local IndexedDB store (`proctor-evidence`, written by Phase 4) once its upload is acknowledged, and purge local evidence of sessions that ended more than `retentionDays` ago or were abandoned, so nothing lingers on the candidate's device.

**Done when:** an e2e test simulates network loss mid-session; all evidence arrives exactly once after reconnect.

### Phase 7: Backend (3 days)

1. Fastify + Drizzle migrations for the 5.4 schema; zod-validated routes per 5.5.
2. Auth: integrator API keys (start sessions), short-lived session tokens (extension), user login with roles admin/reviewer (dashboard). RBAC middleware.
3. Evidence upload to S3/MinIO, encrypted at rest (SSE), object keys not guessable, access only via short-lived signed URLs issued after an audit-logged check.
4. Anomaly ingestion: validate, merge into violations (core), recompute risk (core), store policy snapshot on the session.
5. Report endpoint (JSON), PDF export (server-side render), audit log on every view/export/policy change.
6. Retention job: scheduled deletion of evidence + data after `retentionDays`, audit-logged.
7. Policy CRUD with versioning; org-level default with optional per-exam override.

**Done when:** API integration tests (Vitest + testcontainers) cover auth, RBAC, merge, scoring, retention, audit. A report regenerates the identical score from stored violations + policy snapshot.

### Phase 8: Dashboard (3 days)

1. Session list ranked by risk with band badges, filters.
2. Session report: score, band, per-category contribution table (matches the PRD sample), violation list (type, time, severity, confidence, category).
3. Timeline of violations in order of occurrence.
4. Evidence viewer per violation: frames, audio player, browser event sequence.
5. Policy settings: weights (enforce sum = 100), bands, severity per type, sampling, windows, retention. Show a "preview score impact" on a sample session.
6. Export PDF/JSON; show the policy used on every report.
7. UI language audit: only "Low / Medium / High risk" and "flagged for review". Never "cheating", "failed", "guilty".

**Done when:** a reviewer can open a seeded session and trace every point of the score to a violation and its evidence in a few clicks.

### Phase 9: Hardening, privacy, pilot readiness (2-3 days)

1. Privacy review checklist: consent gate, no biometric templates, no content capture, retention works, data minimisation test (assert uploads only contain frames/clips/event sequences).
2. Fairness test harness: fixture set varying lighting, glasses, skin tone, camera quality, disability-related movement; report detection rates and confidence; document known limits in the report footer ("second device or screen is out of scope in v1").
3. Performance budget: measure extension CPU/memory and upload volume per session; set pilot targets.
4. Chrome Web Store packaging, privacy policy text, region config for consent and retention.
5. Metrics hooks: % violations with linked evidence (must be 100%), setup-check completion rate, reviewer time per session.

### Phase 10: Post-MVP (not in v1)

False-positive marking to feed calibration; live monitoring; other browsers/mobile; multi-monitor detection. Keep the interfaces ready but do not build.

---

## 7. Release mapping (from PRD)

| PRD release | Phases |
|---|---|
| MVP: extension, consent, sampling, rules, score, basic report | 0-6, minimal 7 and 8 (report only) |
| Pilot: admin policy, timeline, evidence viewer, calibration | rest of 7 and 8, 9 |
| GA: SDK/REST hardening, audit, retention automation, export | 7 (retention, audit, export), 9 |

## 8. Testing strategy

- **Unit (Vitest):** all of `packages/core`. Seeded RNG, injected clock.
- **Integration:** API against real Postgres + MinIO via testcontainers.
- **E2E (Playwright):** Chromium with `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream --use-file-for-fake-video-capture=<fixture.y4m> --use-file-for-fake-audio-capture=<fixture.wav>` and the extension loaded; scripted exam page triggers browser violations.
- **Golden test:** PRD sample (50/60/25 at 40/40/20 = 49.0 Medium) must always pass.
- **Guardrail tests:** grep-style test failing the build if `pass`, `fail`, `disqualif`, `block` appear as product states in API schemas or UI strings.

## 9. Assumptions to confirm (PRD open questions and gaps)

1. Audio: on-device monitoring, clip only on anomaly (assumed per PRD).
2. Browser events: always-on lightweight log, full sequence only around anomalies (assumed per PRD).
3. Live monitoring: excluded from v1.
4. Weights: org-level default + per-exam override (build both; cheap).
5. Retention default 30 days, regions TBD: config-driven.
6. Merge window (60 s), inactivity (60 s), sustained gaze (5 s), minimum model confidence: not in PRD, chosen here and policy-configurable.
7. Whether merged-violation count multiplies points: default no, flagged.
8. Multiple-voice detection accuracy is unproven: treat as pilot-calibrated.

## 10. Suggested first Claude Code message

> Read CLAUDE.md, BUILD_PLAN.md and docs/PRD.pdf. Start Phase 0 only. Before writing code, summarise your plan in 10 lines and list any assumption you are making. Stop when Phase 0's "Done when" criteria pass and show me the commands you ran.

## 11. Decisions made

- **Extension ID:** `Proctor.start` takes `extensionId` as a third argument. The dev ID is pinned by `build:dev`; production e2e tests read the real ID at runtime. Before release the production ID must be fixed, either via the Chrome Web Store ID or a self-generated key pinned in the manifest, and the SDK should export a default production ID constant so integrators don't need to pass it.
- **Consent:** accepting proceeds only after the server saves the consent record. Declining always succeeds locally. Closing the notice tab counts as declining. Declining only notifies the host page via the SDK (`consent_declined`); the extension never blocks or ends the exam itself.
- **Setup check:** never blocks. Results are `ready` or `needs_attention`. Only camera and microphone permission gate progress.
- **Tab lifecycle:** closing the exam tab ends the session and turns media off. A page refresh must NOT end the session.
- **Open question (note only):** should hosts be able to resume a session after an accidental tab close?
- **Best-effort uploads stay out of the serialised orchestrator queue** (end record, decline record). Local state and the host-page notification never wait on the network; "ended" is persisted before teardown. Every queued task and teardown step is traced at `console.debug`.
- **Phase 4 video rules** (`packages/core/src/video.ts`, all thresholds in `policy.video` / `policy.gazeAway`):
  - `no_face` confidence = 1 − best (sub-threshold) face score; `multiple_faces` confidence = second-best face or person score (an additional person the face model misses still counts).
  - Gaze is a head-pose proxy (yaw/pitch from the Face Landmarker matrix); `gaze_away_sustained` needs consecutive away samples spanning `gazeAway.sustainedSeconds`, one anomaly per run.
  - Slow devices: when the median inference time of the last window exceeds `video.inferenceBudgetMs`, sampling drops to `video.degradedFramesPerWindow` for the rest of the session (sticky, never below the normal rate) and is recorded as `videoMeta` on the session.
  - Only anomalous frames plus `capture.burstFrames` extra frames (not analysed) are JPEG-encoded and stored (IndexedDB, extension origin) for the Phase 6 upload queue; every other frame is closed unencoded.
- **Phase 4 e2e fixtures** are downloaded at test time (pinned SHA-256, never committed) from MediaPipe test assets, COCO val2017 and Wikimedia Commons (credits in `e2e/video-fixtures.ts`), chosen by running the bundled models over candidates.
- **Phase 5 audio** (`packages/core/src/audio.ts`, all thresholds in `policy.audio`):
  - Silero VAD v5 (bundled ONNX, onnxruntime-web single-threaded wasm, loaded from `vendor/onnx` via the `onnxruntime-web-use-extern-wasm` condition) scores every 32 ms frame at 16 kHz in the offscreen document (AudioWorklet → monitor).
  - While silent, audio exists only in a rolling in-memory buffer of `audio.bufferSeconds`. A clip starts after `audio.minSpeechMs` of speech, contains the buffer + speech until `audio.silenceEndMs` of silence, and is hard-capped at `audio.maxClipSeconds`. After a capped clip nothing is recorded until silence returns, so continuous talking never becomes continuous recording.
  - `speech_detected` is raised when its clip is stored (so it always has evidence), stamped at speech start, confidence = mean VAD probability of the speech frames. Clips are 16 kHz mono WAV in IndexedDB (`clips` store, DB v2) for the Phase 6 queue.
  - `multiple_voices` uses the `MultiVoiceDetector` interface; the shipped `pitch-cluster-heuristic-v1` is labelled low-confidence (capped at `multiVoice.maxConfidence` 0.6). Calibrated on one real single-speaker recording: intonation reached a 1.63 pitch-group ratio, so `minPitchRatio` is 1.7 (0 false positives on that recording at 5–30 s clips). Accuracy on real multi-speaker audio is unmeasured: pilot item.
  - The offscreen document reports `audioMeta.listening` once the model analyses live frames, and forwards its warnings/counters to the service-worker log (`diag` messages) for diagnostics.
- **Phase 6 capture packages and uploads** (`packages/core/src/capture-package.ts`, `upload.ts`; `apps/extension/src/background/uploader.ts`):
  - Every anomaly (browser, video, audio) gets a stable id when detected and opens a capture window. The browser events from `capture.eventsBeforeSeconds` before are snapshotted at detection (the rolling log may drop them before packaging); the events up to `capture.eventsAfterSeconds` after are added when the window closes. Anomalies without frames (browser, audio) ask the offscreen document for a burst of `capture.burstFrames` frames; audio clips overlapping the window are linked too. Each package always links at least its event sequence, so no violation is ever uploaded without evidence.
  - Upload order: consent decision (priority 100), anomaly groups by severity (high > medium > low), end record last (priority 1, so its arrival means everything queued earlier was sent). Evidence depends on its anomaly record (record first). Over `upload.maxQueueBytes`, whole lowest-value anomaly groups are evicted (never session records; never part of a group).
  - Retries: exponential backoff with equal jitter between `upload.retryBaseMs` and `upload.retryMaxMs`, scheduled with `chrome.alarms` (survives worker/browser restarts) plus a timer for sub-30 s delays. 408/429/5xx/network errors retry; other 4xx are dropped and logged. HTTPS only (http allowed for localhost dev).
  - Exactly once: each item's id is sent as `Idempotency-Key`; the server stores a key once and acknowledges repeats (verified with a mock that processes a request and then drops the reply).
  - The queue lives in IndexedDB (`queue` store, DB v3) with the session token, so it drains after a browser restart; it drains on worker start, `runtime.onStartup` and the retry alarm. Media is deleted locally once acknowledged; items (and their media) expire after `retentionDays`.
  - The consent decline record and the end record go through the queue. At session end the offscreen document stops its media tracks immediately and hands over a speech clip still in progress before it is closed (closing is bounded to 3 s and finishes in the background if Chrome is slow).

## 12. Known gaps

- ~~The setup face check reports "needs attention" under Chrome's fake camera.~~ Resolved in Phase 4: with a real-face fixture the face check reports Ready (e2e test). Chrome's default fake feed (no face) still reports "needs attention", correctly.
- There is no extension popup (only the badge and its title). Not required by the PRD.
- CI has not yet run on a real GitHub remote: the local repo has no remote configured, so the Actions workflow is unverified.
- Phase 3: if the candidate drags the exam tab into another window, window-focus signals keep using the original window id until the next session (tab visibility from the content script still works). Shown to reviewers as a documented limitation in the report footer (`REPORT_LIMITATIONS` in `packages/core/src/report-footer.ts`, rendered in Phase 8).
- Phase 3: a refresh via keyboard shortcut produces two `refresh_attempt` anomalies (the key press and the completed reload); the merger collapses them into one violation.
- Phase 3 follow-up: the e2e suite is sensitive to severe CPU starvation of the test machine (Chrome calls such as closing the offscreen document took 12–24 s while other heavy jobs ran in parallel). Stability loops must run on an otherwise idle machine; CI runs retry once and keep traces.
- Phase 4: the Face Landmarker returns no pose for a face seen fully in profile, so an extreme head turn reads as "face present, direction unknown", not gaze away. Documented in `REPORT_LIMITATIONS`.
- Phase 4: EfficientDet-Lite0 scores isolated books and shelves low (0.2–0.45 in our probes); a book held/read in front of the camera scores ~0.7. Loose paper notes are not a COCO class and are not detected. Documented in `REPORT_LIMITATIONS`.
- Phase 4: no lighter model variant exists for the face landmarker/object detector in the bundle, so slow-device degradation lowers the sampling rate only.
- Phase 5: the multiple-voice heuristic mostly misses two voices of similar pitch (e.g. two adult men) and has not been measured on real multi-speaker audio; documented in `REPORT_LIMITATIONS`, to be calibrated or replaced (speaker embeddings) in the pilot.
- ~~Phase 5: when a session ends mid-speech, the in-progress clip is lost.~~ Resolved in Phase 6: the service worker asks the offscreen document to flush before closing it.
- Phase 6: Chrome's `offscreen.closeDocument()` took over 40 s in one heavy e2e run (camera + microphone evidence, busy machine). Media tracks are now stopped by the document itself and the close is bounded, so the session and the indicator never wait for it; root cause in Chrome not investigated further.
- Phase 6: the session token is stored with queued items (IndexedDB, extension origin) so uploads can resume after a browser restart. Tokens should be short-lived and scoped to uploads for one session (Phase 7 auth).
- Phase 6: the "event sequence" for a window closing while the worker is asleep is packaged at the next wake-up (rule tick alarm, at most every 30 s); the snapshot keeps the "before" part complete.
- Phase 5: the extension build is ~49 MB (MediaPipe wasm SIMD + non-SIMD ~23 MB, onnxruntime wasm 14 MB, models ~13 MB). Track in the Phase 9 performance budget (e.g. drop the non-SIMD MediaPipe build if all target Chrome versions have SIMD).
- Phase 5 e2e: audio scenarios load four models before speech can be detected; under heavy CPU load (e.g. another Chrome running the extension with live models) model start-up takes tens of seconds, so tests time speech from `audioMeta.listening`, not from session start.
