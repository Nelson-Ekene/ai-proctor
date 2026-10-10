import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The dashboard calls the API on the same origin (`/v1/...`). In development Vite proxies those
// calls to the API (PROCTOR_API_URL, default http://localhost:4000), so no CORS is needed.
const api = process.env.PROCTOR_API_URL ?? 'http://localhost:4000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173, proxy: { '/v1': { target: api, changeOrigin: true } } },
  preview: { proxy: { '/v1': { target: api, changeOrigin: true } } },
});
