import {
  HOST_URL,
  acceptAndCompleteSetup,
  evidenceFrames,
  expect,
  mockState,
  rulesData,
  startActiveSession,
  startSession,
  test,
  type RulesData,
} from '../fixtures.ts';
import { VIDEO_FIXTURES, type VideoFixtureName } from '../video-fixtures.ts';

// Phase 4 "Done when": with Chrome's fake camera feed and fixture images, each video violation
// type is detected; non-anomalous frames are never persisted or uploaded.
// tok-fastvideo samples one frame per second (see mock-server.ts) so tests stay short.

const TOKEN = 'tok-fastvideo';
const VIDEO_TYPES = new Set([
  'no_face',
  'multiple_faces',
  'phone_detected',
  'book_or_notes',
  'gaze_away_sustained',
]);

const videoAnomalies = (d: RulesData) => d.anomalies.filter((a) => VIDEO_TYPES.has(a.type));

for (const name of Object.keys(VIDEO_FIXTURES) as VideoFixtureName[]) {
  const fixture = VIDEO_FIXTURES[name];
  if (fixture.expect === 'none') continue;

  test.describe(`webcam scene "${name}"`, () => {
    test.use({ fakeVideo: name });

    test(`raises ${fixture.expect} with linked frame evidence`, async ({
      context,
      extensionId,
      serviceWorker,
    }) => {
      await startActiveSession(context, extensionId, TOKEN);

      await expect
        .poll(async () => videoAnomalies(await rulesData(serviceWorker)).map((a) => a.type), {
          timeout: 30_000,
        })
        .toContain(fixture.expect);

      const anomaly = videoAnomalies(await rulesData(serviceWorker)).find(
        (a) => a.type === fixture.expect,
      );
      expect(anomaly?.confidence).toBeGreaterThanOrEqual(0.5);
      // The anomalous frame plus the burst (capture.burstFrames = 3), all stored locally.
      const evidence = anomaly?.evidence ?? [];
      expect(evidence.length).toBe(4);
      expect(evidence.every((e) => e.kind === 'frame')).toBe(true);
      const stored = await evidenceFrames(serviceWorker);
      const storedIds = new Set(stored.map((f) => f.id));
      for (const e of evidence) expect(storedIds.has(e.id)).toBe(true);
      expect(stored.every((f) => f.mime === 'image/jpeg' && f.bytes > 0)).toBe(true);
    });
  });
}

test.describe('webcam scene "face" (control)', () => {
  test.use({ fakeVideo: 'face' });

  test('a normal scene is analysed but no frame is ever stored or uploaded', async ({
    context,
    extensionId,
    serviceWorker,
  }) => {
    const host = await startActiveSession(context, extensionId, TOKEN);
    // At one sample per second, 8 s covers several windows of analysed frames.
    await host.waitForTimeout(8000);

    const data = await rulesData(serviceWorker);
    expect(videoAnomalies(data)).toEqual([]);
    expect(await evidenceFrames(serviceWorker)).toEqual([]);
    // Nothing but session/consent traffic reached the API: no frame or image upload.
    const { requests } = await mockState();
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /v1/sessions/current',
      'POST /v1/sessions/sess-fastvideo/consents',
    ]);
  });

  test('the setup face check sees a real face as Ready', async ({ context, extensionId }) => {
    const host = await context.newPage();
    await host.goto(`${HOST_URL}/?ext=${extensionId}&token=${TOKEN}`);
    const { checks } = await acceptAndCompleteSetup(await startSession(context, host));
    expect(checks.face).toBe('Ready');
  });
});

test.describe('video sampling metadata', () => {
  test.use({ fakeVideo: 'face' });

  test('records the sampling plan on the session', async ({
    context,
    extensionId,
    serviceWorker,
  }) => {
    await startActiveSession(context, extensionId, TOKEN);
    await expect
      .poll(() =>
        serviceWorker.evaluate(async () => {
          const data = await chrome.storage.session.get('proctor.session');
          return (
            data['proctor.session'] as { videoMeta?: { framesPerWindow: number } } | undefined
          )?.videoMeta?.framesPerWindow;
        }),
      )
      .toBeGreaterThan(0);
  });
});
