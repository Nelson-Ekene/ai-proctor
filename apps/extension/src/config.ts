// Build-time configuration: which exam sites may start sessions and which API hosts the
// extension may talk to. Drives the manifest (host permissions, content scripts,
// externally_connectable) and runtime allow-list checks. No broad host access, ever.

export interface ExtensionConfig {
  examOrigins: string[];
  apiOrigins: string[];
}

/**
 * Development/test origins (localhost only): the mock host/API (4400/4401), the demo exam site
 * and real API of `pnpm demo` (4500/4000), and the full-stack e2e suite (4620/4621). Store
 * builds must set real https origins (`pnpm --filter @proctor/extension package` enforces it).
 */
export const DEV_DEFAULTS = {
  PROCTOR_EXAM_ORIGINS: 'http://localhost:4400,http://localhost:4500,http://localhost:4620',
  PROCTOR_API_ORIGINS: 'http://localhost:4401,http://localhost:4000,http://localhost:4621',
} as const;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

/** Accepts an exact origin: https, or http only for localhost. No paths, no wildcards. */
export function parseOrigin(value: string): string {
  const trimmed = value.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`Invalid origin: "${trimmed}"`);
  }
  const secure =
    url.protocol === 'https:' || (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname));
  if (!secure) throw new Error(`Origin must use https (http only for localhost): "${trimmed}"`);
  // URL accepts characters such as "*" in hosts; only allow plain DNS names and IPv4.
  if (!/^[a-z0-9.-]+$/i.test(url.hostname)) throw new Error(`Invalid origin host: "${trimmed}"`);
  if (url.origin !== trimmed)
    throw new Error(`Expected a bare origin like ${url.origin}: "${trimmed}"`);
  return url.origin;
}

function parseList(raw: string, name: string): string[] {
  const origins = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map(parseOrigin);
  if (origins.length === 0) throw new Error(`${name} must list at least one origin`);
  return [...new Set(origins)];
}

export function parseExtensionConfig(
  env: Partial<Record<keyof typeof DEV_DEFAULTS, string>>,
): ExtensionConfig {
  return {
    examOrigins: parseList(
      env.PROCTOR_EXAM_ORIGINS ?? DEV_DEFAULTS.PROCTOR_EXAM_ORIGINS,
      'PROCTOR_EXAM_ORIGINS',
    ),
    apiOrigins: parseList(
      env.PROCTOR_API_ORIGINS ?? DEV_DEFAULTS.PROCTOR_API_ORIGINS,
      'PROCTOR_API_ORIGINS',
    ),
  };
}

export function toMatchPattern(origin: string): string {
  return `${origin}/*`;
}

/** True when `url` parses and its origin is exactly one of `origins`. */
export function isAllowedOrigin(url: string | undefined, origins: readonly string[]): boolean {
  if (url === undefined) return false;
  try {
    return origins.includes(new URL(url).origin);
  } catch {
    return false;
  }
}
