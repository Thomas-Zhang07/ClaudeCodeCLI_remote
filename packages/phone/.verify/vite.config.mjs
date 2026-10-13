import { fileURLToPath, URL } from 'node:url';

import vue from '@vitejs/plugin-vue';

export default {
  root: fileURLToPath(new URL('..', import.meta.url)),
  plugins: [vue()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) },
  },
  build: {
    ssr: '.verify/entry.ts',
    outDir: '.verify/dist',
    emptyOutDir: true,
    minify: false,
    rollupOptions: { output: { entryFileNames: 'entry.mjs' } },
  },
};
