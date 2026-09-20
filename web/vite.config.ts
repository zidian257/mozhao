import { defineConfig } from 'vite';

// 构建标识：MMDD-HHmm（构建时刻本地时间），打在页面右下角极淡的小字上，
// 截图即可确认设备实际跑的包；v 前缀一眼可读
const now = new Date();
const pad = (n: number): string => String(n).padStart(2, '0');
const buildId = `v${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;

export default defineConfig({
  define: {
    __BUILD_ID__: JSON.stringify(buildId),
  },
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
