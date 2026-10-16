import { createHash } from 'node:crypto';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Face-matching fixtures (Phase 11): two different photos each of a few people, so the
// face-matching harness can measure same-person and different-person similarity. Official US
// government portraits (public domain), downloaded at test time (never committed) and pinned by
// SHA-256. A tiny set of well-lit studio portraits: a smoke test of the pipeline, not an
// accuracy or fairness measurement (docs/FAIRNESS.md).

export const FACE_FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '.cache', 'faces');

export interface FaceFixture {
  person: string;
  url: string;
  sha256: string;
  credit: string;
}

const commons = (file: string) =>
  `https://commons.wikimedia.org/wiki/Special:FilePath/${file}?width=800`;
const PD = 'official US government portrait, public domain, Wikimedia Commons';

export const FACE_FIXTURES = {
  obama2009: {
    person: 'A',
    url: commons('Official_portrait_of_Barack_Obama.jpg'),
    sha256: 'ff969230b4a2262c450c1c3ef3187db18f0c880665bc0342c6cae1a7e1e40612',
    credit: `"Official portrait of Barack Obama" (2009), ${PD}`,
  },
  obama2012: {
    person: 'A',
    url: commons('President_Barack_Obama.jpg'),
    sha256: '0b290c69894c6779b0345b6665fe828a7b2de96c415943265ecadf9ad15a38ba',
    credit: `"President Barack Obama" (2012), ${PD}`,
  },
  biden2021: {
    person: 'B',
    url: commons('Joe_Biden_presidential_portrait.jpg'),
    sha256: '06225d222bb1222c1ee02042823b19af1b1882707d61234513d97783f09839e6',
    credit: `"Joe Biden presidential portrait" (2021), ${PD}`,
  },
  biden2013: {
    person: 'B',
    url: commons('Joe_Biden_official_portrait_2013_cropped.jpg'),
    sha256: 'b58d1d003c6b0d905c3e45a59ce941e338d0e4fa47eb5c60304a042e96773614',
    credit: `"Joe Biden official portrait 2013" (cropped), ${PD}`,
  },
  harris2021: {
    person: 'C',
    url: commons('Kamala_Harris_Vice_Presidential_Portrait.jpg'),
    sha256: '22fd8e58884f35e04a237ecdc926dcf927f742c71552fe04a23472858ad166bf',
    credit: `"Kamala Harris Vice Presidential Portrait" (2021), ${PD}`,
  },
  harris2017: {
    person: 'C',
    url: commons('Senator_Harris_official_senate_portrait.jpg'),
    sha256: '26cee887e7c7bd0e5e2fd385c01c0abf3aae8388623c4621f2c2aa9d0cb9c3f0',
    credit: `"Senator Harris official senate portrait" (2017), ${PD}`,
  },
} as const satisfies Record<string, FaceFixture>;

export type FaceFixtureName = keyof typeof FACE_FIXTURES;

export function faceFixturePath(name: FaceFixtureName): string {
  return join(FACE_FIXTURE_DIR, `${name}.jpg`);
}

/** Downloads and verifies any missing fixture. Idempotent. */
export async function prepareFaceFixtures(): Promise<void> {
  await mkdir(FACE_FIXTURE_DIR, { recursive: true });
  for (const name of Object.keys(FACE_FIXTURES) as FaceFixtureName[]) {
    const path = faceFixturePath(name);
    try {
      await access(path);
      continue;
    } catch {
      // not downloaded yet
    }
    const fixture: FaceFixture = FACE_FIXTURES[name];
    const res = await fetch(fixture.url, {
      headers: { 'user-agent': 'AIProctorE2E/0.1 (test fixtures)' },
    });
    if (!res.ok) throw new Error(`fixture download failed (${String(res.status)}): ${fixture.url}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const sha = createHash('sha256').update(bytes).digest('hex');
    if (sha !== fixture.sha256) {
      throw new Error(`fixture checksum mismatch for ${fixture.url}: got ${sha}`);
    }
    await writeFile(path, bytes);
  }
}
