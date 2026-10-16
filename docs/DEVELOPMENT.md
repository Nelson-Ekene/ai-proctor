# Development

You need Node 24+, pnpm 10, Docker (running) and Google Chrome or Chromium. For the quickest way to
run everything together, use `pnpm demo` (see the [README](../README.md#quick-start-try-the-whole-thing)).

```sh
pnpm install
pnpm test        # Vitest across all workspaces (API tests start Postgres/MinIO via testcontainers)
pnpm lint        # ESLint + Prettier check
pnpm typecheck   # tsc -b over project references
pnpm format      # fix formatting
```

CI (`.github/workflows/ci.yml`) runs `test`, `lint`, `typecheck`, the full e2e suite and a
docker-compose check on every push to `main` and on pull requests.

## Running parts separately

### Databases

```sh
docker compose -f infra/docker-compose.yml up -d   # Postgres :5432, MinIO :9000 (console :9001)
```

`minio-init` is a one-shot container that creates the private `evidence` bucket and exits.
Because of that, `up --wait` reports a non-zero exit. Use `up -d --wait postgres minio` and then
`up minio-init` if you need to wait until they are healthy.

Default credentials are dev-only and can be overridden in `infra/.env` (see
`infra/.env.example`).

### Backend

```sh
cp apps/api/.env.example apps/api/.env
pnpm --filter @proctor/api seed            # prints admin/reviewer logins and an integrator API key
pnpm --filter @proctor/api seed -- --demo  # also adds 4 demo sessions with synthetic evidence
pnpm --filter @proctor/api dev             # http://localhost:4000, runs migrations on start
```

Settings are read from `apps/api/.env` and validated in `apps/api/src/config.ts`. They include
`DATABASE_URL`, `S3_*`, `S3_PUBLIC_ENDPOINT`, `CORS_ORIGINS`, `LOGIN_MAX_FAILURES`,
`LOGIN_WINDOW_MS` and `SEED_REGION`.

### Dashboard

```sh
pnpm --filter @proctor/dashboard dev   # http://localhost:5173, proxies /v1 to :4000
```

### Extension

```sh
pnpm --filter @proctor/sdk build
pnpm --filter @proctor/extension build       # production build -> apps/extension/build
pnpm --filter @proctor/extension build:dev   # dev key: stable ID akponalihmmaihgcnonegjelddajfdka
```

Load `apps/extension/build` in Chrome (`chrome://extensions` → Developer mode → Load unpacked).
The build downloads the ML models (SHA-256 pinned) into `public/vendor`. The extension never
fetches models at runtime.

**Without the real backend:** run `pnpm --filter @proctor/e2e mock` and open
http://localhost:4400. The mock API understands test tokens that speed things up:

| Token                   | Effect                               |
| ----------------------- | ------------------------------------ |
| `?token=tok-fastidle`   | 3 s inactivity                       |
| `?token=tok-fastvideo`  | one webcam sample per second         |
| `?token=tok-fastaudio`  | 5 s audio clip cap                   |
| `?token=tok-fastupload` | short capture windows, quick retries |

The mock API can also simulate network trouble:
`POST /__test/network?mode=down|up|drop-after&count=N`.

### Extension build options

Allowed origins are fixed at build time:

| Variable               | Default                 | Used for                                               |
| ---------------------- | ----------------------- | ------------------------------------------------------ |
| `PROCTOR_EXAM_ORIGINS` | `http://localhost:4400` | content script, `externally_connectable`, sender check |
| `PROCTOR_API_ORIGINS`  | `http://localhost:4401` | host permissions, `apiBase` allow-list                 |

Origins must be HTTPS (plain HTTP is allowed only for localhost).

## Tests

| Command                           | What it runs                                                   | Needs            |
| --------------------------------- | -------------------------------------------------------------- | ---------------- |
| `pnpm test`                       | unit, component and API integration tests                      | Docker           |
| `pnpm test:e2e`                   | all e2e suites below, after building the SDK and extension     | Docker, Chromium |
| `pnpm --filter @proctor/e2e test` | extension against the mock API                                 | Chromium         |
| `pnpm test:e2e:dashboard`         | dashboard against the real API with seeded data                | Docker           |
| `pnpm test:e2e:fullstack`         | extension + demo exam site + real API: privacy and performance | Docker           |
| `pnpm test:e2e:fairness`          | detection across lighting, camera quality and movement         | Chromium         |

The e2e suites run Chromium with a fake camera and microphone. Video and audio fixtures are
downloaded at test time with pinned SHA-256 hashes and are never committed. First-time setup:
`pnpm --filter @proctor/e2e exec playwright install chromium`.

### Debugging e2e failures

- Each run writes to its own folders: `e2e/test-results/<run-id>` and
  `e2e/playwright-report/<run-id>` (HTML + `results.json`). Failing runs are always kept. Only
  the five most recent passing runs are kept.
- On failure you get a trace, screenshots and a video of every open page.
- Every test attaches `extension-diagnostics.log`, with service-worker, extension and exam-page
  console output, navigations and uncaught errors.
- Time limits: 60 s per test, 15 s per action, 20 s per navigation, 15 s per `expect`.
- Stability check: `pnpm --filter @proctor/e2e loop 20` runs the suite up to 20 times and stops
  at the first failure. Build the SDK and extension first.

## Project rules

The hard rules (advisory only, privacy limits, everything configurable through the policy) are in
[CLAUDE.md](../CLAUDE.md). Pure logic belongs in `packages/core` and must be fully unit tested.
Camera and microphone code runs in the offscreen document, never in the service worker. Run
`pnpm test && pnpm lint && pnpm typecheck` before committing.

When behaviour changes, update [ARCHITECTURE.md](ARCHITECTURE.md). Update the README only if the
setup steps or the overall flow change.

## Release checklist

- [ ] **Fix the production extension ID:** use the Chrome Web Store ID, or pin a self-generated
      key in the manifest. Export it from the SDK as the default `extensionId`.
- [ ] **Build with real origins:** set `PROCTOR_EXAM_ORIGINS` and `PROCTOR_API_ORIGINS`, then run
      `pnpm --filter @proctor/extension package`. Check that `build/manifest.json` lists only those
      origins (no wildcards, no `<all_urls>`).
- [ ] **Review permissions:** confirm `alarms`, `tabs` and `offscreen` are still needed.
- [ ] **Production storage encryption:** replace the dev `MINIO_KMS_SECRET_KEY` with a real KMS
      (or the cloud provider's server-side encryption) and set `S3_PUBLIC_ENDPOINT`.
- [ ] **Store listing:** text and permission justifications are in
      [STORE_LISTING.md](STORE_LISTING.md). Fill in the [privacy policy](privacy-policy.md).
- [ ] **CI is green** on the release commit.
