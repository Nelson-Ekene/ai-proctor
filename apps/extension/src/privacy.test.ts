/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest';
import { InternalRequestSchema } from './messages';

// Privacy guards on the extension source (docs/PRIVACY_REVIEW.md). CLAUDE.md: face templates
// only for opt-in face matching and never off the device's memory, no screen or content
// capture, no full recordings.

const sources = Object.entries(
  import.meta.glob<string>(['./**/*.ts', '!./**/*.test.ts'], {
    query: '?raw',
    import: 'default',
    eager: true,
  }),
);

/** Source without comments, so the rules below apply to code, not to explanations. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const inFiles = (path: string, files: readonly string[]) => files.some((f) => path.endsWith(f));

/**
 * The only code that may touch face embeddings (Phase 11 optional face matching). The
 * diagnostics page is development-only; the release check refuses packages that contain it.
 */
const FACE_MATCH_FILES = [
  'shared/face-embedder.ts',
  'offscreen/offscreen.ts',
  'offscreen/sampler.ts',
  'pages/diagnostics.ts',
] as const;

describe('face templates stay in memory on the device (opt-in face matching only)', () => {
  it('confines embedding code to the embedder, the offscreen document and the sampler', () => {
    for (const [path, text] of sources) {
      if (inFiles(path, FACE_MATCH_FILES)) continue;
      expect(code(text), path).not.toMatch(/Embedder|embedding|embed\(|faceprint|recogni[sz]/i);
    }
  });

  it('loads the face embedding model in one place only', () => {
    for (const [path, text] of sources) {
      if (path.endsWith('shared/face-embedder.ts')) continue;
      expect(code(text), path).not.toMatch(/face_recognition_sface/);
    }
  });

  it('never stores or sends anything from the code that sees embeddings', () => {
    for (const [path, text] of sources) {
      if (!path.endsWith('shared/face-embedder.ts') && !path.endsWith('offscreen/sampler.ts')) {
        continue;
      }
      expect(code(text), path).not.toMatch(
        /indexedDB|chrome\.storage|localStorage|fetch\(|XMLHttpRequest|sendMessage|send\(/,
      );
    }
  });

  it('has no message that can carry an embedding to the service worker', () => {
    const anomaly = { type: 'face_mismatch', ts: 1, confidence: 0.9 };
    for (const request of [
      { type: 'video:anomalies', anomalies: [{ ...anomaly, embedding: [0.1, 0.2] }] },
      { type: 'video:meta', meta: { degraded: false, framesPerWindow: 5, embedding: [0.1] } },
    ]) {
      expect(InternalRequestSchema.safeParse(request).success).toBe(false);
    }
    expect(
      InternalRequestSchema.safeParse({ type: 'video:anomalies', anomalies: [anomaly] }).success,
    ).toBe(true);
  });

  it('keeps detector keypoints within the vision wrapper and the offscreen document', () => {
    for (const [path, text] of sources) {
      if (
        inFiles(path, ['shared/vision-models.ts', 'offscreen/offscreen.ts', 'pages/diagnostics.ts'])
      ) {
        continue;
      }
      expect(code(text), path).not.toMatch(/faceKeypoints|keypoints/);
    }
  });

  it('keeps no facial landmarks or blendshapes: only head pose leaves the model wrapper', () => {
    const wrapper = sources.find(([p]) => p.endsWith('shared/vision-models.ts'))?.[1] ?? '';
    expect(wrapper).toContain('facialTransformationMatrixes');
    expect(code(wrapper)).not.toMatch(
      /\.faceLandmarks|faceBlendshapes|outputFaceBlendshapes: true/,
    );
    for (const [path, text] of sources) {
      if (path.endsWith('shared/vision-models.ts')) continue;
      expect(code(text), path).not.toMatch(/faceLandmarks|facialTransformationMatrixes/);
    }
  });
});

describe('no screen or content capture, no continuous recording', () => {
  it('never captures the screen or tabs', () => {
    for (const [path, text] of sources) {
      expect(code(text), path).not.toMatch(
        /getDisplayMedia|tabCapture|desktopCapture|captureVisibleTab/,
      );
    }
  });

  it('the content script (the only code inside the exam page) never reads page content', () => {
    const content = sources.filter(([p]) => p.startsWith('./content/'));
    expect(content.length).toBeGreaterThan(0);
    for (const [path, text] of content) {
      const c = code(text);
      expect(c, path).not.toMatch(
        /innerText|innerHTML|outerHTML|\.value\b|getSelection|clipboardData|location\.href|document\.URL|document\.title/,
      );
      // Writing its own indicator text is fine; reading page text is not.
      expect(c, path).not.toMatch(/\.textContent(?!\s*=)/);
    }
  });

  it('never records continuous media (MediaRecorder)', () => {
    for (const [path, text] of sources) expect(code(text), path).not.toMatch(/MediaRecorder/);
  });
});
