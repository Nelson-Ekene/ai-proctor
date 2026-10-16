# Performance budget

BUILD_PLAN Phase 9.3. Measured by `e2e/fullstack/performance.spec.ts` (`pnpm test:e2e`, or
`pnpm --filter @proctor/e2e test:fullstack performance`): a real exam through the demo site with
the production extension build, Chrome's fake camera (one face) and fake microphone (continuous
speech, the worst case for uploads), default policy (5 frames per 30 s). CPU comes from Chrome's
per-process CPU time (DevTools protocol), memory from the JS heap of the offscreen document and the
service worker, uploads from a proxy in front of the API. The latest run is written to
`e2e/.cache/perf/latest.json`.

## Latest measurement (development PC, Windows 11, 2026-10-11)

| Metric                                                                     | Measured                           | Budget (test fails above)                                   | Pilot target                     |
| -------------------------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------- | -------------------------------- |
| Extra CPU while proctoring (whole browser, minus idle baseline)            | **0.35 cores**                     | 1.0 core                                                    | ≤ 0.5 core on a mid-range laptop |
| – of which on-device analysis (renderer: MediaPipe + Silero VAD)           | 0.21 cores                         | –                                                           | –                                |
| – of which Chrome capture services (video 0.11, audio 0.08) and GPU (0.07) | 0.26 cores                         | –                                                           | –                                |
| Offscreen document JS heap                                                 | **10.5 MB**                        | 150 MB                                                      | ≤ 100 MB                         |
| Service worker JS heap                                                     | **2.4 MB**                         | 30 MB                                                       | ≤ 20 MB                          |
| Upload volume (continuous speech + face)                                   | **1.34 MB/min** (~14 requests/min) | 5 MB/min                                                    | ≤ 2 MB/min typical               |
| Median model inference per sampled frame                                   | ~230 ms (3 models)                 | `video.inferenceBudgetMs` 250 ms triggers degraded sampling | –                                |

Notes:

- The JS heap excludes WebAssembly memory (MediaPipe, onnxruntime), which is allocated once at
  start-up; measure total process memory on pilot laptops with Chrome's task manager.
- Playwright tracing (screenshots) roughly triples browser/GPU CPU; the performance test runs with
  tracing off. A first run with tracing on measured 1.4 cores, almost all of it in the browser and
  GPU processes.
- Upload volume is dominated by speech clips (16 kHz WAV, ~32 KB/s). A typical quiet exam uploads
  far less; Opus encoding would cut clip size by ~10× (post-pilot option).
- Slow devices: when median inference exceeds `video.inferenceBudgetMs`, sampling drops to
  `video.degradedFramesPerWindow` and is recorded in the session metadata (Phase 4).

## Optional face matching (Phase 11)

Not part of the measurement above (face matching is off by default). Added cost when a session
uses it:

- **Inference:** SFace fp32 takes a median **~160 ms** per face (p90 ~200 ms) in onnxruntime-web's
  single-threaded wasm runtime on the development PC (measured in Node; Chrome uses the same wasm
  build). The int8 variant is 4× smaller but ran **~1,050 ms** per face, so fp32 is bundled.
- **When it runs:** once per sampled frame showing exactly one confident face (at most 5 per
  30 s by default ≈ 0.03 cores), plus up to `faceMatch.enrolMaxSeconds` × 1 frame/s at the start
  until the reference is formed (5 frames when the face is clearly visible).
- **Budget:** `video.inferenceBudgetMs` still judges the detection models only. Counting the
  embedding (~230 + 160 ms) would put every face-matching session over the 250 ms budget and
  halve its sampling rate even on fast devices.
- **Memory:** one 640×480 reference frame held for the session plus the model's wasm memory
  (~40 MB of weights). Re-measure total process memory on pilot laptops with it enabled.

## Extension size

The unpacked build is ~88 MB: MediaPipe wasm SIMD + non-SIMD ~23 MB, onnxruntime wasm 14 MB,
models ~52 MB, of which the face-matching model is 38.7 MB (bundled even when face matching is
off, because models are never fetched at runtime). Dropping the non-SIMD MediaPipe build (all
Chrome versions ≥ 116 support wasm SIMD) would save ~11 MB: pilot follow-up. Store zip size to be
re-measured after Phase 11.
