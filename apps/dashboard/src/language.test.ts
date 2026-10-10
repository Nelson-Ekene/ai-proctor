import { describe, expect, it } from 'vitest';

// BUILD_PLAN Phase 8.7 UI language audit: reviewers only ever see "Low / Medium / High risk" and
// "flagged for review". No verdict words anywhere in the dashboard source (strings or code).

const VERDICT = /\b(cheat\w*|fail\w*|guilty|pass(ed|es)?|disqualif\w*|block(ed|s)?|suspicious)\b/i;

/** CSS class lists are styling, not wording (Tailwind has a `block` utility). */
const withoutClasses = (text: string) =>
  text.replace(/className=(\{`[^`]*`\}|"[^"]*")/g, 'className=""');

const files = Object.entries(
  import.meta.glob<string>(['./**/*.{ts,tsx}', '!./**/*.test.{ts,tsx}', '!./test/**'], {
    query: '?raw',
    import: 'default',
    eager: true,
  }),
);

describe('UI language audit', () => {
  it('scans the dashboard sources', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it.each(files)('%s has no verdict words', (path, text) => {
    const match = VERDICT.exec(withoutClasses(text));
    expect(match?.[0], `"${match?.[0] ?? ''}" in ${path}`).toBeUndefined();
  });

  it('bands are only ever shown as Low / Medium / High risk', () => {
    for (const [, text] of files)
      expect(withoutClasses(text)).not.toMatch(/['"`](low|medium|high) band['"`]/i);
  });
});
