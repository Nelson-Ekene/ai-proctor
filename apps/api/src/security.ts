import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// Opaque bearer secrets (API keys, session tokens, login tokens) are random 32-byte values;
// only their SHA-256 is stored, so a database leak does not leak usable credentials.

export type TokenKind = 'api_key' | 'session' | 'user';

const PREFIX: Record<TokenKind, string> = { api_key: 'pak_', session: 'pst_', user: 'put_' };

export function newToken(kind: TokenKind): string {
  return PREFIX[kind] + randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Random, unguessable object key for stored evidence (never derived from ids). */
export function newStorageKey(): string {
  return `evidence/${randomBytes(24).toString('base64url')}`;
}

// scrypt parameters (OWASP minimum: N=2^17, r=8, p=1).
const N = 2 ** 17;
const R = 8;
const P = 1;
const KEY_LENGTH = 32;
const MAX_MEM = 256 * 1024 * 1024;

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, { N: n, r, p, maxmem: MAX_MEM }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

/** Returns `scrypt$N$r$p$salt$hash` (base64url fields). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P);
  return ['scrypt', N, R, P, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !n || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const actual = await derive(password, Buffer.from(salt, 'base64url'), +n, +r, +p);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

let dummy: Promise<string> | undefined;

/** Hash of a random password, so unknown e-mails cost the same time as known ones. */
export function dummyPasswordHash(): Promise<string> {
  dummy ??= hashPassword(randomBytes(16).toString('hex'));
  return dummy;
}
