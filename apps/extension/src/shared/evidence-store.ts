import type { EvidenceRef, QueueItemMeta } from '@proctor/core';

// Local evidence store (IndexedDB, extension origin, shared by the offscreen document and the
// service worker). Holds ONLY evidence linked to an anomaly (frames + bursts, speech clips) and
// the upload queue. Normal sampled frames and silent audio never get here. Media is deleted as
// soon as the server acknowledges its upload.

export const EVIDENCE_DB = 'proctor-evidence';
export const FRAME_STORE = 'frames';
/** Audio clips (Phase 5): only clips of detected speech, never continuous audio. */
export const CLIP_STORE = 'clips';
/** Upload queue (Phase 6): survives worker and browser restarts. */
export const QUEUE_STORE = 'queue';

export type MediaStore = typeof FRAME_STORE | typeof CLIP_STORE;

export interface StoredFrame {
  id: string;
  sessionId: string;
  ts: number;
  kind: 'frame';
  mime: string;
  blob: Blob;
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

/** The HTTP request an item stands for. Media bodies stay in their store until sent. */
export interface QueuedRequest {
  apiBase: string;
  /** Session token. Persisted so the queue can drain after a browser restart. */
  token: string;
  method: 'POST' | 'PUT';
  path: string;
  contentType: string;
  /** Inline JSON body (anomaly record, event sequence, consent, end). */
  body?: string;
  /** Media body (frame or clip) read from IndexedDB at send time. */
  media?: { store: MediaStore; id: string };
}

export interface QueueItem extends QueueItemMeta {
  request: QueuedRequest;
  /** Retry settings from the session's policy snapshot. */
  retry: { retryBaseMs: number; retryMaxMs: number; maxQueueBytes: number };
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

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => {
      resolve();
    };
    tx.onerror = () => {
      reject(tx.error ?? new Error('IndexedDB transaction failed'));
    };
    tx.onabort = () => {
      reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    };
  });
}

export async function openEvidenceDb(): Promise<IDBDatabase> {
  // v1: frames (Phase 4); v2: clips (Phase 5); v3: upload queue (Phase 6).
  const open = indexedDB.open(EVIDENCE_DB, 3);
  open.onupgradeneeded = () => {
    const db = open.result;
    for (const name of [FRAME_STORE, CLIP_STORE, QUEUE_STORE]) {
      if (!db.objectStoreNames.contains(name)) {
        db.createObjectStore(name, { keyPath: 'id' }).createIndex('sessionId', 'sessionId');
      }
    }
  };
  const db = await request(open);
  // Another context upgrading the schema must not be blocked by this connection.
  db.onversionchange = () => {
    db.close();
  };
  return db;
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

/** Frame metadata (no pixels) for one session. */
export async function listFrames(
  db: IDBDatabase,
  sessionId: string,
): Promise<Omit<StoredFrame, 'blob'>[]> {
  const tx = db.transaction(FRAME_STORE, 'readonly');
  const all = await request(tx.objectStore(FRAME_STORE).index('sessionId').getAll(sessionId));
  return (all as StoredFrame[]).map(({ blob: _blob, ...meta }) => meta);
}

export async function getMedia(
  db: IDBDatabase,
  ref: { store: MediaStore; id: string },
): Promise<Blob | undefined> {
  const tx = db.transaction(ref.store, 'readonly');
  const row = (await request(tx.objectStore(ref.store).get(ref.id))) as
    StoredFrame | StoredClip | undefined;
  return row?.blob;
}

export async function deleteMedia(
  db: IDBDatabase,
  ref: { store: MediaStore; id: string },
): Promise<void> {
  const tx = db.transaction(ref.store, 'readwrite');
  tx.objectStore(ref.store).delete(ref.id);
  await done(tx);
}

export interface MediaRecord {
  store: MediaStore;
  id: string;
  sessionId: string;
}

/** Ids and sessions of every stored frame and clip (for the orphan sweep). */
export async function listMedia(db: IDBDatabase): Promise<MediaRecord[]> {
  const out: MediaRecord[] = [];
  for (const store of [FRAME_STORE, CLIP_STORE] as const) {
    const tx = db.transaction(store, 'readonly');
    const rows = (await request(tx.objectStore(store).getAll())) as {
      id: string;
      sessionId: string;
    }[];
    for (const row of rows) out.push({ store, id: row.id, sessionId: row.sessionId });
  }
  return out;
}

export async function listQueue(db: IDBDatabase): Promise<QueueItem[]> {
  const tx = db.transaction(QUEUE_STORE, 'readonly');
  return (await request(tx.objectStore(QUEUE_STORE).getAll())) as QueueItem[];
}

export async function putQueueItems(db: IDBDatabase, items: readonly QueueItem[]): Promise<void> {
  const tx = db.transaction(QUEUE_STORE, 'readwrite');
  for (const item of items) tx.objectStore(QUEUE_STORE).put(item);
  await done(tx);
}

export async function deleteQueueItems(db: IDBDatabase, ids: readonly string[]): Promise<void> {
  const tx = db.transaction(QUEUE_STORE, 'readwrite');
  for (const id of ids) tx.objectStore(QUEUE_STORE).delete(id);
  await done(tx);
}
