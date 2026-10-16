import { describe, expect, it } from 'vitest';
import { buildManifest } from './manifest.ts';
import { releaseProblems } from './release.ts';

const FILES = ['manifest.json', 'vendor/models/blaze_face_short_range.tflite', 'assets/index.js'];
const store = buildManifest(
  { examOrigins: ['https://exam.example.com'], apiOrigins: ['https://api.example.com'] },
  'production',
);

describe('release check', () => {
  it('accepts a production build with https origins', () => {
    expect(releaseProblems(store, FILES)).toEqual([]);
  });

  it('refuses dev builds, localhost/http origins and wildcards', () => {
    const dev = buildManifest(
      { examOrigins: ['http://localhost:4400'], apiOrigins: ['http://localhost:4401'] },
      'development',
    );
    const problems = releaseProblems(dev, FILES);
    expect(problems).toContain('manifest has the dev "key": build in production mode');
    expect(problems).toContain('origin must use https: http://localhost:4400/*');
    expect(problems).toContain('localhost origin in a store build: http://localhost:4401/*');

    const wild = { ...store, host_permissions: ['<all_urls>', 'https://*/*'] };
    expect(releaseProblems(wild, FILES)).toEqual([
      'wildcard origin not allowed: <all_urls>',
      'wildcard origin not allowed: https://*/*',
    ]);
  });

  it('refuses extra permissions, a diagnostics page or missing models', () => {
    const extra = { ...store, permissions: [...store.permissions, 'history'] };
    expect(releaseProblems(extra, FILES)).toEqual(['unexpected permissions: history']);
    expect(releaseProblems(store, [...FILES, 'src/pages/diagnostics.html'])).toEqual([
      'diagnostics page included: build without PROCTOR_DIAGNOSTICS',
    ]);
    expect(releaseProblems(store, ['manifest.json'])).toEqual([
      'bundled models missing (vendor/models): run prepare-assets',
    ]);
  });
});
