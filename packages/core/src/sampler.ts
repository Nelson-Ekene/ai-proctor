import type { Policy } from './policy';

/** Returns a float in [0, 1). Inject a CSPRNG in production and a seeded/fake one in tests. */
export type Rng = () => number;

/**
 * FR1: split the window into `framesPerWindow` equal slots and pick one random moment in each.
 *
 * Works in integer milliseconds: slot i spans [b_i, b_{i+1}) with b_i = start + round(i * w / N),
 * and the frame is b_i + floor(r * (b_{i+1} - b_i)). This keeps times strictly increasing and
 * inside their slot even at epoch-ms magnitudes, where float arithmetic can round a late pick
 * onto the next slot's start. (The policy guarantees every slot is at least 1 ms wide.)
 */
export function sampleFrameTimes(windowStart: number, policy: Policy, rng: Rng): number[] {
  if (!Number.isSafeInteger(windowStart)) {
    throw new RangeError('windowStart must be an integer epoch ms');
  }
  const { framesPerWindow, windowSeconds } = policy.sampling;
  const windowMs = windowSeconds * 1000;
  const bound = (slot: number) => windowStart + Math.round((slot * windowMs) / framesPerWindow);

  const times: number[] = [];
  for (let slot = 0; slot < framesPerWindow; slot++) {
    const r = rng();
    if (!(r >= 0 && r < 1)) throw new RangeError('rng must return a number in [0, 1)');
    const start = bound(slot);
    times.push(start + Math.floor(r * (bound(slot + 1) - start)));
  }
  return times;
}
