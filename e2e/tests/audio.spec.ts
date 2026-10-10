import {
  evidenceClips,
  expect,
  mockState,
  rulesData,
  startActiveSession,
  test,
  waitForAudioListening,
  type RulesData,
} from '../fixtures.ts';

// Phase 5 "Done when": a fixture WAV with one speaker raises speech_detected with a clip;
// silence produces no upload; the clip never exceeds 30 s (here also the 5 s test cap).
//
// Each scenario loads the vision and voice models, then waits for real speech, so it gets an
// explicit, longer budget. Timing starts once the monitor reports it is listening.
test.describe.configure({ timeout: 120_000 });

const audioAnomalies = (d: RulesData) =>
  d.anomalies.filter((a) => a.type === 'speech_detected' || a.type === 'multiple_voices');

test.describe('microphone: one speaker', () => {
  test.use({ fakeAudio: 'speech' });

  test('speech raises speech_detected linked to a stored clip, capped at the policy limit', async ({
    context,
    extensionId,
    serviceWorker,
  }) => {
    // tok-fastaudio: 2 s buffer, 5 s cap, 0.8 s silence ends a clip.
    await startActiveSession(context, extensionId, 'tok-fastaudio');
    await waitForAudioListening(serviceWorker);

    // The fixture talks continuously, so a capped 5 s clip must exist well within 20 s.
    await expect
      .poll(async () => audioAnomalies(await rulesData(serviceWorker)).length, { timeout: 20_000 })
      .toBeGreaterThan(0);
    const anomalies = audioAnomalies(await rulesData(serviceWorker));
    const speech = anomalies.find((a) => a.type === 'speech_detected');
    expect(speech?.confidence).toBeGreaterThanOrEqual(0.5);
    expect(speech?.evidence).toHaveLength(1);
    expect(speech?.evidence?.[0]?.kind).toBe('audio');

    const clips = await evidenceClips(serviceWorker);
    expect(clips.map((c) => c.id)).toContain(speech?.evidence?.[0]?.id);
    for (const clip of clips) {
      expect(clip.mime).toBe('audio/wav');
      expect(clip.wavSeconds).toBeGreaterThan(0);
      expect(clip.wavSeconds).toBeLessThanOrEqual(5);
      expect(clip.durationMs).toBeLessThanOrEqual(5000);
    }
    // Measured calibration: a single speaker must not be reported as multiple voices.
    expect(anomalies.map((a) => a.type)).not.toContain('multiple_voices');
  });

  test('with the default policy a clip is at most 30 s', async ({
    context,
    extensionId,
    serviceWorker,
  }) => {
    await startActiveSession(context, extensionId, 'tok-demo');
    await waitForAudioListening(serviceWorker);
    // Default cap is 30 s: a clip (capped or ended by a pause) must exist within 40 s.
    await expect
      .poll(async () => (await evidenceClips(serviceWorker)).length, { timeout: 40_000 })
      .toBeGreaterThan(0);
    for (const clip of await evidenceClips(serviceWorker)) {
      expect(clip.wavSeconds).toBeGreaterThan(0);
      expect(clip.wavSeconds).toBeLessThanOrEqual(30);
    }
  });
});

test.describe('microphone: silence', () => {
  test.use({ fakeAudio: 'silence' });

  test('silence stores no clip, raises nothing and uploads nothing', async ({
    context,
    extensionId,
    serviceWorker,
  }) => {
    const host = await startActiveSession(context, extensionId, 'tok-fastaudio');
    // Prove the monitor is really analysing the microphone, so "nothing stored" is meaningful.
    await waitForAudioListening(serviceWorker);
    await host.waitForTimeout(10_000);
    expect(audioAnomalies(await rulesData(serviceWorker))).toEqual([]);
    expect(await evidenceClips(serviceWorker)).toEqual([]);
    const { requests } = await mockState();
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /v1/sessions/current',
      'POST /v1/sessions/sess-fastaudio/consents',
    ]);
  });
});
