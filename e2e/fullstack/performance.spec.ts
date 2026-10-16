import { expect, test } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extensionWorker, launchExtensionContext } from '../fixtures.ts';
import { FULLSTACK_HOST_URL } from '../settings.ts';
import { FAST_POLICY, proxyLog, resetProxy, setPolicy, startExam } from './helpers.ts';
import { DEFAULT_POLICY } from '@proctor/core';

// BUILD_PLAN Phase 9.3 performance budget: CPU and memory of the extension and upload volume per
// session, measured on a real exam (fake camera with a face, fake microphone with speech) under
// the production default policy. Results go to e2e/.cache/perf/latest.json and the test report;
// docs/PERFORMANCE.md records the pilot targets these budgets enforce.

const CDP_PORT = 9333;
const BASELINE_MS = 20_000;
const WARMUP_MS = 20_000;
const MEASURE_MS = 60_000;

/** Pilot budgets (docs/PERFORMANCE.md). Generous on purpose: CI machines are slow and shared. */
const BUDGET = {
  /** Extra CPU the whole browser uses while proctoring, in cores (1.0 = one core fully busy). */
  cpuCores: 1.0,
  offscreenHeapMb: 150,
  serviceWorkerHeapMb: 30,
  uploadMbPerMinute: 5,
};

/** Minimal Chrome DevTools Protocol client (browser endpoint, flattened sessions). */
class Cdp {
  private id = 0;
  private readonly pending = new Map<
    number,
    (msg: { result?: unknown; error?: unknown }) => void
  >();
  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)) as {
        id?: number;
        result?: unknown;
        error?: unknown;
      };
      if (msg.id !== undefined) this.pending.get(msg.id)?.(msg);
    });
  }

  static async connect(port: number): Promise<Cdp> {
    const version = (await (
      await fetch(`http://127.0.0.1:${String(port)}/json/version`)
    ).json()) as {
      webSocketDebuggerUrl: string;
    };
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve);
      ws.addEventListener('error', reject);
    });
    return new Cdp(ws);
  }

  send<T>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, (msg) => {
        this.pending.delete(id);
        if (msg.error) reject(new Error(`${method}: ${JSON.stringify(msg.error)}`));
        else resolve(msg.result as T);
      });
    });
  }

  /** CPU seconds used so far, per browser process type (browser, renderer, gpu, utility...). */
  async cpuByType(): Promise<Record<string, number>> {
    const info = await this.send<{ processInfo: { type: string; cpuTime: number }[] }>(
      'SystemInfo.getProcessInfo',
    );
    const byType: Record<string, number> = {};
    for (const p of info.processInfo) byType[p.type] = (byType[p.type] ?? 0) + p.cpuTime;
    return byType;
  }

  /** Total CPU seconds used by all browser processes so far. */
  async cpuSeconds(): Promise<number> {
    return Object.values(await this.cpuByType()).reduce((a, b) => a + b, 0);
  }

  /** JS heap in use (MB) of the first target whose URL matches. */
  async heapMb(match: (t: { type: string; url: string }) => boolean): Promise<number | null> {
    const { targetInfos } = await this.send<{
      targetInfos: { targetId: string; type: string; url: string }[];
    }>('Target.getTargets');
    const target = targetInfos.find(match);
    if (!target) return null;
    const { sessionId } = await this.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId: target.targetId,
      flatten: true,
    });
    try {
      const heap = await this.send<{ usedSize: number }>('Runtime.getHeapUsage', {}, sessionId);
      return heap.usedSize / 1e6;
    } finally {
      await this.send('Target.detachFromTarget', { sessionId });
    }
  }

  close(): void {
    this.ws.close();
  }
}

// Tracing records screenshots (screencast), which itself costs browser/GPU CPU: measure without.
test.use({ trace: 'off' });

test('performance budget: CPU, memory and upload volume of a proctored exam', async () => {
  const context = await launchExtensionContext({
    userDataDir: '',
    fakeVideo: 'face',
    fakeAudio: 'speech',
    args: [`--remote-debugging-port=${String(CDP_PORT)}`],
  });
  const cdp = await Cdp.connect(CDP_PORT);
  try {
    const extensionId = new URL((await extensionWorker(context)).url()).host;
    // Production sampling and capture; quick upload retries only so the run finishes on time.
    await setPolicy({ ...DEFAULT_POLICY, upload: FAST_POLICY.upload });

    // Baseline: the exam page open, no proctoring.
    const idle = await context.newPage();
    await idle.goto(FULLSTACK_HOST_URL);
    const cpu0 = await cdp.cpuSeconds();
    await idle.waitForTimeout(BASELINE_MS);
    const baselineCores = ((await cdp.cpuSeconds()) - cpu0) / (BASELINE_MS / 1000);
    await idle.close();

    // Proctored exam: models load during warm-up, then a steady-state window is measured.
    const host = await startExam(context, extensionId, 'fullstack-performance');
    await host.waitForTimeout(WARMUP_MS);
    await resetProxy();
    const cpu1 = await cdp.cpuSeconds();
    const byType1 = await cdp.cpuByType();
    const heaps = { offscreen: 0, worker: 0 };
    for (let elapsed = 0; elapsed < MEASURE_MS; elapsed += 10_000) {
      await host.waitForTimeout(10_000);
      const offscreen = await cdp.heapMb((t) => t.url.includes(`${extensionId}/src/offscreen/`));
      const worker = await cdp.heapMb(
        (t) => t.type === 'service_worker' && t.url.includes(extensionId),
      );
      heaps.offscreen = Math.max(heaps.offscreen, offscreen ?? 0);
      heaps.worker = Math.max(heaps.worker, worker ?? 0);
    }
    const sessionCores = ((await cdp.cpuSeconds()) - cpu1) / (MEASURE_MS / 1000);
    const byType2 = await cdp.cpuByType();
    const coresByProcessType = Object.fromEntries(
      Object.entries(byType2).map(([type, cpu]) => [
        type,
        Math.round(((cpu - (byType1[type] ?? 0)) / (MEASURE_MS / 1000)) * 1000) / 1000,
      ]),
    );
    const uploads = await proxyLog();
    const uploadMb = uploads.reduce((sum, e) => sum + e.bytes, 0) / 1e6;
    await host.click('#end');

    const result = {
      measuredAt: new Date().toISOString(),
      scenario: 'face in view, continuous speech, default policy (5 frames / 30 s)',
      baselineCores: Math.round(baselineCores * 1000) / 1000,
      sessionCores: Math.round(sessionCores * 1000) / 1000,
      extensionCpuCores: Math.round((sessionCores - baselineCores) * 1000) / 1000,
      coresByProcessType,
      offscreenHeapMb: Math.round(heaps.offscreen * 10) / 10,
      serviceWorkerHeapMb: Math.round(heaps.worker * 10) / 10,
      uploadMbPerMinute: Math.round((uploadMb / (MEASURE_MS / 60_000)) * 1000) / 1000,
      requestsPerMinute: Math.round(uploads.length / (MEASURE_MS / 60_000)),
      budget: BUDGET,
    };
    const out = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '.cache',
      'perf',
      'latest.json',
    );
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, JSON.stringify(result, null, 2));
    await test.info().attach('performance.json', {
      body: JSON.stringify(result, null, 2),
      contentType: 'application/json',
    });
    console.log(`performance: ${JSON.stringify(result)}`);

    expect(heaps.offscreen, 'offscreen document measured').toBeGreaterThan(0);
    expect(result.extensionCpuCores).toBeLessThan(BUDGET.cpuCores);
    expect(result.offscreenHeapMb).toBeLessThan(BUDGET.offscreenHeapMb);
    expect(result.serviceWorkerHeapMb).toBeLessThan(BUDGET.serviceWorkerHeapMb);
    expect(result.uploadMbPerMinute).toBeLessThan(BUDGET.uploadMbPerMinute);
  } finally {
    cdp.close();
    await context.close();
  }
});
