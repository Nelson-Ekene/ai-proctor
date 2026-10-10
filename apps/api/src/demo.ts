import {
  categoryOf,
  DEFAULT_POLICY,
  encodeWav,
  type Anomaly,
  type BrowserLogEntry,
  type EventSequence,
  type EvidenceRef,
  type ViolationType,
} from '@proctor/core';
import jpeg from 'jpeg-js';
import { randomUUID } from 'node:crypto';
import type { Db } from './db/client';
import { sessions } from './db/schema';
import { storeEvidence } from './evidence';
import { ingestAnomaly } from './ingest';
import { hashToken, newToken } from './security';
import type { EvidenceStorage } from './storage';

// Demo sessions for the dashboard (`pnpm --filter @proctor/api seed -- --demo` and the dashboard
// e2e test). They go through the same ingestion and evidence code as real uploads; frames and
// clips are synthetic (drawn shapes and tones), never real people.

const MIN = 60_000;

interface DemoAnomaly {
  type: ViolationType;
  /** Minutes after the session start. */
  at: number;
  confidence: number;
}

interface DemoSession {
  candidateRef: string;
  minutes: number;
  anomalies: DemoAnomaly[];
}

/**
 * The first session is the PRD sample: browser 50, video 60, audio 25 = 49.0 Medium risk. The
 * second is high risk (video capped at 100), the third low, the fourth has nothing flagged.
 */
export const DEMO_SESSIONS: readonly DemoSession[] = [
  {
    candidateRef: 'demo-candidate-1',
    minutes: 45,
    anomalies: [
      { type: 'tab_switch_or_blur', at: 3, confidence: 1 },
      { type: 'phone_detected', at: 7, confidence: 1 },
      { type: 'tab_switch_or_blur', at: 12, confidence: 1 },
      { type: 'phone_detected', at: 18, confidence: 1 },
      { type: 'tab_switch_or_blur', at: 24, confidence: 1 },
      { type: 'copy_paste', at: 27, confidence: 1 },
      { type: 'speech_detected', at: 31, confidence: 1 },
      { type: 'speech_detected', at: 38, confidence: 2 / 3 },
    ],
  },
  {
    candidateRef: 'demo-candidate-2',
    minutes: 50,
    anomalies: [
      { type: 'multiple_faces', at: 5, confidence: 0.92 },
      { type: 'multiple_faces', at: 5.5, confidence: 0.88 },
      { type: 'phone_detected', at: 9, confidence: 0.81 },
      { type: 'speech_detected', at: 14, confidence: 0.95 },
      { type: 'multiple_voices', at: 14.2, confidence: 0.55 },
      { type: 'fullscreen_exit', at: 20, confidence: 1 },
      { type: 'tab_switch_or_blur', at: 20.3, confidence: 1 },
      { type: 'no_face', at: 26, confidence: 0.7 },
      { type: 'tab_switch_or_blur', at: 28, confidence: 1 },
      { type: 'phone_detected', at: 30, confidence: 0.9 },
      { type: 'copy_paste', at: 30.5, confidence: 1 },
      { type: 'gaze_away_sustained', at: 33, confidence: 0.64 },
      { type: 'tab_switch_or_blur', at: 36, confidence: 1 },
      { type: 'multiple_faces', at: 40, confidence: 0.92 },
      { type: 'speech_detected', at: 44, confidence: 0.9 },
    ],
  },
  {
    candidateRef: 'demo-candidate-3',
    minutes: 40,
    anomalies: [
      { type: 'copy_paste', at: 11, confidence: 1 },
      { type: 'inactivity', at: 22, confidence: 1 },
    ],
  },
  { candidateRef: 'demo-candidate-4', minutes: 42, anomalies: [] },
];

/** A synthetic 320x240 "webcam" frame: a figure, optionally a second one or a phone. */
export function demoFrame(type: ViolationType, seed: number): Buffer {
  const width = 320;
  const height = 240;
  const data = Buffer.alloc(width * height * 4);
  const shade = 20 * (seed % 3);
  const people =
    type === 'no_face'
      ? []
      : type === 'multiple_faces'
        ? [110, 220]
        : [type === 'gaze_away_sustained' ? 190 : 160];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 170 + shade - y / 6;
      let g = 180 + shade - y / 6;
      let b = 195 + shade - y / 8;
      for (const cx of people) {
        const head = ((x - cx) / 34) ** 2 + ((y - 95) / 42) ** 2 <= 1;
        const body = ((x - cx) / 70) ** 2 + ((y - 250) / 95) ** 2 <= 1;
        if (body) [r, g, b] = [70, 90, 120];
        if (head) [r, g, b] = [205, 170, 140];
      }
      if (type === 'phone_detected' && x > 200 && x < 236 && y > 150 && y < 215) {
        const screen = x > 204 && x < 232 && y > 156 && y < 208;
        [r, g, b] = screen ? [120, 170, 230] : [25, 25, 30];
      }
      if (type === 'book_or_notes' && x > 190 && x < 270 && y > 160 && y < 220)
        [r, g, b] = [150, 60, 50];
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return jpeg.encode({ data, width, height }, 80).data;
}

/** A synthetic speech-like clip: syllable-shaped tone bursts (two pitches for "two voices"). */
export function demoClip(type: ViolationType, seconds = 3): Buffer {
  const rate = 16_000;
  const samples = new Float32Array(rate * seconds);
  for (let i = 0; i < samples.length; i++) {
    const t = i / rate;
    const syllable = Math.max(0, Math.sin(Math.PI * t * 4)) ** 2;
    const pitch = type === 'multiple_voices' && Math.floor(t) % 2 === 1 ? 240 : 120;
    samples[i] =
      0.3 *
      syllable *
      (Math.sin(2 * Math.PI * pitch * t) + 0.4 * Math.sin(4 * Math.PI * pitch * t));
  }
  return Buffer.from(encodeWav(samples, rate));
}

const EVENTS: Partial<Record<ViolationType, [BrowserLogEntry['type'], number][]>> = {
  tab_switch_or_blur: [
    ['visibility_hidden', 0],
    ['window_blur', 50],
    ['window_focus', 9_000],
    ['visibility_visible', 9_020],
  ],
  fullscreen_exit: [
    ['fullscreen_exit', 0],
    ['fullscreen_enter', 6_500],
  ],
  copy_paste: [
    ['copy', -4_000],
    ['paste', 0],
  ],
  inactivity: [
    ['inactivity', 0],
    ['activity_resumed', 12_000],
  ],
  refresh_attempt: [['refresh_attempt', 0]],
};

/** The browser events around an anomaly (type + timestamp only), as the extension packages them. */
export function demoEventSequence(type: ViolationType, ts: number): EventSequence {
  const p = DEFAULT_POLICY.capture;
  const events = (EVENTS[type] ?? []).map(([t, d]) => ({ type: t, ts: ts + d }));
  return { from: ts - p.eventsBeforeSeconds * 1000, to: ts + p.eventsAfterSeconds * 1000, events };
}

export interface SeededSession {
  id: string;
  candidateRef: string;
}

export async function seedDemoSessions(
  db: Db,
  storage: EvidenceStorage,
  organisationId: string,
  now: Date,
): Promise<SeededSession[]> {
  const seeded: SeededSession[] = [];
  for (const [index, demo] of DEMO_SESSIONS.entries()) {
    const startedAt = new Date(now.getTime() - (index + 1) * 2 * 60 * MIN);
    const endedAt = new Date(startedAt.getTime() + demo.minutes * MIN);
    const [session] = await db
      .insert(sessions)
      .values({
        organisationId,
        candidateRef: demo.candidateRef,
        tokenHash: hashToken(newToken('session')),
        tokenExpiresAt: endedAt,
        policySnapshot: DEFAULT_POLICY,
        status: 'ended',
        startedAt,
        endedAt,
      })
      .returning({ id: sessions.id });
    if (!session) throw new Error('demo session insert returned no row');

    for (const [n, a] of demo.anomalies.entries()) {
      const ts = startedAt.getTime() + Math.round(a.at * MIN);
      const evidence: EvidenceRef[] = [{ id: randomUUID(), kind: 'event_sequence', ts }];
      const bodies = new Map<string, { contentType: string; body: unknown }>();
      bodies.set(evidence[0]?.id ?? '', {
        contentType: 'application/json',
        body: demoEventSequence(a.type, ts),
      });
      if (categoryOf(a.type) === 'video') {
        for (let f = 0; f < 2; f++) {
          const ref: EvidenceRef = { id: randomUUID(), kind: 'frame', ts: ts + f * 1000 };
          evidence.push(ref);
          bodies.set(ref.id, { contentType: 'image/jpeg', body: demoFrame(a.type, n + f) });
        }
      }
      if (categoryOf(a.type) === 'audio') {
        const ref: EvidenceRef = { id: randomUUID(), kind: 'audio', ts };
        evidence.push(ref);
        bodies.set(ref.id, { contentType: 'audio/wav', body: demoClip(a.type) });
      }
      const anomaly: Anomaly = {
        id: randomUUID(),
        type: a.type,
        ts,
        confidence: a.confidence,
        evidence,
      };
      await ingestAnomaly(db, session.id, anomaly);
      for (const [evidenceId, { contentType, body }] of bodies) {
        await storeEvidence(db, storage, {
          sessionId: session.id,
          evidenceId,
          contentType,
          body,
          now,
        });
      }
    }
    seeded.push({ id: session.id, candidateRef: demo.candidateRef });
  }
  return seeded;
}
