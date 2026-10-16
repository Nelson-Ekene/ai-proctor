import { expect, test, type Page } from '@playwright/test';
import { DEFAULT_POLICY } from '@proctor/core';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FACE_FIXTURES, faceFixturePath, type FaceFixtureName } from '../face-fixtures.ts';
import { extensionWorker, launchExtensionContext } from '../fixtures.ts';
import { CONDITIONS, transform } from './conditions.ts';

// Face-matching harness (Phase 11). Runs the production face-matching path (bundled face
// detector keypoints, core alignFace, bundled SFace embedder) in the diagnostics build. Each
// fixture's unmodified photo is the reference, as if taken at the start of a session; every
// fixture under every capture condition is a probe. Reported per condition:
// - same photo: the reference photo itself under the condition (lighting/camera changed)
// - same person: the person's other photo (years apart) under the condition
// - different person: everyone else's photos under the condition
// against policy.faceMatch.minSimilarity. Three people in studio portraits: a pipeline smoke
// test and a first look at robustness, not an accuracy or fairness measurement.

const NAMES = Object.keys(FACE_FIXTURES) as FaceFixtureName[];
const THRESHOLD = DEFAULT_POLICY.faceMatch.minSimilarity;

interface Diagnostics {
  compareFaces(references: string[], probes: string[]): Promise<(number | null)[][]>;
}

/** Fits the photo into a 640x480 webcam-sized frame, as the video fixtures are. */
async function asWebcamFrame(page: Page, jpeg: Buffer): Promise<string> {
  return page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const src = await createImageBitmap(new Blob([bytes]));
    const canvas = new OffscreenCanvas(640, 480);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, 640, 480);
    const scale = Math.min(640 / src.width, 480 / src.height);
    const w = src.width * scale;
    const h = src.height * scale;
    ctx.drawImage(src, (640 - w) / 2, (480 - h) / 2, w, h);
    const out = new Uint8Array(
      await (await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 })).arrayBuffer(),
    );
    let s = '';
    for (const b of out) s += String.fromCharCode(b);
    return btoa(s);
  }, jpeg.toString('base64'));
}

interface Stats {
  samePhotoMin: number | null;
  samePersonMin: number | null;
  samePersonBelow: number;
  samePersonTotal: number;
  otherPersonMax: number | null;
  otherPersonAtOrAbove: number;
  otherPersonTotal: number;
  noFace: number;
}

const fmt = (n: number | null) => (n === null ? 'n/a' : n.toFixed(3));
const minOf = (xs: number[]) => (xs.length ? Math.min(...xs) : null);
const maxOf = (xs: number[]) => (xs.length ? Math.max(...xs) : null);

test('face matching: same and different people across capture conditions', async () => {
  const context = await launchExtensionContext({ userDataDir: '' });
  try {
    const extensionId = new URL((await extensionWorker(context)).url()).host;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/pages/diagnostics.html`);
    await expect(page).toHaveTitle(/ready/, { timeout: 60_000 });

    const frames = new Map<FaceFixtureName, string>();
    for (const name of NAMES) {
      frames.set(name, await asWebcamFrame(page, await readFile(faceFixturePath(name))));
    }
    const references = NAMES.map((n) => `data:image/jpeg;base64,${frames.get(n) ?? ''}`);

    const stats: Record<string, Stats> = {};
    for (const condition of CONDITIONS) {
      const probes: string[] = [];
      for (const name of NAMES)
        probes.push(await transform(page, frames.get(name) ?? '', condition));
      const matrix = await page.evaluate(
        async ({ refs, probes }) => {
          const d = (window as unknown as { proctorDiagnostics?: Diagnostics }).proctorDiagnostics;
          if (!d) throw new Error('diagnostics not loaded');
          return d.compareFaces(refs, probes);
        },
        { refs: references, probes },
      );

      const samePhoto: number[] = [];
      const samePerson: number[] = [];
      const otherPerson: number[] = [];
      // A probe without a usable face compares as null against every reference.
      const noFace = NAMES.filter((_, j) => matrix.every((row) => row[j] === null)).length;
      NAMES.forEach((ref, i) => {
        NAMES.forEach((probe, j) => {
          const s = matrix[i]?.[j] ?? null;
          if (s === null) return;
          if (ref === probe) samePhoto.push(s);
          else if (FACE_FIXTURES[ref].person === FACE_FIXTURES[probe].person) samePerson.push(s);
          else otherPerson.push(s);
        });
      });
      stats[condition.id] = {
        samePhotoMin: minOf(samePhoto),
        samePersonMin: minOf(samePerson),
        samePersonBelow: samePerson.filter((s) => s < THRESHOLD).length,
        samePersonTotal: samePerson.length,
        otherPersonMax: maxOf(otherPerson),
        otherPersonAtOrAbove: otherPerson.filter((s) => s >= THRESHOLD).length,
        otherPersonTotal: otherPerson.length,
        noFace,
      };
    }

    const lines = [
      '| Condition | Same photo (min) | Same person, other photo (min) | Same person read as different | Different person (max) | Different person read as same | Probes without a usable face |',
      '|---|---|---|---|---|---|---|',
      ...CONDITIONS.map((c) => {
        const s = stats[c.id] as Stats;
        return `| ${c.label} | ${fmt(s.samePhotoMin)} | ${fmt(s.samePersonMin)} | ${String(s.samePersonBelow)}/${String(s.samePersonTotal)} | ${fmt(s.otherPersonMax)} | ${String(s.otherPersonAtOrAbove)}/${String(s.otherPersonTotal)} | ${String(s.noFace)}/${String(NAMES.length)} |`;
      }),
    ];
    const report = [
      `Measured ${new Date().toISOString()} with the bundled models; threshold policy.faceMatch.minSimilarity = ${String(THRESHOLD)} (cosine similarity, below = different face).`,
      '',
      ...lines,
      '',
      'Fixtures (two photos per person, taken years apart; the unmodified photo is the reference):',
      ...NAMES.map((n) => `- person ${FACE_FIXTURES[n].person}, ${n}: ${FACE_FIXTURES[n].credit}`),
    ].join('\n');

    const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '.cache', 'fairness');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'face-match-report.md'), report);
    await writeFile(join(dir, 'face-match-report.json'), JSON.stringify(stats, null, 2));
    await test
      .info()
      .attach('face-match-report.md', { body: report, contentType: 'text/markdown' });
    console.log(report);

    // The pipeline must work on the unmodified photos: every face usable, same people above
    // the threshold, different people below it.
    expect(stats.original).toMatchObject({
      noFace: 0,
      samePersonBelow: 0,
      otherPersonAtOrAbove: 0,
    });
  } finally {
    await context.close();
  }
});
