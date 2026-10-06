import { defineManifest } from '@crxjs/vite-plugin';
import { parseExtensionConfig } from './src/config.ts';
import { buildManifest } from './src/manifest.ts';

// Origins come from PROCTOR_EXAM_ORIGINS / PROCTOR_API_ORIGINS at build time (see README).
export default defineManifest((env) => buildManifest(parseExtensionConfig(process.env), env.mode));
