import { toMatchPattern, type ExtensionConfig } from './config.ts';

/**
 * Dev-only public key: gives unpacked builds a stable extension ID
 * (akponalihmmaihgcnonegjelddajfdka) so the mock host page can address it. The private key
 * was discarded. Production builds omit `key`; see "Release checklist" in the README.
 */
export const DEV_PUBLIC_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxrucu+80JBR7q+ti1PNghwWpDUZPBu4cwcq4/z7wBRh0HooppkYlnaR7FHqNhcGluAQNyJEpE6CKvOpqoPPuw5+iQU1vzwMb5c2JJvtkOvhjgFhIxDKAoDjVq92pbWaje9Bx+exj0/TGJVPHjGp8Sk/daAHA630Lc3JTqDTB6JXcTRBXVJbKr72G0C3kYc+JMqhNZ9eUpZuogQYNaxl3VMXXoLRPVkNgJod0lke2D3uYXdrhCQV2A5fll3VAfKRHakm/WDzMSOvCsXluMuEFy0hptBuPmK0HewXWj5k1QBUvMBQw0gCTS8yDShTCptsk7IJherTky6/gHsIylzoA5QIDAQAB';

export const PERMISSIONS = ['offscreen', 'storage', 'alarms', 'tabs'] as const;

export interface ProctorManifest {
  manifest_version: 3;
  name: string;
  version: string;
  description: string;
  minimum_chrome_version: string;
  permissions: string[];
  host_permissions: string[];
  background: { service_worker: string; type: 'module' };
  content_scripts: { matches: string[]; js: string[] }[];
  externally_connectable: { matches: string[] };
  action: { default_title: string };
  content_security_policy: { extension_pages: string };
  key?: string;
}

/**
 * Pure manifest builder. All origin-scoped fields come from the build-time config: only the
 * configured exam origins may message the extension or receive the content script.
 */
export function buildManifest(config: ExtensionConfig, mode: string): ProctorManifest {
  const examPatterns = config.examOrigins.map(toMatchPattern);
  const apiPatterns = config.apiOrigins.map(toMatchPattern);
  return {
    manifest_version: 3,
    name: 'AI Proctoring (advisory)',
    version: '0.1.0',
    description:
      'Samples webcam, microphone and browser signals during an online exam to support human review. Never decides results.',
    minimum_chrome_version: '116',
    permissions: [...PERMISSIONS],
    host_permissions: [...examPatterns, ...apiPatterns],
    background: { service_worker: 'src/background/index.ts', type: 'module' },
    content_scripts: [{ matches: examPatterns, js: ['src/content/index.ts'] }],
    externally_connectable: { matches: examPatterns },
    action: { default_title: 'Proctoring: inactive' },
    content_security_policy: {
      // wasm-unsafe-eval is required for the bundled MediaPipe WebAssembly runtime.
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
    ...(mode === 'production' ? {} : { key: DEV_PUBLIC_KEY }),
  };
}
