import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      // 契约默认 8787；本地端口被占用时可用 OBS_API_TARGET 指到 mock
      '/api': process.env.OBS_API_TARGET ?? 'http://localhost:8787',
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
  },
});
