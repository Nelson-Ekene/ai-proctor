import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Webcam fixtures for Phase 4 e2e tests. Images are downloaded at test time (never committed),
// pinned by SHA-256, letterboxed to 640x480 and written as single-frame MJPEG files that
// Chrome's fake camera (--use-file-for-fake-video-capture) plays in a loop.
// Chosen by running the bundled models over candidates (see BUILD_PLAN section 12).

export const VIDEO_FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '.cache', 'video');

export interface VideoFixture {
  /** What the on-device models should raise for this scene ("none" for the control). */
  expect:
    | 'none'
    | 'no_face'
    | 'multiple_faces'
    | 'phone_detected'
    | 'book_or_notes'
    | 'gaze_away_sustained';
  url: string;
  sha256: string;
  /** Optional crop [x, y, width, height] in source pixels before letterboxing. */
  crop?: [number, number, number, number];
  credit: string;
}

export const VIDEO_FIXTURES = {
  // One frontal face (score 0.95, yaw 2°): no video violation expected.
  face: {
    expect: 'none',
    url: 'https://storage.googleapis.com/mediapipe-assets/portrait.jpg',
    sha256: 'a6f11efaa834706db23f275b6115058fa87fc7f14362681e6abe14e82749de3e',
    credit: 'MediaPipe test asset (Apache-2.0)',
  },
  // Kitchen, no person, no face.
  noFace: {
    expect: 'no_face',
    url: 'http://images.cocodataset.org/val2017/000000000802.jpg',
    sha256: 'd5b79e7fa716f85ca86f46e5f518da9b6c5e26414925624d76e6476861aec495',
    credit: 'COCO val2017 #802 (Flickr licence, see cocodataset.org)',
  },
  // Two people facing the camera (faces 0.96 / 0.81).
  twoPeople: {
    expect: 'multiple_faces',
    url: 'https://storage.googleapis.com/mediapipe-assets/man-woman-okay.jpg',
    sha256: '064bbf589dc1a2e05dff7e3fdddd00bbe5c5feadf4fd350f0e515f5a6bbfbbc4',
    credit: 'MediaPipe test asset (Apache-2.0)',
  },
  // Person holding a phone up (cell phone 0.69 after crop).
  phone: {
    expect: 'phone_detected',
    url: 'http://images.cocodataset.org/val2017/000000001296.jpg',
    sha256: '34a98da7c11bc8811e6eec445145bb16f3d5f4338945ba116edcc1fe554d181b',
    crop: [0, 60, 427, 320],
    credit: 'COCO val2017 #1296 (Flickr licence, see cocodataset.org)',
  },
  // Person reading a book (book 0.74).
  book: {
    expect: 'book_or_notes',
    url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Middle-aged%20woman%20reading%20a%20book%20closeup.jpg?width=800',
    sha256: 'a0323595aa62d9003467806323447e32c99b040302d77b14f9aaa1f96f605568',
    credit:
      '"Middle-aged woman reading a book closeup" by Shixart1985, CC BY 2.0, Wikimedia Commons',
  },
  // One face turned away (yaw 46°).
  lookingAway: {
    expect: 'gaze_away_sustained',
    url: 'http://images.cocodataset.org/val2017/000000004395.jpg',
    sha256: '14ffbd7ab7a01e0dd7fc9676a688bd2c916766e2edb6e1d12ac9ae0ed07b122a',
    credit: 'COCO val2017 #4395 (Flickr licence, see cocodataset.org)',
  },
} as const satisfies Record<string, VideoFixture>;

export type VideoFixtureName = keyof typeof VIDEO_FIXTURES;

export function videoFixturePath(name: VideoFixtureName): string {
  return join(VIDEO_FIXTURE_DIR, `${name}.mjpeg`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function download(fixture: VideoFixture): Promise<Buffer> {
  const res = await fetch(fixture.url, {
    headers: { 'user-agent': 'AIProctorE2E/0.1 (test fixtures)' },
  });
  if (!res.ok) throw new Error(`fixture download failed (${String(res.status)}): ${fixture.url}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (sha !== fixture.sha256) {
    throw new Error(`fixture checksum mismatch for ${fixture.url}: got ${sha}`);
  }
  return bytes;
}

/** Downloads, verifies and converts any missing fixture. Idempotent. */
export async function prepareVideoFixtures(): Promise<void> {
  const todo: VideoFixtureName[] = [];
  for (const name of Object.keys(VIDEO_FIXTURES) as VideoFixtureName[]) {
    if (!(await exists(videoFixturePath(name)))) todo.push(name);
  }
  if (todo.length === 0) return;

  await mkdir(VIDEO_FIXTURE_DIR, { recursive: true });
  const browser = await chromium.launch({ channel: 'chromium' });
  try {
    const page = await browser.newPage();
    for (const name of todo) {
      const fixture: VideoFixture = VIDEO_FIXTURES[name];
      const source = await download(fixture);
      const jpegBase64 = await page.evaluate(
        async ({ b64, crop }) => {
          const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
          const full = await createImageBitmap(new Blob([bytes]));
          const src = crop ? await createImageBitmap(full, ...crop) : full;
          const canvas = new OffscreenCanvas(640, 480);
          const ctx = canvas.getContext('2d');
          if (!ctx) throw new Error('no 2d context');
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, 640, 480);
          const scale = Math.min(640 / src.width, 480 / src.height);
          const w = src.width * scale;
          const h = src.height * scale;
          ctx.drawImage(src, (640 - w) / 2, (480 - h) / 2, w, h);
          // Chromium's encoder writes baseline JPEG, which the fake camera can play as MJPEG.
          const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
          const out = new Uint8Array(await blob.arrayBuffer());
          let s = '';
          for (const b of out) s += String.fromCharCode(b);
          return btoa(s);
        },
        { b64: source.toString('base64'), crop: 'crop' in fixture ? fixture.crop : undefined },
      );
      await writeFile(videoFixturePath(name), Buffer.from(jpegBase64, 'base64'));
    }
  } finally {
    await browser.close();
  }
}
