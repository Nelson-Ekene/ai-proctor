import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { VIOLATION_LABELS } from '../src/report';

// CLAUDE.md: advisory only. No pass/fail/disqualify/block/end-test state in the API or DB.

const VERDICT = /\b(pass(ed)?|fail(ed|s)?|disqualif\w*|block(ed)?|cheat\w*|guilty|end[-_ ]test)\b/i;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('no verdict states', () => {
  it('the database schema (migrations) has none', () => {
    const dir = join(root, 'drizzle');
    const sql = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => readFileSync(join(dir, f), 'utf8'))
      .join('\n');
    expect(sql.length).toBeGreaterThan(0);
    expect(sql).not.toMatch(VERDICT);
  });

  it('reviewer-facing labels and report text have none', () => {
    for (const label of Object.values(VIOLATION_LABELS)) expect(label).not.toMatch(VERDICT);
    // The PDF is rendered from string literals in report.ts.
    expect(readFileSync(join(root, 'src', 'report.ts'), 'utf8')).not.toMatch(VERDICT);
  });
});
