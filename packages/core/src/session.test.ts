import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, parsePolicy } from './policy';
import {
  SESSION_STATUSES,
  SessionStateSchema,
  captureAllowed,
  isTerminal,
  mediaAllowed,
  transition,
  type SessionEvent,
  type SessionState,
  type SessionStatus,
} from './session';

function state(status: SessionStatus = 'awaiting_consent', mediaOn = false): SessionState {
  return {
    status,
    sessionId: 's1',
    sessionToken: 'tok',
    apiBase: 'https://api.example',
    examTabId: 7,
    policy: parsePolicy(DEFAULT_POLICY),
    startedAt: 1000,
    mediaOn,
  };
}

const ALL_EVENTS: SessionEvent[] = [
  { type: 'consent_accepted', ts: 2 },
  { type: 'consent_declined', ts: 2 },
  { type: 'setup_completed', ts: 2 },
  { type: 'media_changed', on: true },
  { type: 'media_changed', on: false },
  { type: 'end', ts: 2 },
];

describe('session lifecycle', () => {
  it('runs the happy path: consent -> setup -> active -> ended', () => {
    let s = state();
    s = transition(s, { type: 'consent_accepted', ts: 2000 });
    expect(s).toMatchObject({ status: 'setup', consentAt: 2000 });
    s = transition(s, { type: 'setup_completed', ts: 3000 });
    expect(s).toMatchObject({ status: 'active', activeAt: 3000 });
    s = transition(s, { type: 'media_changed', on: true });
    expect(s.mediaOn).toBe(true);
    s = transition(s, { type: 'end', ts: 4000 });
    expect(s).toMatchObject({ status: 'ended', endedAt: 4000, mediaOn: false });
    expect(() => SessionStateSchema.parse(s)).not.toThrow();
  });

  it('declining consent is terminal and nothing can start afterwards', () => {
    let s = transition(state(), { type: 'consent_declined', ts: 2000 });
    expect(s).toMatchObject({ status: 'consent_declined', endedAt: 2000 });
    for (const e of ALL_EVENTS) s = transition(s, e);
    expect(s.status).toBe('consent_declined');
    expect(s.mediaOn).toBe(false);
  });

  it('never allows media or capture before consent', () => {
    expect(mediaAllowed('awaiting_consent')).toBe(false);
    expect(mediaAllowed('consent_declined')).toBe(false);
    expect(captureAllowed('awaiting_consent')).toBe(false);
    expect(captureAllowed('setup')).toBe(false);
    expect(mediaAllowed('setup')).toBe(true);
    expect(captureAllowed('active')).toBe(true);
    expect(mediaAllowed('ended')).toBe(false);
  });

  it.each(SESSION_STATUSES.filter((s) => s !== 'active'))(
    'ignores media turning on in %s',
    (status) => {
      const s = state(status);
      expect(transition(s, { type: 'media_changed', on: true })).toBe(s);
    },
  );

  it('lets media turn off in any state and ignores no-op media changes', () => {
    const on = state('active', true);
    expect(transition(on, { type: 'media_changed', on: true })).toBe(on);
    expect(transition(on, { type: 'media_changed', on: false }).mediaOn).toBe(false);
    const setupWithMedia = state('setup', true);
    expect(transition(setupWithMedia, { type: 'media_changed', on: false }).mediaOn).toBe(false);
  });

  it('returns the same object for out-of-order events', () => {
    const awaiting = state();
    expect(transition(awaiting, { type: 'setup_completed', ts: 2 })).toBe(awaiting);
    const setup = state('setup');
    expect(transition(setup, { type: 'consent_accepted', ts: 2 })).toBe(setup);
    expect(transition(setup, { type: 'consent_declined', ts: 2 })).toBe(setup);
    const active = state('active');
    expect(transition(active, { type: 'setup_completed', ts: 2 })).toBe(active);
  });

  it('can end from any non-terminal state, once', () => {
    for (const status of ['awaiting_consent', 'setup', 'active'] as const) {
      expect(transition(state(status), { type: 'end', ts: 9 }).status).toBe('ended');
    }
    const ended = state('ended');
    expect(transition(ended, { type: 'end', ts: 10 })).toBe(ended);
  });

  it('classifies terminal states', () => {
    expect(SESSION_STATUSES.filter(isTerminal)).toEqual(['consent_declined', 'ended']);
  });

  it('has no judging states', () => {
    for (const s of SESSION_STATUSES) expect(s).not.toMatch(/pass|fail|disqualif|block/);
  });
});
