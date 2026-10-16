# Architecture

How each part of Hawkeye works. For a short overview, see the [README](../README.md). For the
original contracts and build phases, see [BUILD_PLAN.md](../BUILD_PLAN.md).

```
Candidate browser (extension)                 Backend (Fastify)              Dashboard (React)
 ├─ Service worker (orchestrator)              ├─ REST API                    ├─ Session list (ranked)
 │   session token, policy, queue, upload      ├─ Risk engine (packages/core) ├─ Risk report + timeline
 ├─ Offscreen doc (camera + mic + models)      ├─ Evidence store (S3)         ├─ Evidence viewer
 │   video sampler, audio monitor              ├─ Postgres                    ├─ Policy settings
 ├─ Content script (browser rule engine)       └─ Audit log, retention job    └─ Metrics, export
 └─ Consent + setup-check pages
```

**Words used here**

- **Anomaly:** one thing a detector noticed at one moment (for example, no face in a frame).
- **Violation:** anomalies of the same type merged within a time window, with a count, severity,
  confidence and links to evidence.
- **Policy:** every number the system uses (weights, thresholds, sampling, retention). Defaults
  are in `DEFAULT_POLICY` (`packages/core/src/policy.ts`). Each session keeps a snapshot.

All rules and scoring are pure TypeScript in `packages/core`, which has no browser or Node APIs.
The extension, the backend and the dashboard all use the same code.

## Session start

`Proctor.start({ sessionToken, apiBase, extensionId })` in the [SDK](../packages/sdk):

1. The extension resolves the token with `GET /v1/sessions/current`, which returns the session id
   and its policy snapshot.
2. A consent notice, generated from the policy, is shown. The decision is saved with
   `POST /v1/sessions/:id/consents`. Declining or closing the notice records `declined` and
   nothing starts. The host page is told through the SDK (`consent_declined`). The extension
   never blocks or ends the exam.
3. A setup check tests the camera, microphone, face visibility and device speed. The result is
   `ready` or `needs_attention` and never stops the exam. Only the camera and microphone
   permissions are required.
4. An offscreen document opens the camera and microphone. The toolbar badge shows `ON` and an
   in-page indicator appears. The SDK emits `ready`.

Closing the exam tab ends the session and turns the media off. A page refresh does not end it.

Allowed exam and API origins are fixed when the extension is built (see
[DEVELOPMENT.md](DEVELOPMENT.md#extension-build-options)). The extension has no broad host
access.

## Browser events

The rule engine runs in the service worker. Its state and a rolling log (type + timestamp only,
kept for `capture.logRetentionSeconds`, 60 s by default) live in `chrome.storage.session`, so they
survive worker restarts and page refreshes.

- **Content script** (`apps/extension/src/content/monitor.ts`): fullscreen, visibility,
  blur/focus (ignoring focus moving into an iframe), copy/cut/paste, refresh shortcuts, completed
  reloads, and activity pings. It sends only `{kind, ts}`. Key values, clipboard data, URLs and
  page text are never read or sent.
- **Service worker**: tab and window focus changes, and a `chrome.alarms` tick as the inactivity
  fallback for throttled background tabs.

Flags: `fullscreen_exit`, `tab_switch_or_blur`, `copy_paste`, `refresh_attempt`, `inactivity`.

## Webcam

The offscreen document takes `sampling.framesPerWindow` frames every `sampling.windowSeconds`
(5 per 30 s by default), one at a random moment in each slot, and runs bundled MediaPipe models
on each frame:

| Model                           | Used for                                                |
| ------------------------------- | ------------------------------------------------------- |
| BlazeFace short-range           | `no_face`, `multiple_faces`                             |
| EfficientDet-Lite0 (COCO)       | `phone_detected`, `book_or_notes`, an additional person |
| Face Landmarker (+ pose matrix) | head direction for `gaze_away_sustained`                |

- Rules are in `packages/core/src/video.ts`. Thresholds come from `policy.video` and
  `policy.gazeAway`.
- A frame with no finding is discarded without being encoded. A frame with a finding is stored as
  JPEG evidence (IndexedDB) together with `capture.burstFrames` extra frames.
- "Looking away" uses head direction, not eye tracking. It must last
  `gazeAway.sustainedSeconds` to be flagged.
- On slow devices, if inference takes longer than `video.inferenceBudgetMs`, sampling drops to
  `video.degradedFramesPerWindow` for the rest of the session. The session records this.

### Optional face matching (off by default)

This checks that the face at the camera stays the same as at the start of the session. It never
identifies anyone. It runs only when the policy sets `faceMatch.enabled` **and** the candidate
ticks a separate, unticked opt-in on the consent notice.

- The SFace model (bundled, onnxruntime-web) runs on a face crop aligned from BlazeFace keypoints.
  A reference is built from a few frames right after the camera starts.
- `face_mismatch` is raised when `faceMatch.consecutiveSamples` frames in a row fall below
  `faceMatch.minSimilarity`.
- Templates and embeddings exist only in the offscreen document's memory. They are never stored,
  sent to the service worker or uploaded. The evidence is the flagged frame and the reference
  frame.
- Rules: `packages/core/src/face-match.ts`. Read [PRIVACY_REVIEW.md](PRIVACY_REVIEW.md) and
  [FAIRNESS.md](FAIRNESS.md) before enabling it.

## Microphone

In the same offscreen document, audio goes through an AudioWorklet (16 kHz, 32 ms frames) into
Silero VAD (bundled ONNX model):

- While nobody speaks, audio exists only in a rolling in-memory buffer (`audio.bufferSeconds`,
  10 s). Nothing is stored or uploaded.
- When speech lasts `audio.minSpeechMs`, a clip is kept: the buffer plus audio until
  `audio.silenceEndMs` of silence, up to `audio.maxClipSeconds` (30 s).
- Each clip is stored as WAV evidence and linked to `speech_detected`, and also to
  `multiple_voices` if a pitch heuristic suggests more than one voice. That heuristic is low
  confidence and needs calibrating in the pilot.

Rules: `packages/core/src/audio.ts`.

## Evidence capture and upload

Every anomaly opens a **capture window**: browser events from 30 s before to 15 s after, a burst
of frames, and any overlapping speech clip. When the window closes, the anomaly and its evidence
go into a persistent upload queue (IndexedDB) in the service worker:

- **Order:** consent decision, then anomalies by severity (each record before its evidence), then
  the end record.
- **Retries:** exponential backoff (`upload.*` policy) scheduled with `chrome.alarms`, so the
  queue survives worker and browser restarts and drains when the connection returns.
- **No double counting:** every request carries an `Idempotency-Key`.
- HTTPS only (plain HTTP for localhost). Local media is deleted once the server confirms receipt.
  A size cap evicts whole low-value anomaly groups first.

## Scoring

```
category score  S_c  = min(100, Σ severity points × confidence)   for browser, video, audio
risk                 = w_browser·S_browser + w_video·S_video + w_audio·S_audio
band                 = Low (≤ 29) · Medium (≤ 59) · High (60–100)
```

Defaults: weights 40 / 40 / 20; severity points low 5, medium 15, high 30. Example from the PRD:
category scores 50 / 60 / 25 give **49.0, Medium**. This is a test that must always pass.

The code is in `packages/core/src/scoring.ts` and `merge.ts`. The backend re-scores whenever new
anomalies arrive. `GET /v1/sessions/:id/report` recomputes the score from the stored violations
and the session's policy snapshot, and reports `reproducible: true` when it matches the stored
score.

## Backend API

Fastify + Postgres (Drizzle) + S3-compatible storage (MinIO in development). Migrations run when
the server starts.

| Caller           | Credential                                  | Can do                                        |
| ---------------- | ------------------------------------------- | --------------------------------------------- |
| Exam provider    | API key `pak_…` (admin creates/revokes)     | `POST /v1/sessions` (returns a session token) |
| Extension        | session token `pst_…` (12 h, one session)   | current, consents, anomalies, evidence, end   |
| Reviewer / admin | login token `put_…` (8 h, `/v1/auth/login`) | sessions, reports, exports, evidence URLs     |
| Admin only       | login token                                 | policies, audit, exams, keys, users, metrics  |

Main routes:

- `POST /v1/sessions/:id/anomalies`, `PUT /v1/sessions/:id/evidence/:evidenceId`,
  `POST /v1/sessions/:id/end` (extension)
- `GET /v1/sessions` (ranked by risk), `GET /v1/sessions/:id/report`, PDF/JSON export
- `GET /v1/sessions/:id/evidence/:evidenceId/url`: a signed URL valid for 60 s
- `GET/PUT /v1/policies`, `DELETE /v1/policies/exams/:examId`
- `GET /v1/audit`, `GET /v1/metrics`

**Evidence** is accepted only if an anomaly's manifest lists it and it matches the declared kind
(JPEG, WAV, or an event sequence of type + timestamp only). It is stored encrypted under a random
key and read only through short-lived signed URLs.

**Policies** are versioned: an organisation default plus optional per-exam overrides.

**Audit log:** every session list, report view or export, evidence URL, policy change, login and
admin action is recorded.

**Retention:** an hourly job deletes sessions and their stored objects after the snapshot's
`retentionDays`, and logs each deletion.

**Regions:** each organisation has a region (`apps/api/src/regions.ts`) that caps retention and
lists the valid consent notice versions.

**Hardening:** login rate limiting (`LOGIN_MAX_FAILURES` per `LOGIN_WINDOW_MS`) and security
headers on every response.

Schemas shared with the extension: `packages/core/src/protocol-schemas.ts`.

## Dashboard

React + Vite + TanStack Query + Tailwind, for reviewers and admins.

- **Sessions:** ranked by risk with Low / Medium / High badges. Filter by band, status or exam.
- **Report:** score and band, the per-category breakdown (points → capped score → × weight →
  contribution), a timeline and the flagged moments. Selecting a moment shows how its points were
  calculated and its evidence: frames, audio, and the browser event window. Export as PDF or
  JSON. Every report shows the policy used.
- **Policy** (admins edit, reviewers read): weights, bands, severities, sampling, windows,
  thresholds and retention, for the organisation or one exam. **Preview score impact** re-scores a
  sample session before a new version is saved.
- **Metrics** (admins): share of flagged moments with evidence (target 100%), setup-check
  completion rate, and reviewer time per session.

## Design decisions

These are choices the PRD left open. All of them can be changed in the policy.

- **A merged violation's count does not multiply its points** (`merge.countMultipliesPoints =
false`). A behaviour repeated within one window counts once.
- **The merge window** (60 s) starts at the violation's first anomaly. It is not chained, so a
  behaviour repeated all session gives one violation per window.
- **Band edges:** risk is rounded to 2 decimal places. `<= lowMax` is Low and `<= mediumMax` is
  Medium, so 29.01 is Medium.
- **Severity is read from the policy at scoring time**, so the same violations can be re-scored
  under a different policy.
- **Weights may be 0** (for example, an exam without audio) but must add up to 1.
- **Setup-check thresholds** (mic level, face presence, inference speed) are not in the PRD and
  should be calibrated in the pilot.

More open questions: [BUILD_PLAN.md section 9](../BUILD_PLAN.md).
