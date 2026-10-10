import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  API_URL,
  HOST_URL,
  acceptAndCompleteSetup,
  expect,
  extensionWorker,
  launchExtensionContext,
  mockState,
  rulesData,
  setNetwork,
  startActiveSession,
  startSession,
  test,
  uploadQueue,
  waitForAudioListening,
} from '../fixtures.ts';
import type { MockState } from '../mock-server.ts';

// Phase 6 "Done when": an e2e test simulates network loss mid-session; all evidence arrives
// exactly once after reconnect. tok-fastupload: 1 frame/s, 5 s clip cap, capture windows of
// -5 s/+3 s and upload retries between 0.5 s and 2 s (see mock-server.ts).
test.describe.configure({ timeout: 150_000 });

const TOKEN = 'tok-fastupload';
const SESSION = 'sess-fastupload';

/** The client-side anomaly ids and the evidence ids they reference. */
async function clientAnomalies(sw: Parameters<typeof rulesData>[0]) {
  const data = await rulesData(sw);
  return (data.anomalies as { id?: string; packaged?: boolean }[]).map((a) => ({
    id: a.id ?? '',
    packaged: a.packaged === true,
  }));
}

/** Every anomaly received once, with every piece of evidence it links to. */
function assertExactlyOnce(server: MockState, expectedIds: string[]) {
  const received = server.anomalies.filter((a) => a.sessionId === SESSION).map((a) => a.id);
  expect(new Set(received).size).toBe(received.length); // no anomaly stored twice
  expect([...received].sort()).toEqual([...expectedIds].sort());
  const evidenceIds = server.evidence.map((e) => e.id);
  expect(new Set(evidenceIds).size).toBe(evidenceIds.length); // no evidence stored twice
  for (const a of server.anomalies) {
    for (const id of a.evidenceIds) expect(evidenceIds).toContain(id);
  }
}

test.describe('upload queue', () => {
  test.use({ fakeVideo: 'phone', fakeAudio: 'speech' });

  test('network loss mid-session: everything arrives exactly once after reconnect', async ({
    context,
    extensionId,
    serviceWorker,
  }) => {
    const host = await startActiveSession(context, extensionId, TOKEN);
    await waitForAudioListening(serviceWorker);

    // Network goes down while the candidate keeps triggering anomalies of every channel.
    await setNetwork('down');
    await host.click('#notes');
    await host.keyboard.press('ControlOrMeta+C');
    // Wait for real webcam and microphone evidence too (models may still be loading).
    await expect
      .poll(
        async () => {
          const types = new Set((await rulesData(serviceWorker)).anomalies.map((a) => a.type));
          return ['copy_paste', 'phone_detected', 'speech_detected'].every((t) => types.has(t));
        },
        { timeout: 60_000 },
      )
      .toBe(true);
    await expect
      .poll(async () => (await uploadQueue(serviceWorker)).items.some((i) => i.attempts > 0), {
        timeout: 30_000,
      })
      .toBe(true); // uploads are being attempted and failing
    const duringOutage = await mockState();
    expect(duringOutage.anomalies).toEqual([]);
    expect(duringOutage.refused).toBeGreaterThan(0);
    const queued = await uploadQueue(serviceWorker);
    expect(queued.items.some((i) => i.kind === 'anomaly')).toBe(true);
    expect(queued.frames + queued.clips).toBeGreaterThan(0); // evidence kept locally meanwhile

    // Reconnect, end the session (flushes everything still open) and let the queue drain.
    await setNetwork('up');
    await host.click('#end');
    await expect(host.locator('#events')).toContainText('ended');
    await expect.poll(async () => (await mockState()).ends.length, { timeout: 60_000 }).toBe(1);
    await expect.poll(async () => (await uploadQueue(serviceWorker)).items.length).toBe(0);

    const client = await clientAnomalies(serviceWorker);
    expect(client.every((a) => a.packaged)).toBe(true);
    const server = await mockState();
    assertExactlyOnce(
      server,
      client.map((a) => a.id),
    );
    expect(server.evidence.some((e) => e.contentType === 'image/jpeg')).toBe(true);
    expect(server.evidence.some((e) => e.contentType === 'audio/wav')).toBe(true);
    expect(server.evidence.some((e) => e.contentType === 'application/json')).toBe(true);
    // Local copies are deleted once the server has acknowledged them.
    const after = await uploadQueue(serviceWorker);
    expect(after.frames).toBe(0);
    expect(after.clips).toBe(0);
  });

  test('a lost reply is retried with the same key and never double-counted', async ({
    context,
    extensionId,
    serviceWorker,
  }) => {
    const host = await startActiveSession(context, extensionId, TOKEN);
    // The server processes the next requests but the replies never reach the extension.
    await setNetwork('drop-after', 4);
    await host.click('#notes');
    await host.keyboard.press('ControlOrMeta+C');
    await host.click('#end');
    await expect.poll(async () => (await mockState()).ends.length, { timeout: 60_000 }).toBe(1);
    await expect.poll(async () => (await uploadQueue(serviceWorker)).items.length).toBe(0);

    const server = await mockState();
    expect(server.duplicates).toBeGreaterThan(0); // the retries really happened
    assertExactlyOnce(
      server,
      (await clientAnomalies(serviceWorker)).map((a) => a.id),
    );
    expect(server.ends).toHaveLength(1);
  });
});

// This test launches (and relaunches) its own browser, so it uses no browser fixtures.
// eslint-disable-next-line no-empty-pattern
test('the queue survives a browser restart and drains when the extension starts again', async ({}, testInfo) => {
  await fetch(`${API_URL}/__test/reset`, { method: 'POST' });
  // Own persistent profile so the same browser profile can be reopened.
  const profile = await mkdtemp(join(tmpdir(), 'proctor-restart-'));
  try {
    let context = await launchExtensionContext({ userDataDir: profile });
    let sw = await extensionWorker(context);
    const id = new URL(sw.url()).host;
    const host = await context.newPage();
    await host.goto(`${HOST_URL}/?ext=${id}&token=${TOKEN}`);
    await acceptAndCompleteSetup(await startSession(context, host));
    await expect(host.locator('#events')).toContainText('ready');

    await setNetwork('down');
    await host.click('#notes');
    await host.keyboard.press('ControlOrMeta+C');
    await host.click('#end');
    await expect(host.locator('#events')).toContainText('ended');
    await expect
      .poll(async () => (await uploadQueue(sw)).items.map((i) => i.kind))
      .toEqual(expect.arrayContaining(['anomaly', 'end']));
    const expected = (await clientAnomalies(sw)).map((a) => a.id);
    await context.close(); // browser closed with uploads still pending

    await setNetwork('up');
    context = await launchExtensionContext({ userDataDir: profile });
    sw = await extensionWorker(context);
    await expect.poll(async () => (await mockState()).ends.length, { timeout: 60_000 }).toBe(1);
    await expect.poll(async () => (await uploadQueue(sw)).items.length).toBe(0);
    assertExactlyOnce(await mockState(), expected);
    await context.close();
  } finally {
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
    testInfo.annotations.push({ type: 'profile', description: profile });
  }
});

test('a decline recorded while offline reaches the server after reconnect', async ({
  context,
  host,
}) => {
  const consent = await startSession(context, host);
  await setNetwork('down');
  const closed = consent.waitForEvent('close');
  await consent.click('#decline');
  await closed;
  await expect(host.locator('#events')).toContainText('consent_declined');
  expect((await mockState()).consents).toEqual([]);
  await setNetwork('up');
  await expect
    .poll(async () => (await mockState()).consents.map((c) => c.decision), { timeout: 60_000 })
    .toEqual(['declined']);
});
