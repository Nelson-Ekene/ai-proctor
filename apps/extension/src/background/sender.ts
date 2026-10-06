import { isAllowedOrigin, type ExtensionConfig } from '../config';
import type { InternalSender } from './orchestrator';

interface SenderLike {
  id?: string | undefined;
  url?: string | undefined;
  tab?: { id?: number | undefined } | undefined;
}

/** Compares scheme and host explicitly: URL.origin is "null" for non-web schemes outside Chrome. */
function isExtensionUrl(url: string | undefined, extensionId: string): boolean {
  if (url === undefined) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'chrome-extension:' && parsed.host === extensionId;
  } catch {
    return false;
  }
}

/**
 * Classifies a runtime.onMessage sender. Extension pages (consent, setup, offscreen) have the
 * extension's own origin; content scripts run in exam-origin tabs. Anything else is unknown.
 */
export function classifySender(
  sender: SenderLike,
  extensionId: string,
  config: ExtensionConfig,
): InternalSender {
  const tabId = sender.tab?.id;
  if (sender.id !== extensionId) return { kind: 'unknown', tabId };
  if (isExtensionUrl(sender.url, extensionId)) return { kind: 'extension_page', tabId };
  if (tabId !== undefined && isAllowedOrigin(sender.url, config.examOrigins)) {
    return { kind: 'content_script', tabId };
  }
  return { kind: 'unknown', tabId };
}
