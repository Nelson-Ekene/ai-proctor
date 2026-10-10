import type { EvidenceRef } from '@proctor/core';

// Local evidence store (IndexedDB, extension origin). Holds ONLY frames linked to an anomaly
// (and their burst), waiting for the Phase 6 upload queue. Normal sampled frames never get here.

export const EVIDENCE_DB = 'proctor-evidence';
export const FRAME_STORE = 'frames';
/** Audio clips (Phase 5): only clips of detected speech, never continuous audio. */
export const CLIP_STORE = 'clips';

export interface StoredFrame {
  id: string;
  sessionId: string;
  ts: number;
  kind: 'frame';
  mime: string;
  blob: Blob;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => {
      resolve(req.result);
    };
    req.onerror = () => {
      reject(req.error ?? new Error('IndexedDB request failed'));
    };
  });
}

export interface StoredClip {
  id: string;
  sessionId: string;
  /** Clip start, epoch ms. */
  ts: number;
  durationMs: number;
  kind: 'audio';
  mime: string;
  blob: Blob;
}

export function openEvidenceDb(): Promise<IDBDatabase> {
  // v1: frames (Phase 4); v2: clips (Phase 5).
  const open = indexedDB.open(EVIDENCE_DB, 2);
  open.onupgradeneeded = () => {
    const db = open.result;
    for (const name of [FRAME_STORE, CLIP_STORE]) {
      if (!db.objectStoreNames.contains(name)) {
        db.createObjectStore(name, { keyPath: 'id' }).createIndex('sessionId', 'sessionId');
      }
    }
  };
  return request(open);
}

export async function putClip(db: IDBDatabase, clip: StoredClip): Promise<EvidenceRef> {
  const tx = db.transaction(CLIP_STORE, 'readwrite');
  await request(tx.objectStore(CLIP_STORE).put(clip));
  return { id: clip.id, kind: 'audio', ts: clip.ts };
}

export async function putFrame(db: IDBDatabase, frame: StoredFrame): Promise<EvidenceRef> {
  const tx = db.transaction(FRAME_STORE, 'readwrite');
  await request(tx.objectStore(FRAME_STORE).put(frame));
  return { id: frame.id, kind: 'frame', ts: frame.ts };
}

/** Frame metadata (no pixels) for one session; used by tests and the Phase 6 queue. */
export async function listFrames(
  db: IDBDatabase,
  sessionId: string,
): Promise<Omit<StoredFrame, 'blob'>[]> {
  const tx = db.transaction(FRAME_STORE, 'readonly');
  const all = await request(tx.objectStore(FRAME_STORE).index('sessionId').getAll(sessionId));
  return (all as StoredFrame[]).map(({ blob: _blob, ...meta }) => meta);
}
