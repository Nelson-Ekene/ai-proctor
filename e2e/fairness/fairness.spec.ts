import { expect, test } from '@playwright/test';
import { DEFAULT_POLICY, type FrameAnalysis, type FrameObservation } from '@proctor/core';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extensionWorker, launchExtensionContext } from '../fixtures.ts';
import { VIDEO_FIXTURES, videoFixturePath, type VideoFixtureName } from '../video-fixtures.ts';
import { CONDITIONS, transform, type Condition } from './conditions.ts';

// Fairness harness (BUILD_PLAN Phase 9.2). Runs the exact bundled models and core frame rules
// (diagnostics build) on each webcam fixture under varied capture conditions and reports, per
// condition, whether the expected outcome was reached and with what confidence.
//
// What this measures: robustness to lighting, camera quality, blur, sensor noise and movement
// (tilt), applied as image transforms to a small public fixture set. What it cannot measure:
// differences across skin tones, glasses, or disability-related movement. That needs a
// consented, labelled dataset of real people, which this repository does not contain (pilot item,
// docs/FAIRNESS.md). Add labelled fixtures to FIXTURES with their labels to extend the report.

const FIXTURES: VideoFixtureName[] = [
  'face',
  'twoPeople',
  'phone',
  'book',
  'lookingAway',
  'noFace',
];

/** The diagnostics page API (apps/extension/src/pages/diagnostics.ts). */
interface Diagnostics {
  analyse(imageUrl: string): Promise<{
    observation: FrameObservation;
    analysis: FrameAnalysis;
    inferenceMs: number;
  }>;
}

interface Result {
  expected: string;
  met: boolean;
  confidence: number;
  extra: string[];
}

/** Whether the frame produced the fixture's expected outcome, and the relevant confidence. */
function judge(name: VideoFixtureName, obs: FrameObservation, a: FrameAnalysis): Result {
  const min = DEFAULT_POLICY.video.minConfidence;
  const types = a.anomalies.map((x) => x.type);
  const conf = (t: string) => a.anomalies.find((x) => x.type === t)?.confidence ?? 0;
  const expected = VIDEO_FIXTURES[name].expect;
  const extra = types.filter((t) => t !== expected);
  switch (expected) {
    case 'none': {
      const best = Math.max(0, ...obs.faceScores);
      return {
        expected: 'one face, nothing flagged',
        met: best >= min && types.length === 0,
        confidence: best,
        extra,
      };
    }
    case 'gaze_away_sustained':
      return {
        expected: 'face seen, looking away',
        met: a.gaze?.away === true,
        confidence: a.gaze?.confidence ?? 0,
        extra,
      };
    default:
      return { expected, met: types.includes(expected), confidence: conf(expected), extra };
  }
}

test('fairness harness: detection across lighting, camera quality and movement', async () => {
  const context = await launchExtensionContext({ userDataDir: '' });
  try {
    const extensionId = new URL((await extensionWorker(context)).url()).host;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/pages/diagnostics.html`);
    await expect(page).toHaveTitle(/ready/, { timeout: 60_000 });

    const rows: {
      condition: Condition;
      fixture: VideoFixtureName;
      result: Result;
      inferenceMs: number;
    }[] = [];
    for (const fixture of FIXTURES) {
      const jpeg = (await readFile(videoFixturePath(fixture))).toString('base64');
      for (const condition of CONDITIONS) {
        const url = await transform(page, jpeg, condition);
        const out = await page.evaluate(async (u) => {
          const d = (window as unknown as { proctorDiagnostics?: Diagnostics }).proctorDiagnostics;
          if (!d) throw new Error('diagnostics not loaded');
          return d.analyse(u);
        }, url);
        rows.push({
          condition,
          fixture,
          result: judge(fixture, out.observation, out.analysis),
          inferenceMs: out.inferenceMs,
        });
      }
    }

    // Report: per condition, outcomes met over fixtures and mean confidence of the relevant score.
    const lines = [
      '| Condition | Group | Met | Mean confidence | ' + FIXTURES.join(' | ') + ' |',
      '|---|---|---|---|' + FIXTURES.map(() => '---').join('|') + '|',
    ];
    const summary: Record<string, { met: number; total: number; meanConfidence: number }> = {};
    for (const c of CONDITIONS) {
      const of = rows.filter((r) => r.condition.id === c.id);
      const met = of.filter((r) => r.result.met).length;
      const mean = of.reduce((s, r) => s + r.result.confidence, 0) / of.length;
      summary[c.id] = { met, total: of.length, meanConfidence: Math.round(mean * 100) / 100 };
      const cells = FIXTURES.map((f) => {
        const r = of.find((x) => x.fixture === f)?.result;
        if (!r) return '';
        const mark = r.met ? '✓' : '✗';
        const fp = r.extra.length > 0 ? ` (+${r.extra.join(', ')})` : '';
        return `${mark} ${r.confidence.toFixed(2)}${fp}`;
      });
      lines.push(
        `| ${c.label} | ${c.group} | ${String(met)}/${String(of.length)} | ${mean.toFixed(2)} | ${cells.join(' | ')} |`,
      );
    }
    const legend = FIXTURES.map(
      (f) =>
        `- **${f}**: expected ${VIDEO_FIXTURES[f].expect === 'none' ? 'one face, nothing flagged' : VIDEO_FIXTURES[f].expect} (${VIDEO_FIXTURES[f].credit})`,
    );
    const medianMs =
      rows.map((r) => r.inferenceMs).sort((a, b) => a - b)[Math.floor(rows.length / 2)] ?? 0;
    const report = [
      `Measured ${new Date().toISOString()} with the bundled models and DEFAULT_POLICY (minConfidence ${String(DEFAULT_POLICY.video.minConfidence)}); median inference ${medianMs.toFixed(0)} ms per frame.`,
      '',
      'Cell: ✓/✗ expected outcome reached, then the confidence of the relevant score; (+…) lists other anomalies raised (possible false positives).',
      '',
      ...lines,
      '',
      ...legend,
    ].join('\n');

    const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '.cache', 'fairness');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'report.md'), report);
    await writeFile(join(dir, 'report.json'), JSON.stringify({ summary, rows }, null, 2));
    await test.info().attach('fairness-report.md', { body: report, contentType: 'text/markdown' });
    console.log(report);

    // The harness itself must be sound: on unmodified fixtures every expected outcome is reached.
    expect(summary.original).toMatchObject({ met: FIXTURES.length, total: FIXTURES.length });
  } finally {
    await context.close();
  }
});
