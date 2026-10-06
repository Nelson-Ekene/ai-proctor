import { describe, expect, it } from 'vitest';
import { parseExtensionConfig } from './config';
import { DEV_PUBLIC_KEY, buildManifest } from './manifest';

const defaults = parseExtensionConfig({});
const custom = parseExtensionConfig({
  PROCTOR_EXAM_ORIGINS: 'https://exam.example.com,https://exam2.example.com',
  PROCTOR_API_ORIGINS: 'https://api.example.com',
});

describe('buildManifest', () => {
  it('externally_connectable lists exactly the configured exam origins', () => {
    expect(buildManifest(defaults, 'production').externally_connectable).toEqual({
      matches: ['http://localhost:4400/*'],
    });
    expect(buildManifest(custom, 'production').externally_connectable).toEqual({
      matches: ['https://exam.example.com/*', 'https://exam2.example.com/*'],
    });
  });

  it('scopes content scripts and host permissions to configured origins only', () => {
    const m = buildManifest(custom, 'production');
    expect(m.content_scripts).toEqual([
      {
        matches: ['https://exam.example.com/*', 'https://exam2.example.com/*'],
        js: ['src/content/index.ts'],
      },
    ]);
    expect(m.host_permissions).toEqual([
      'https://exam.example.com/*',
      'https://exam2.example.com/*',
      'https://api.example.com/*',
    ]);
  });

  it('never contains broad host patterns', () => {
    for (const mode of ['production', 'development']) {
      const json = JSON.stringify(buildManifest(custom, mode));
      expect(json).not.toContain('<all_urls>');
      expect(json).not.toMatch(/:\/\/\*/); // no wildcard hosts
      expect(json).not.toMatch(/"\*:\/\//); // no wildcard schemes
    }
  });

  it('requests only the permissions BUILD_PLAN lists', () => {
    expect(buildManifest(defaults, 'production').permissions).toEqual([
      'offscreen',
      'storage',
      'alarms',
      'tabs',
    ]);
  });

  it('includes the dev key outside production only', () => {
    expect(buildManifest(defaults, 'production').key).toBeUndefined();
    expect(buildManifest(defaults, 'development').key).toBe(DEV_PUBLIC_KEY);
  });
});
