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

## Open questions

Tracked in BUILD_PLAN.md section 9.
