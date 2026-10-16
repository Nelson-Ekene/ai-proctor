import { PERMISSIONS, type ProctorManifest } from './manifest.ts';

// Chrome Web Store release gate (BUILD_PLAN Phase 9.4). Pure: scripts/package.ts runs it on the
// built manifest before zipping, and refuses to package if anything is listed here.

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

export function releaseProblems(manifest: ProctorManifest, files: readonly string[]): string[] {
  const problems: string[] = [];
  if (manifest.key !== undefined) {
    problems.push('manifest has the dev "key": build in production mode');
  }
  const extra = manifest.permissions.filter((p) => !(PERMISSIONS as readonly string[]).includes(p));
  if (extra.length > 0) problems.push(`unexpected permissions: ${extra.join(', ')}`);

  const patterns = [
    ...manifest.host_permissions,
    ...manifest.externally_connectable.matches,
    ...manifest.content_scripts.flatMap((c) => c.matches),
  ];
  if (patterns.length === 0) problems.push('no exam/API origins configured');
  for (const pattern of new Set(patterns)) {
    if (pattern.includes('*://') || pattern === '<all_urls>' || /\/\/\*/.test(pattern)) {
      problems.push(`wildcard origin not allowed: ${pattern}`);
      continue;
    }
    let url: URL;
    try {
      url = new URL(pattern.replace(/\*$/, ''));
    } catch {
      problems.push(`invalid match pattern: ${pattern}`);
      continue;
    }
    if (url.protocol !== 'https:') problems.push(`origin must use https: ${pattern}`);
    if (LOCAL_HOSTS.has(url.hostname))
      problems.push(`localhost origin in a store build: ${pattern}`);
  }

  if (files.some((f) => /diagnostics/i.test(f))) {
    problems.push('diagnostics page included: build without PROCTOR_DIAGNOSTICS');
  }
  if (!files.some((f) => f.startsWith('vendor/models/'))) {
    problems.push('bundled models missing (vendor/models): run prepare-assets');
  }
  return problems;
}
