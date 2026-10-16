import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app';
import { unauthorised } from '../errors';
import { runRetention } from '../retention';

/**
 * Scheduler hooks for serverless hosts, where no timer runs between requests. Registered only
 * when CRON_SECRET is set; the caller (Vercel Cron) sends `Authorization: Bearer <CRON_SECRET>`.
 */
export function registerInternalRoutes(app: FastifyInstance, deps: AppDeps): void {
  const secret = deps.config.CRON_SECRET;
  if (!secret) return;
  const expected = digest(`Bearer ${secret}`);

  app.get('/v1/internal/retention', async (req) => {
    if (!timingSafeEqual(digest(req.headers.authorization ?? ''), expected)) throw unauthorised();
    const result = await runRetention(deps.db, deps.storage, deps.now(), (m) => {
      req.log.warn(m);
    });
    req.log.info({ retention: result });
    return result;
  });
}

/** Fixed-length digest so the comparison takes the same time whatever the header length. */
function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}
