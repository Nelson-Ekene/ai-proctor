import { expect, test } from '@playwright/test';
import {
  AnomalySchema,
  ConsentRecordSchema,
  EndSessionSchema,
  EventSequenceSchema,
  SetupCheckRecordSchema,
  wavDurationSeconds,
  type ViolationType,
} from '@proctor/core';
import { extensionWorker, launchExtensionContext } from '../fixtures.ts';
import { FULLSTACK_HOST_URL } from '../settings.ts';
import {
  api,
  FAST_POLICY,
  login,
  proxyLog,
  resetProxy,
  sessionId,
  setPolicy,
  startExam,
  type ReportView,
} from './helpers.ts';

// BUILD_PLAN Phase 9.1 data-minimisation test, end to end: a real exam through the demo site,
// the built extension and the real API. Every byte the extension sends is recorded by a proxy
// and must be one of: consent, setup-check, anomaly records, frames, clips, event sequences, end.
// Nothing from the page (text, answers, URLs) may appear anywhere.

const SECRET = 'SECRET-ANSWER-42';
const SESSION = /^\/v1\/sessions\/([0-9a-f-]{36})\//;

const ROUTES: { method: string; path: RegExp; contentType: string }[] = [
  { method: 'GET', path: /^\/v1\/sessions\/current$/, contentType: '' },
  {
    method: 'POST',
    path: /^\/v1\/sessions\/[0-9a-f-]{36}\/consents$/,
    contentType: 'application/json',
  },
  {
    method: 'POST',
    path: /^\/v1\/sessions\/[0-9a-f-]{36}\/setup-check$/,
    contentType: 'application/json',
  },
  {
    method: 'POST',
    path: /^\/v1\/sessions\/[0-9a-f-]{36}\/anomalies$/,
    contentType: 'application/json',
  },
  {
    method: 'PUT',
    path: /^\/v1\/sessions\/[0-9a-f-]{36}\/evidence\/[^/]+$/,
    contentType: '(image/jpeg|audio/wav|application/json)',
  },
  { method: 'POST', path: /^\/v1\/sessions\/[0-9a-f-]{36}\/end$/, contentType: 'application/json' },
];

test('a full exam uploads only what the privacy notice says, and the reviewer sees it all', async () => {
  const context = await launchExtensionContext({
    userDataDir: '',
    fakeVideo: 'phone',
    fakeAudio: 'speech',
  });
  try {
    const extensionId = new URL((await extensionWorker(context)).url()).host;
    await setPolicy(FAST_POLICY);
    await resetProxy();

    // --- the candidate takes the exam ---------------------------------------------------------
    const host = await startExam(context, extensionId, 'fullstack-privacy');
    await host.click('#answer');
    await host.keyboard.press('Control+A');
    await host.keyboard.press('Control+C'); // copy
    const other = await context.newPage(); // switch tab
    await other.goto('about:blank');
    await host.bringToFront();
    await other.close();

    const reviewer = await login('reviewer@proctor.test');
    const id = await sessionId(reviewer, 'fullstack-privacy');
    const types = async () =>
      new Set(
        (await api<ReportView>(reviewer, `/v1/sessions/${id}/report`)).violations.map(
          (v) => v.type,
        ),
      );
    const wanted: ViolationType[] = [
      'copy_paste',
      'tab_switch_or_blur',
      'phone_detected',
      'speech_detected',
    ];
    await expect
      .poll(
        async () => {
          const seen = await types();
          return wanted.filter((t) => !seen.has(t));
        },
        {
          timeout: 150_000,
          intervals: [2000],
        },
      )
      .toEqual([]);

    await host.click('#end');
    await expect(host.locator('#status')).toHaveText('ended');

    // --- the reviewer sees every flagged moment with all its evidence ------------------------
    let report: ReportView | undefined;
    await expect
      .poll(
        async () => {
          report = await api<ReportView>(reviewer, `/v1/sessions/${id}/report`);
          const pending = report.violations.flatMap((v) => v.evidence).filter((e) => !e.uploaded);
          return { status: report.session.status, pending: pending.length };
        },
        { timeout: 60_000, intervals: [1000] },
      )
      .toEqual({ status: 'ended', pending: 0 });
    expect(report?.reproducible).toBe(true);
    expect(report?.risk).toBeGreaterThan(0);
    for (const v of report?.violations ?? []) expect(v.evidence.length).toBeGreaterThan(0);

    const admin = await login('admin@proctor.test');
    const metrics = await api<{
      violations: { evidenceLinkedRate: number };
      setupCheck: { completed: number };
    }>(admin, '/v1/metrics');
    expect(metrics.violations.evidenceLinkedRate).toBe(1);
    expect(metrics.setupCheck.completed).toBeGreaterThanOrEqual(1);

    // --- data minimisation: inspect every request the extension made -------------------------
    const log = await proxyLog();
    expect(log.length).toBeGreaterThan(5);
    const kinds = new Map<string, number>();
    const evidenceIds = new Set<string>();
    for (const entry of log) {
      const route = ROUTES.find(
        (r) =>
          r.method === entry.method &&
          r.path.test(entry.path) &&
          new RegExp(`^${r.contentType}$`).test(entry.contentType.split(';')[0] ?? ''),
      );
      expect(
        route,
        `unexpected request ${entry.method} ${entry.path} (${entry.contentType})`,
      ).toBeDefined();
      const sessionMatch = SESSION.exec(entry.path);
      if (sessionMatch) expect(sessionMatch[1]).toBe(id);

      const body = Buffer.from(entry.body, 'base64');
      const type = entry.contentType.split(';')[0] ?? '';
      if (type === 'application/json') {
        const text = body.toString('utf8');
        expect(text).not.toContain(SECRET);
        expect(text).not.toContain('Question 1');
        expect(text).not.toMatch(/https?:\/\//);
        const json: unknown = JSON.parse(text);
        if (entry.path.endsWith('/consents')) ConsentRecordSchema.parse(json);
        else if (entry.path.endsWith('/setup-check')) SetupCheckRecordSchema.parse(json);
        else if (entry.path.endsWith('/end')) EndSessionSchema.parse(json);
        else if (entry.path.endsWith('/anomalies')) {
          for (const e of AnomalySchema.parse(json).evidence) evidenceIds.add(e.id);
        } else EventSequenceSchema.parse(json); // strict: event type + timestamp only
      } else if (type === 'image/jpeg') {
        expect([...body.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
        expect(body.length).toBeLessThan(300_000);
        expect(body.includes(Buffer.from(SECRET))).toBe(false);
      } else if (type === 'audio/wav') {
        expect(body.subarray(0, 4).toString('ascii')).toBe('RIFF');
        expect(wavDurationSeconds(new Uint8Array(body))).toBeLessThanOrEqual(
          FAST_POLICY.audio.maxClipSeconds + 0.1,
        );
      }
      kinds.set(`${entry.method} ${type}`, (kinds.get(`${entry.method} ${type}`) ?? 0) + 1);
    }
    // Every evidence item announced by an anomaly was uploaded (and nothing unannounced).
    const uploaded = new Set(
      log
        .filter((e) => e.method === 'PUT' && e.status < 300)
        .map((e) => decodeURIComponent(e.path.split('/').pop() ?? '')),
    );
    expect([...evidenceIds].filter((e) => !uploaded.has(e))).toEqual([]);
    expect([...uploaded].filter((e) => !evidenceIds.has(e))).toEqual([]);
    expect(kinds.get('PUT image/jpeg')).toBeGreaterThan(0);
    expect(kinds.get('PUT audio/wav')).toBeGreaterThan(0);
    test.info().annotations.push({
      type: 'uploads',
      description: JSON.stringify(Object.fromEntries(kinds)),
    });

    // The page itself never talked to the API (the extension did, through its own origin).
    expect(log.every((e) => !e.path.includes(FULLSTACK_HOST_URL))).toBe(true);
  } finally {
    await context.close();
  }
});
