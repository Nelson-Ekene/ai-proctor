import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config';
import type { Db } from './db/client';
import { HttpError } from './errors';
import { registerDashboardRoutes } from './routes/dashboard';
import { registerExtensionRoutes } from './routes/extension';
import type { EvidenceStorage } from './storage';

export interface AppDeps {
  config: Config;
  db: Db;
  storage: EvidenceStorage;
  /** Injected clock (tests move time for token expiry and retention). */
  now: () => Date;
  logger?: boolean;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? false, trustProxy: true });

  // Frames and clips arrive as raw bodies; JSON (incl. event sequences) uses the default parser.
  app.addContentTypeParser(
    ['image/jpeg', 'audio/wav'],
    { parseAs: 'buffer', bodyLimit: deps.config.MAX_EVIDENCE_BYTES },
    (_req, body, done) => {
      done(null, body);
    },
  );

  await app.register(cors, {
    origin: deps.config.CORS_ORIGINS.length > 0 ? deps.config.CORS_ORIGINS : false,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    exposedHeaders: ['content-disposition'],
  });

  app.setErrorHandler((error, req, reply) => {
    if (error instanceof HttpError) {
      return reply.status(error.statusCode).send({ error: error.message });
    }
    const status =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? Number(error.statusCode)
        : 500;
    if (status >= 400 && status < 500) {
      // Fastify's own client errors (malformed JSON, body too large, unsupported type).
      return reply.status(status).send({ error: (error as Error).message });
    }
    req.log.error(error);
    return reply.status(500).send({ error: 'internal error' });
  });
  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: 'not found' }));

  // Security headers: the API serves JSON and files only, never pages to frame or sniff.
  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
    reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    reply.header('cache-control', 'no-store');
    if (req.protocol === 'https') {
      reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    }
  });

  app.get('/healthz', () => ({ ok: true }));
  registerExtensionRoutes(app, deps);
  registerDashboardRoutes(app, deps);
  return app;
}
