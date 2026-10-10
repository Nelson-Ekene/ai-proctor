import { encodeWav } from '@proctor/core';
import { createHash } from 'node:crypto';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Microphone fixtures for Phase 5 e2e tests, played through Chrome's fake microphone
// (--use-file-for-fake-audio-capture, looped). Downloaded/generated at test time, never committed.

export const AUDIO_FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '.cache', 'audio');

const SPEECH = {
  // One English speaker, 60 s, 16 kHz mono 16-bit PCM: Silero VAD's own example file.
  url: 'https://models.silero.ai/vad_models/en.wav',
  sha256: '89f17d9c94c4b31eb320f424628bcbc920abaddbee6e2760fd868bfb1d9a2e47',
  credit: 'Silero VAD example audio (github.com/snakers4/silero-vad, MIT)',
};

export type AudioFixtureName = 'speech' | 'silence';

export function audioFixturePath(name: AudioFixtureName): string {
  return join(AUDIO_FIXTURE_DIR, `${name}.wav`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function prepareAudioFixtures(): Promise<void> {
  await mkdir(AUDIO_FIXTURE_DIR, { recursive: true });

  if (!(await exists(audioFixturePath('speech')))) {
    const res = await fetch(SPEECH.url);
    if (!res.ok) throw new Error(`fixture download failed (${String(res.status)}): ${SPEECH.url}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const sha = createHash('sha256').update(bytes).digest('hex');
    if (sha !== SPEECH.sha256)
      throw new Error(`fixture checksum mismatch for ${SPEECH.url}: ${sha}`);
    await writeFile(audioFixturePath('speech'), bytes);
  }

  if (!(await exists(audioFixturePath('silence')))) {
    // 10 s of digital silence at 16 kHz, encoded with the same WAV writer the extension uses.
    await writeFile(audioFixturePath('silence'), encodeWav(new Float32Array(10 * 16_000), 16_000));
  }
}
