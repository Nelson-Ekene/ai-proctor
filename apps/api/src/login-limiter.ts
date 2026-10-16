/**
 * Slows down password guessing: after `maxFailures` failed logins for the same e-mail from the
 * same address within `windowMs`, further attempts are refused until the window passes. In
 * memory (one API process); a multi-instance deployment needs a shared store.
 */
export class LoginLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly maxFailures: number,
    private readonly windowMs: number,
  ) {}

  private recent(key: string, now: number): number[] {
    const kept = (this.failures.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (kept.length === 0) this.failures.delete(key);
    else this.failures.set(key, kept);
    return kept;
  }

  /** Milliseconds until another attempt is allowed, or 0 if allowed now. */
  retryAfterMs(key: string, now: number): number {
    const recent = this.recent(key, now);
    if (recent.length < this.maxFailures) return 0;
    const oldest = recent[recent.length - this.maxFailures] ?? now;
    return Math.max(1, oldest + this.windowMs - now);
  }

  fail(key: string, now: number): void {
    this.failures.set(key, [...this.recent(key, now), now]);
  }

  succeed(key: string): void {
    this.failures.delete(key);
  }
}
