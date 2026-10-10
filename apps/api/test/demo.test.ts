import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedDemoSessions } from '../src/demo';
import type { SessionReport } from '../src/report';
import { call, createTestContext, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(() => ctx.close());

describe('demo seed', () => {
  it('creates ranked sessions whose evidence is all uploaded; the first is the PRD sample', async () => {
    const seeded = await seedDemoSessions(ctx.db, ctx.storage, ctx.orgA.id, ctx.clock.now);
    const reports = await Promise.all(
      seeded.map(async (s) => {
        const res = await call(ctx.app, ctx.orgA.reviewerToken, {
          method: 'GET',
          url: `/v1/sessions/${s.id}/report`,
        });
        return res.json<SessionReport>();
      }),
    );
    const [prd] = reports;
    expect(prd?.risk).toBe(49);
    expect(prd?.band).toBe('medium');
    for (const r of reports) {
      expect(r.reproducible).toBe(true);
      for (const v of r.violations) {
        expect(v.evidence.length).toBeGreaterThan(0);
        expect(v.evidence.every((e) => e.uploaded)).toBe(true);
      }
    }
    const list = await call(ctx.app, ctx.orgA.reviewerToken, {
      method: 'GET',
      url: '/v1/sessions',
    });
    const ranked = list.json<{ sessions: { candidateRef: string; band: string }[] }>().sessions;
    expect(ranked.map((s) => s.candidateRef)).toEqual([
      'demo-candidate-2',
      'demo-candidate-1',
      'demo-candidate-3',
      'demo-candidate-4',
    ]);
    expect(ranked[0]?.band).toBe('high');
  });
});
