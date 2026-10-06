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