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
