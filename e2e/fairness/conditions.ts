import type { Page } from '@playwright/test';

// Capture conditions for the fairness harnesses (fairness.spec.ts, face-match.spec.ts): image
// transforms applied in the page that approximate lighting, camera quality and movement.

export interface Condition {
  id: string;
  label: string;
  group: 'reference' | 'lighting' | 'camera quality' | 'movement';
  /** Canvas filter and drawing parameters applied in the page. */
  filter?: string;
  downscale?: number;
  jpegQuality?: number;
  noise?: number;
  rotate?: number;
  motionBlur?: number;
}

export const CONDITIONS: Condition[] = [
  { id: 'original', label: 'Original', group: 'reference' },
  { id: 'dim', label: 'Dim room (35% brightness)', group: 'lighting', filter: 'brightness(0.35)' },
  {
    id: 'very-dim',
    label: 'Very dim (20% brightness)',
    group: 'lighting',
    filter: 'brightness(0.2)',
  },
  { id: 'bright', label: 'Overexposed (180%)', group: 'lighting', filter: 'brightness(1.8)' },
  {
    id: 'backlit',
    label: 'Backlit / low contrast',
    group: 'lighting',
    filter: 'contrast(0.45) brightness(1.25)',
  },
  { id: 'warm', label: 'Warm light (sepia 60%)', group: 'lighting', filter: 'sepia(0.6)' },
  {
    id: 'low-res',
    label: 'Low-resolution camera (160×120)',
    group: 'camera quality',
    downscale: 4,
  },
  {
    id: 'jpeg',
    label: 'Heavy compression (JPEG q=0.1)',
    group: 'camera quality',
    jpegQuality: 0.1,
  },
  { id: 'noise', label: 'Sensor noise (σ≈25)', group: 'camera quality', noise: 25 },
  { id: 'blur', label: 'Out of focus (blur 3 px)', group: 'camera quality', filter: 'blur(3px)' },
  { id: 'motion', label: 'Motion blur (12 px)', group: 'movement', motionBlur: 12 },
  { id: 'tilt-left', label: 'Head/camera tilt −20°', group: 'movement', rotate: -20 },
  { id: 'tilt-right', label: 'Head/camera tilt +20°', group: 'movement', rotate: 20 },
];

export async function transform(page: Page, jpegBase64: string, c: Condition): Promise<string> {
  return page.evaluate(
    async ({ b64, c }) => {
      const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
      const src = await createImageBitmap(new Blob([bytes]));
      const W = src.width;
      const H = src.height;
      const canvas = new OffscreenCanvas(W, H);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('no 2d context');
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
      if (c.filter) ctx.filter = c.filter;
      if (c.rotate) {
        ctx.translate(W / 2, H / 2);
        ctx.rotate((c.rotate * Math.PI) / 180);
        ctx.translate(-W / 2, -H / 2);
      }
      if (c.motionBlur) {
        const steps = 8;
        ctx.globalAlpha = 1 / steps;
        for (let i = 0; i < steps; i++)
          ctx.drawImage(src, (i / (steps - 1) - 0.5) * c.motionBlur, 0);
        ctx.globalAlpha = 1;
      } else if (c.downscale) {
        const small = new OffscreenCanvas(W / c.downscale, H / c.downscale);
        small.getContext('2d')?.drawImage(src, 0, 0, small.width, small.height);
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(small, 0, 0, W, H);
      } else {
        ctx.drawImage(src, 0, 0);
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.filter = 'none';
      if (c.noise) {
        const img = ctx.getImageData(0, 0, W, H);
        let seed = 42;
        const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
        for (let i = 0; i < img.data.length; i += 4) {
          // Approximately normal noise from the sum of uniforms, deterministic.
          const n = (rand() + rand() + rand() - 1.5) * 2 * (c.noise ?? 0);
          img.data[i] = Math.min(255, Math.max(0, (img.data[i] ?? 0) + n));
          img.data[i + 1] = Math.min(255, Math.max(0, (img.data[i + 1] ?? 0) + n));
          img.data[i + 2] = Math.min(255, Math.max(0, (img.data[i + 2] ?? 0) + n));
        }
        ctx.putImageData(img, 0, 0);
      }
      const blob = await canvas.convertToBlob({
        type: 'image/jpeg',
        quality: c.jpegQuality ?? 0.92,
      });
      const out = new Uint8Array(await blob.arrayBuffer());
      let s = '';
      for (const b of out) s += String.fromCharCode(b);
      return `data:image/jpeg;base64,${btoa(s)}`;
    },
    { b64: jpegBase64, c },
  );
}
