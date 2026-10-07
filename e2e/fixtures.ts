import {
  test as base,
  chromium,
  expect,
  type BrowserContext,
  type Page,
  type Video,
  type Worker,
} from '@playwright/test';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_POLICY,
  mergeViolations,
  type Anomaly,
  type Policy,
  type Violation,
} from '@proctor/core';
import type { MockState } from './mock-server.ts';
import { ACTION_TIMEOUT_MS, NAVIGATION_TIMEOUT_MS } from './settings.ts';

/** Built extension under test. PW_EXTENSION_PATH lets the stability loop pin a snapshot. */
const EXTENSION_PATH =
  process.env.PW_EXTENSION_PATH ??
  join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'extension', 'build');
export const HOST_URL = 'http://localhost:4400';
export const API_URL = 'http://localhost:4401';

interface Fixtures {
  context: BrowserContext;
  serviceWorker: Worker;
  extensionId: string;
  host: Page;
}

/** Timestamped diagnostics: service-worker console, worker lifecycle, page console, errors. */
class DiagnosticsLog {
  private readonly start = Date.now();
  readonly lines: string[] = [];
  add(source: string, text: string): void {
    const t = ((Date.now() - this.start) / 1000).toFixed(3).padStart(8);
    this.lines.push(`${t}s [${source}] ${text}`);
  }
  watchWorker(worker: Worker): void {
    this.add('sw', `started ${worker.url()}`);
    worker.on('console', (msg) => {
      this.add(`sw:${msg.type()}`, msg.text());
    });
    worker.on('close', () => {
      this.add('sw', 'terminated');
    });
  }
}

function shortUrl(url: string | undefined): string {
  if (!url) return '?';
  return url.replace(/^chrome-extension:\/\/[a-p]{32}/, 'ext:').replace(/\?.*$/, '');
}

export const test = base.extend<Fixtures>({
  // Fresh profile per test, real Chromium with the built extension and fake media devices.
  // Playwright's trace/video/screenshot options only cover contexts it creates, so this
  // persistent context applies the same policies (playwright.config.ts) by hand.
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use, testInfo) => {
    const log = new DiagnosticsLog();
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
      ],
      recordVideo: { dir: testInfo.outputPath('video') },
    });
    context.setDefaultTimeout(ACTION_TIMEOUT_MS);
    context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);

    for (const worker of context.serviceWorkers()) log.watchWorker(worker);
    context.on('serviceworker', (worker) => {
      log.watchWorker(worker);
    });
    context.on('console', (msg) => {
      log.add(`page:${msg.type()}`, `${shortUrl(msg.page()?.url())} ${msg.text()}`);
    });
    context.on('weberror', (err) => {
      log.add(
        'page:uncaught',
        `${shortUrl(err.page()?.url())} ${err.error().stack ?? String(err.error())}`,
      );
    });
    const videos: (Video | null)[] = [];
    context.on('page', (page) => {
      log.add('page', `opened ${shortUrl(page.url())}`);
      videos.push(page.video());
      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) log.add('page', `navigated ${shortUrl(frame.url())}`);
      });
    });

    // Tracing needs no code here: Playwright's `use.trace` (TRACE_MODE in settings.ts) also
    // instruments persistent contexts launched inside a test.
    await fetch(`${API_URL}/__test/reset`, { method: 'POST' });

    await use(context);

    const failed = testInfo.status !== testInfo.expectedStatus;
    if (failed) {
      for (const [i, page] of context.pages().entries()) {
        try {
          await testInfo.attach(`screenshot-${String(i)}-${shortUrl(page.url())}`, {
            body: await page.screenshot({ fullPage: true }),
            contentType: 'image/png',
          });
        } catch (error) {
          log.add('fixture', `screenshot failed: ${String(error)}`);
        }
      }
    }
    await context.close();

    // Videos are finalised on close: keep them only for failures.
    for (const [i, video] of videos.entries()) {
      if (!video) continue;
      if (failed)
        await testInfo.attach(`video-${String(i)}`, {
          path: await video.path(),
          contentType: 'video/webm',
        });
    }
    if (!failed) await rm(testInfo.outputPath('video'), { recursive: true, force: true });

    await testInfo.attach('extension-diagnostics.log', {
      body: log.lines.join('\n') || '(no output)',
      contentType: 'text/plain',
    });
  },
  serviceWorker: async ({ context }, use) => {
    const [existing] = context.serviceWorkers();
    await use(existing ?? (await context.waitForEvent('serviceworker')));
  },
  extensionId: async ({ serviceWorker }, use) => {
    await use(new URL(serviceWorker.url()).host);
  },
  host: async ({ context, extensionId }, use) => {
    const page = await context.newPage();
    await page.goto(`${HOST_URL}/?ext=${extensionId}`);
    await use(page);
  },
});

export { expect };

export async function mockState(): Promise<MockState> {
  const res = await fetch(`${API_URL}/__test/state`);
  return (await res.json()) as MockState;
}

/** Clicks "Start proctoring" on the host page and returns the consent tab. */
export async function startSession(context: BrowserContext, host: Page): Promise<Page> {
  const consentTab = context.waitForEvent('page');
  await host.click('#start');
  const page = await consentTab;
  await page.waitForURL(/consent\.html/);
  await expect(page.locator('h1')).toContainText('what this proctoring tool collects');
  return page;
}

export function badgeText(sw: Worker): Promise<string> {
  return sw.evaluate(() => chrome.action.getBadgeText({}));
}

export function offscreenCount(sw: Worker): Promise<number> {
  return sw.evaluate(async () => {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    });
    return contexts.length;
  });
}

/** Session status as persisted by the service worker (chrome.storage.session). */
export function storedStatus(sw: Worker): Promise<string | undefined> {
  return sw.evaluate(async () => {
    const data = await chrome.storage.session.get('proctor.session');
    const stored = data['proctor.session'] as { session: { status: string } } | undefined;
    return stored?.session.status;
  });
}

export interface RulesData {
  log: { type: string; ts: number }[];
  anomalies: { type: string; ts: number; confidence: number }[];
}

/** The browser rule engine's persisted rolling log and pending anomalies. */
export function rulesData(sw: Worker): Promise<RulesData> {
  return sw.evaluate(async () => {
    const data = await chrome.storage.session.get('proctor.session');
    const stored = data['proctor.session'] as
      { rules?: { log: RulesData['log'] }; anomalies?: RulesData['anomalies'] } | undefined;
    return { log: stored?.rules?.log ?? [], anomalies: stored?.anomalies ?? [] };
  });
}

/**
 * Turns the stored anomalies into violations with the real core merger, as the backend will.
 * Detected anomalies carry no evidence yet (Phase 6), so a placeholder reference is added.
 */
export function mergedViolations(data: RulesData, policy: Policy = DEFAULT_POLICY): Violation[] {
  const anomalies: Anomaly[] = data.anomalies.map((a, i) => ({
    id: `a${String(i)}`,
    type: a.type as Anomaly['type'],
    ts: a.ts,
    confidence: a.confidence,
    evidence: [{ id: `e${String(i)}`, kind: 'event_sequence', ts: a.ts }],
  }));
  return mergeViolations(anomalies, policy);
}

/** Opens the host page, starts a session and completes consent + setup. */
export async function startActiveSession(
  context: BrowserContext,
  extensionId: string,
  token = 'tok-demo',
): Promise<Page> {
  const host = await context.newPage();
  await host.goto(`${HOST_URL}/?ext=${extensionId}&token=${token}`);
  await acceptAndCompleteSetup(await startSession(context, host));
  await expect(host.locator('#events')).toContainText('ready');
  await host.bringToFront();
  return host;
}

/** Makes the next `count` consent uploads fail with 503. */
export async function failNextConsents(count: number): Promise<void> {
  await fetch(`${API_URL}/__test/fail-consents?count=${String(count)}`, { method: 'POST' });
}

/** Accepts consent, runs the setup check and continues. Returns console warnings from setup. */
export async function acceptAndCompleteSetup(consent: Page): Promise<string[]> {
  const warnings: string[] = [];
  consent.on('console', (msg) => {
    if (msg.type() === 'warning' || msg.type() === 'error') warnings.push(msg.text());
  });
  await consent.check('#agree-checkbox');
  await consent.click('#agree');
  await consent.waitForURL(/setup\.html/);
  await consent.click('#start-check');
  await expect(consent.locator('#continue')).toBeEnabled({ timeout: 30_000 });
  for (const check of ['face', 'mic', 'performance']) {
    await expect(consent.locator(`[data-check="${check}"]`)).toHaveText(
      /^(Ready|Needs attention)$/,
    );
  }
  // The bundled MediaPipe model must load inside the extension (no remote fetch).
  await expect(consent.locator('main')).not.toContainText('The face check could not run');
  const closed = consent.waitForEvent('close');
  await consent.click('#continue');
  await closed;
  return warnings;
}
