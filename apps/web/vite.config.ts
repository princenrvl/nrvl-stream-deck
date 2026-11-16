import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// `npm run dev` serves the UI on http://localhost:5173 and proxies to a locally running hub,
// so the interface can be developed and tested in a desktop browser without an iPad.
const hub = { target: `https://localhost:${process.env.NRVL_PORT ?? 8443}`, secure: false, changeOrigin: true }; // same NRVL_PORT as the hub
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': hub, '/ws': { ...hub, ws: true } } },
});
