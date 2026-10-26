import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

// The shared contract is plain TS/ESM; bundle it into main and preload so the
// sandboxed preload never has to require() it at runtime.
const bundleShared = { exclude: ['@rockzalct/shared', '@rockzalct/device', '@rockzalct/simulator'] };

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(bundleShared)],
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } } },
  },
  preload: {
    plugins: [externalizeDepsPlugin(bundleShared)],
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } } },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } } },
  },
});
