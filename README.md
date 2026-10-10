# AI Proctoring Extension

Advisory proctoring for online exams: a Chrome MV3 extension samples signals, a backend
produces an explainable risk score, and human reviewers decide. See `docs/PRD.pdf`,
`BUILD_PLAN.md` and `CLAUDE.md`.

## Layout

```
packages/core       pure logic (types, schemas, policy, scoring, sampler, merger, rule engine)
packages/sdk        host-page SDK
packages/ui         shared React components (optional)
apps/extension      MV3 extension
apps/api            Fastify backend
apps/dashboard      React reviewer/admin dashboard
infra/              docker-compose (Postgres, MinIO)
e2e/                Playwright tests
```

## Getting started

Requires Node 24+, pnpm 10 and Docker.

```sh
pnpm install
pnpm test        # Vitest across all workspaces
pnpm lint        # ESLint + Prettier check
pnpm typecheck   # tsc -b over project references

docker compose -f infra/docker-compose.yml up -d   # Postgres :5432, MinIO :9000 (console :9001)
```

`minio-init` is a one-shot that creates the private `evidence` bucket and exits 0. Because of
that, `up --wait` reports a non-zero exit; use `up -d --wait postgres minio` if you need to block
until healthy, then `up minio-init`.

## Extension

```sh
pnpm --filter @proctor/extension build       # production build -> apps/extension/build
pnpm --filter @proctor/extension build:dev   # adds a dev key: stable ID akponalihmmaihgcnonegjelddajfdka
pnpm test:e2e                                # builds SDK + extension, runs Playwright (fake camera/mic)
```

Allowed origins are fixed at build time (no broad host access):

| Variable               | Default                 | Used for                                               |
| ---------------------- | ----------------------- | ------------------------------------------------------ |
| `PROCTOR_EXAM_ORIGINS` | `http://localhost:4400` | content script, `externally_connectable`, sender check |
| `PROCTOR_API_ORIGINS`  | `http://localhost:4401` | host permissions, `apiBase` allow-list                 |

Origins must be HTTPS (plain HTTP only for localhost). The build downloads the MediaPipe face
model (SHA-256 pinned) into `public/vendor`; the extension never fetches models at runtime.

**Manual try-out:** run `pnpm --filter @proctor/sdk build`, `pnpm --filter @proctor/extension build:dev`
and `pnpm --filter @proctor/e2e mock`, load `apps/extension/build` as an unpacked extension in
Chrome, and open <http://localhost:4400>.

### Session flow

`Proctor.start({ sessionToken, apiBase, extensionId })` → the extension resolves the token via
`GET /v1/sessions/current` (session id + policy snapshot) → consent notice (generated from the policy) →
`POST /v1/sessions/:id/consents` → setup check (camera, mic, face, device speed; `ready` or
`needs_attention`, never a gate on the exam) → offscreen document opens camera + mic → badge
`ON` + in-page indicator → SDK `ready`. Declining or closing the notice records `declined` and
starts nothing. Ending, or closing the exam tab, closes the offscreen document.

### e2e diagnostics

- Each Playwright run writes to its own folder: `e2e/test-results/<run-id>` and
  `e2e/playwright-report/<run-id>` (HTML + `results.json`). Failing runs are always kept; only
  the five most recent passing runs are kept (pruned by `e2e/global-setup.ts`).
- On failure: trace, screenshots of every open page, and video of every page. Locally traces
  are `retain-on-failure` with no retries; in CI there is one retry, traced `on-first-retry`.
- Every test attaches `extension-diagnostics.log`: service-worker console output and
  start/termination, extension and exam page console output, navigations and uncaught errors.
- Budgets: 60 s per test, 15 s per action, 20 s per navigation, 15 s per `expect`.
- Stability loop: `pnpm --filter @proctor/e2e loop 20` runs the whole suite up to 20 times and
  stops at the first failure (build the SDK and extension first).

### Browser rule engine (Phase 3)

The rule engine from `packages/core` runs in the service worker; its state and rolling log
(type + timestamp only, `capture.logRetentionSeconds`, 60 s default) are kept in
`chrome.storage.session`, so they survive worker restarts and page refreshes. Inputs:

- **Content script** (`src/content/monitor.ts`): fullscreen, visibility, blur/focus (ignoring
  focus moving into an iframe), copy/cut/paste, refresh shortcuts, completed reloads (Navigation
  Timing), throttled activity pings and ticks every `inactivity.pingSeconds`. It sends only
  `{kind, ts}`; key values, clipboard data, URLs and page text are never read or sent.
- **Service worker**: `chrome.tabs.onActivated`, `chrome.windows.onFocusChanged`, and a
  `chrome.alarms` tick as the inactivity fallback for throttled background tabs.

Anomalies are kept on the session for Phase 6 to package and upload. To try it by hand, open
<http://localhost:4400/?token=tok-fastidle> (3 s inactivity) and follow the steps on the page.

### Webcam sampling and on-device analysis (Phase 4)

The offscreen document samples `sampling.framesPerWindow` frames per `sampling.windowSeconds`
(5 per 30 s by default) at CSPRNG-chosen moments, one per slot, and runs three bundled
MediaPipe models on each frame on the device:

| Model                           | Used for                                                   |
| ------------------------------- | ---------------------------------------------------------- |
| BlazeFace short-range           | face count: `no_face`, `multiple_faces`                    |
| EfficientDet-Lite0 (COCO)       | `phone_detected`, `book_or_notes`, additional `person`     |
| Face Landmarker (+ pose matrix) | head yaw/pitch for `gaze_away_sustained` (head-pose proxy) |

Rules live in `packages/core/src/video.ts`; every threshold is policy (`video.*`,
`gazeAway.*`). A frame with no finding is closed without being encoded. A frame with a
finding is stored as JPEG evidence (IndexedDB, extension origin) together with a burst of
`capture.burstFrames` extra frames, and the anomaly is kept on the session with links to those
frames for the Phase 6 upload queue. Nothing is uploaded yet. If inference is over
`video.inferenceBudgetMs`, sampling drops to `video.degradedFramesPerWindow` and the session
records `videoMeta.degraded`.

e2e fixtures (`e2e/video-fixtures.ts`) are downloaded once at test time with pinned SHA-256
hashes, letterboxed to 640×480 and played through Chrome's fake camera as MJPEG; nothing is
committed. Use `?token=tok-fastvideo` on the mock host for one sample per second.

### Microphone monitoring (Phase 5)

In the same offscreen document, the microphone goes through an AudioWorklet (16 kHz, 32 ms
frames) into Silero VAD (bundled ONNX model on onnxruntime-web, no runtime downloads):

- While nobody speaks, audio exists only in a rolling in-memory buffer (`audio.bufferSeconds`,
  10 s). Nothing is stored or uploaded.
- When speech lasts `audio.minSpeechMs`, a clip is kept: the buffer plus audio until
  `audio.silenceEndMs` of silence, never longer than `audio.maxClipSeconds` (30 s). After a
  capped clip, nothing is recorded again until there is silence.
- Each clip is stored as WAV evidence (IndexedDB, extension origin) and linked to
  `speech_detected`, plus `multiple_voices` if the heuristic indicates it. The multiple-voice
  check is a labelled low-confidence pitch heuristic behind the `MultiVoiceDetector` interface.

Try it on the mock host with `?token=tok-fastaudio` (5 s clip cap). e2e fixtures: Silero's
example speech file (pinned SHA-256) and generated silence, played through Chrome's fake
microphone.

### Evidence upload (Phase 6)

Every anomaly opens a capture window (browser events −30 s/+15 s, a burst of frames, any
overlapping speech clip). When the window closes, the anomaly record and its evidence go into a
persistent upload queue (IndexedDB) in the service worker:

- order: consent decision → anomalies by severity (record before its evidence) → end record;
- retries with exponential backoff (`upload.*` policy), scheduled with `chrome.alarms`, so the
  queue survives worker and browser restarts and drains on reconnect;
- `Idempotency-Key` = item id on every request, so retries never double-count;
- HTTPS only (http for localhost); local media deleted once acknowledged; a size cap evicts
  whole low-value anomaly groups.

API calls: `POST /v1/sessions/:id/anomalies`, `PUT /v1/sessions/:id/evidence/:evidenceId`,
`POST /v1/sessions/:id/consents`, `POST /v1/sessions/:id/end`. The mock API can simulate a
network outage or lost replies (`POST /__test/network?mode=down|up|drop-after&count=N`); use
`?token=tok-fastupload` for short windows and quick retries.

## Release checklist

- [ ] **Fix the production extension ID**: use the Chrome Web Store ID, or pin a self-generated
      key in the manifest. Export it from the SDK as the default `extensionId` so integrators
      don't need to pass it (BUILD_PLAN section 11).
- [ ] **Confirm `externally_connectable` origins**: build with the real `PROCTOR_EXAM_ORIGINS`
      and check `build/manifest.json` lists only those exam origins (no wildcards, no
      `<all_urls>`). `src/manifest.test.ts` guards the generator.
- [ ] **Remove unused permissions**: `alarms` is reserved for Phase 6 upload retries; drop it if
      Phase 6 does not use it. Re-check `tabs` and `offscreen` are still needed.
- [ ] **Verify CI**: the `check`, `e2e` and `infra` jobs pass on the release commit.

## Open questions

Tracked in BUILD_PLAN.md section 9. Decisions taken in code, all policy-configurable:

- **Does a merged violation's count multiply its points?** The PRD merges repeats "into one
  violation with a count" but does not say. Default: no (`merge.countMultipliesPoints = false`),
  so one merged violation contributes once.
- **Merge window** is anchored at the violation's first anomaly (60 s default), not chained, so
  a behaviour repeated all session produces one violation per window rather than one in total.
- **Band edges with fractional scores:** risk is rounded to 2 dp, then `<= lowMax` is Low and
  `<= mediumMax` is Medium. 29.01 is Medium under the default 29/59 bands.
- **Severity at scoring time** is read from the policy, not the stored violation, so the same
  violations can be re-scored under a different policy ("preview score impact").
- **Weights may be 0** (e.g. an exam without audio) but must sum to 1. `capture.burstFrames`
  may be 0. All other policy numbers must be positive.
- **Browser event log retention** is `capture.logRetentionSeconds` (60 s default), validated to
  cover the full -30 s / +15 s capture window.
- **Setup-check thresholds** (`setupCheck.*`: mic level 0.02, face in 50% of frames, 200 ms
  inference budget, 3 s sample) are not in the PRD; calibrate in the pilot.
- **Session-token endpoints** `GET /v1/sessions/current` and `POST /v1/sessions/:id/consents`
  are now in BUILD_PLAN 5.5. Their schemas live in `packages/core/src/protocol-schemas.ts`.
