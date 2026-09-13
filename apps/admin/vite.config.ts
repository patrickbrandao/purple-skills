import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Em dev o Vite encaminha a API para o servidor do painel. `ADMIN_API_PORT`
// permite rodar um segundo painel ao lado do do compose (que ocupa a 3001).
const api = `http://localhost:${process.env.ADMIN_API_PORT ?? '3001'}`;

export default defineConfig({
  root: 'web',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../dist-web',
    emptyOutDir: true,
  },
  server: {
    port: Number(process.env.ADMIN_WEB_PORT ?? 5174),
    proxy: {
      '/api': api,
      '/healthz': api,
    },
  },
});
