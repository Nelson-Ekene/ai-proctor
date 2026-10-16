# Deploying to Vercel

The API and the dashboard deploy as one Vercel project using
[Services](https://vercel.com/docs/services), configured in [`vercel.json`](../vercel.json):

| Path            | Goes to                          |
| --------------- | -------------------------------- |
| `/v1/...`       | the API (`apps/api`, Fastify)    |
| `/healthz`      | the API                          |
| everything else | the dashboard (`apps/dashboard`) |

The dashboard and the API share one domain, so no CORS setup is needed. The extension and the SDK
are not deployed. The extension is published to the Chrome Web Store.

## What runs differently on Vercel

The API notices it is on Vercel (the `VERCEL` variable) and switches to `SERVERLESS` mode:

- **Migrations** run at build time (`pnpm migrate`, the API service's build command), not on start.
- **The API is bundled** into one file (`pnpm build` → `apps/api/dist/server.mjs`), because Vercel
  runs the compiled code with plain Node, which can't resolve the source's extensionless imports.
- **Retention** (deleting expired sessions) has no timer, and **no schedule is set up yet**, so
  expired data is not deleted automatically on Vercel. See [Retention](#retention) below.
- **Uploads** are capped at 4 MB (`MAX_EVIDENCE_BYTES`), under Vercel's 4.5 MB request limit.

## One-time setup

1. **Import the repo** at vercel.com/new and keep the root directory as the repo root. Vercel
   reads `vercel.json`.
2. **Database:** Storage → Marketplace → **Neon** → create a database in an EU region and connect
   it to the project. This sets `DATABASE_URL` and `DATABASE_URL_UNPOOLED`.
3. **Evidence storage:** create a private bucket named `evidence` on an S3-compatible service
   (Cloudflare R2, AWS S3) and an access key for it.
4. **Environment variables** (Settings → Environment Variables):

| Variable        | Value                                             |
| --------------- | ------------------------------------------------- |
| `DATABASE_URL`  | set by Neon (pooled URL)                          |
| `DB_PREPARE`    | `false` (required behind Neon's pooler)           |
| `S3_ENDPOINT`   | e.g. `https://<account>.r2.cloudflarestorage.com` |
| `S3_REGION`     | `auto` for R2, the bucket's region for AWS        |
| `S3_BUCKET`     | `evidence`                                        |
| `S3_ACCESS_KEY` | storage access key id                             |
| `S3_SECRET_KEY` | storage secret key                                |

5. **Deploy.**
6. **Create the first logins:** copy the same database and storage values into `apps/api/.env` on
   your computer, set `DATABASE_URL` to the **unpooled** URL, and run
   `pnpm --filter @proctor/api seed`. It prints an admin and a reviewer login and an integrator API
   key. Set `SEED_PASSWORD` first to choose the password.
7. **Build the extension** for the deployed API:
   `PROCTOR_API_ORIGINS=https://<your-project>.vercel.app PROCTOR_EXAM_ORIGINS=https://<exam-site> pnpm --filter @proctor/extension package`.

## Checks after the first deploy

- `https://<your-project>.vercel.app/healthz` returns `{"ok":true}`.
- Signing in to the dashboard works, which shows that `/v1` reaches the API.
- Upload one piece of evidence and confirm the storage accepts server-side encryption
  (`ServerSideEncryption: AES256`). AWS S3 does. Check this for other providers.
- Exporting a report as PDF works.

## Retention

On an always-on host the API deletes expired sessions every hour. On Vercel nothing runs between
requests, so retention needs a scheduler, which is not set up yet. Before real candidates use the
system, turn it on:

1. Set `CRON_SECRET` (a random string of at least 16 characters, e.g. `openssl rand -hex 32`).
   This enables `GET /v1/internal/retention`, which requires `Authorization: Bearer <CRON_SECRET>`.
2. Call it on a schedule, for example by adding this to `vercel.json`:
   `"crons": [{ "path": "/v1/internal/retention", "schedule": "0 3 * * *" }]`
   (Vercel Cron sends the secret for you). It can also be called by hand with `curl`.

## Notes

- **Preview deployments** also run `pnpm migrate`. Turn on Neon's preview branching so previews get
  their own database branch instead of migrating production.
- Services are a beta Vercel feature. If the `vercel.json` format changes, see the
  [Services docs](https://vercel.com/docs/services).
- To run the API on an always-on host instead (Railway, Render, Fly.io), use
  `pnpm --filter @proctor/api start`. Migrations and retention then run inside the server as usual.
