import {
  test as base,
  chromium,
  expect,
  type BrowserContext,
  type Page,
  type Worker,
} from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MockState } from './mock-server.ts';

const EXTENSION_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'apps',
  'extension',
  'build',
);
export const HOST_URL = 'http://localhost:4400';
export const API_URL = 'http://localhost:4401';

interface Fixtures {
  context: BrowserContext;
  serviceWorker: Worker;
  extensionId: string;
  host: Page;
}

export const test = base.extend<Fixtures>({
  // Fresh profile per test, real Chromium with the built extension and fake media devices.
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
      ],
    });
    await fetch(`${API_URL}/__test/reset`, { method: 'POST' });
    await use(context);
    await context.close();
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
