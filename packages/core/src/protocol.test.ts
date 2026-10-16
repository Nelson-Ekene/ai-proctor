import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY } from './policy';
import { PROCTOR_EVENT_SOURCE, SDK_EVENTS } from './protocol';
import {
  ConsentRecordSchema,
  EndSessionSchema,
  ExternalRequestSchema,
  SessionInfoSchema,
  SetupCheckRecordSchema,
} from './protocol-schemas';

describe('external request schema', () => {
  it('accepts the three requests', () => {
    expect(
      ExternalRequestSchema.parse({
        type: 'proctor:start',
        sessionToken: 't',
        apiBase: 'https://api.example',
      }),
    ).toMatchObject({ type: 'proctor:start' });
    expect(ExternalRequestSchema.parse({ type: 'proctor:end' })).toEqual({ type: 'proctor:end' });
    expect(ExternalRequestSchema.parse({ type: 'proctor:status' })).toEqual({
      type: 'proctor:status',
    });
  });

  it.each([
    {},
    { type: 'proctor:start', sessionToken: '', apiBase: 'https://a.example' },
    { type: 'proctor:start', sessionToken: 't', apiBase: 'not a url' },
    { type: 'proctor:start', sessionToken: 't'.repeat(5000), apiBase: 'https://a.example' },
    { type: 'proctor:end', extra: 1 },
    { type: 'proctor:disqualify' },
  ])('rejects %j', (bad) => {
    expect(ExternalRequestSchema.safeParse(bad).success).toBe(false);
  });
});

describe('API contract schemas', () => {
  it('session info carries a valid policy snapshot', () => {
    expect(
      SessionInfoSchema.parse({ sessionId: 's', policySnapshot: DEFAULT_POLICY }),
    ).toBeTruthy();
    expect(
      SessionInfoSchema.safeParse({
        sessionId: 's',
        policySnapshot: { ...DEFAULT_POLICY, weights: { browser: 1, video: 1, audio: 1 } },
      }).success,
    ).toBe(false);
  });

  it('consent records are accepted or declined, with a notice version', () => {
    expect(
      ConsentRecordSchema.parse({ decision: 'accepted', noticeVersion: 'v1', ts: 1 }),
    ).toBeTruthy();
    expect(
      ConsentRecordSchema.safeParse({ decision: 'maybe', noticeVersion: 'v1', ts: 1 }).success,
    ).toBe(false);
    expect(
      ConsentRecordSchema.safeParse({ decision: 'declined', noticeVersion: '', ts: 1 }).success,
    ).toBe(false);
  });

  it('end session takes a timestamp', () => {
    expect(EndSessionSchema.parse({ ts: 5 })).toEqual({ ts: 5 });
  });
});

describe('protocol constants', () => {
  it('exposes only advisory SDK events', () => {
    expect(PROCTOR_EVENT_SOURCE).toBe('proctor-extension');
    expect(SDK_EVENTS).toEqual(['ready', 'consent_declined', 'ended']);
  });
});

describe('SetupCheckRecordSchema', () => {
  it('accepts a setup outcome and rejects anything else', () => {
    const ok = { result: { face: 'ready', mic: 'needs_attention', performance: 'ready' }, ts: 1 };
    expect(SetupCheckRecordSchema.parse(ok)).toEqual(ok);
    expect(
      SetupCheckRecordSchema.safeParse({ ...ok, result: { ...ok.result, face: 'ok' } }).success,
    ).toBe(false);
    expect(SetupCheckRecordSchema.safeParse({ ...ok, frame: 'x' }).success).toBe(false);
  });
});
