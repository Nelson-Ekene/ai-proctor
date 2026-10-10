import { EventSequenceSchema } from '@proctor/core';
import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from './db/client';
import { evidence } from './db/schema';
import { badRequest, conflict, parse } from './errors';
import { newStorageKey } from './security';
import type { EvidenceStorage } from './storage';

/** Content type each evidence kind must be uploaded with. */
export const EVIDENCE_CONTENT_TYPE = {
  frame: 'image/jpeg',
  audio: 'audio/wav',
  event_sequence: 'application/json',
} as const;

type Kind = keyof typeof EVIDENCE_CONTENT_TYPE;

function isJpeg(b: Buffer): boolean {
  return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}

function isWav(b: Buffer): boolean {
  return (
    b.length > 44 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WAVE'
  );
}

/** Checks an evidence body is what its manifest says (data minimisation: nothing else). */
function evidenceBody(kind: Kind, body: unknown): Buffer {
  if (kind === 'event_sequence') {
    const sequence = parse(EventSequenceSchema, body);
    return Buffer.from(JSON.stringify(sequence));
  }
  if (!Buffer.isBuffer(body)) throw badRequest('evidence body missing');
  if (kind === 'frame' ? !isJpeg(body) : !isWav(body)) {
    throw badRequest(`evidence is not a valid ${EVIDENCE_CONTENT_TYPE[kind]} file`);
  }
  return body;
}

/**
 * Stores one evidence item of a session. It must be listed in an anomaly manifest, arrive with
 * its kind's content type and be valid content. Idempotent: an item already stored is kept.
 * `body` is a Buffer for media and the parsed JSON for event sequences.
 */
export async function storeEvidence(
  db: Db,
  storage: EvidenceStorage,
  input: { sessionId: string; evidenceId: string; contentType: string; body: unknown; now: Date },
): Promise<{ duplicate: boolean }> {
  const where = and(eq(evidence.sessionId, input.sessionId), eq(evidence.id, input.evidenceId));
  const [item] = await db.select().from(evidence).where(where);
  if (!item) throw conflict('evidence is not referenced by any anomaly of this session');
  if (item.uploadedAt) return { duplicate: true };

  const contentType = EVIDENCE_CONTENT_TYPE[item.kind];
  if (input.contentType !== contentType) {
    throw badRequest(`${item.kind} evidence must be uploaded as ${contentType}`);
  }
  const body = evidenceBody(item.kind, input.body);
  const storageKey = newStorageKey();
  await storage.put(storageKey, body, contentType);
  const updated = await db
    .update(evidence)
    .set({ storageKey, contentType, bytes: body.length, uploadedAt: input.now })
    .where(and(where, isNull(evidence.uploadedAt)))
    .returning({ id: evidence.id });
  if (updated.length === 0) {
    // A concurrent retry stored it first: keep theirs, remove ours.
    await storage.remove([storageKey]);
    return { duplicate: true };
  }
  return { duplicate: false };
}
