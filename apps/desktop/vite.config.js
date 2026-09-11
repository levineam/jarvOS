import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: 'chat-src',
  base: '/chat/',
  build: {
    outDir: '../static/chat',
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: {
      input: 'main.tsx',
      output: {
        entryFileNames: 'chat.js',
        chunkFileNames: '[name].js',
        assetFileNames: (assetInfo) => assetInfo.name === 'style.css' ? 'style.css' : '[name][extname]',
      },
    },
  },
});
