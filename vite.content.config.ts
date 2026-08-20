import { defineConfig } from 'vite';
import { resolve } from 'path';

/**
 * Separate Vite build config for the content script.
 * 
 * Content scripts declared in manifest.json cannot use ES module imports
 * in Chrome MV3. This config builds the content script as a self-contained
 * IIFE bundle with all dependencies inlined.
 */
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false, // Don't wipe the main build output
    sourcemap: false,
    minify: true,
    lib: {
      entry: resolve(__dirname, 'src/content/content-main.ts'),
      name: 'ImageQueueContent',
      formats: ['iife'],
      fileName: () => 'src/content/content-main.js',
    },
    rollupOptions: {
      output: {
        // Ensure it goes to the right location
        dir: resolve(__dirname, 'dist'),
      },
    },
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@storage': resolve(__dirname, 'src/storage'),
      '@queue': resolve(__dirname, 'src/queue'),
      '@content': resolve(__dirname, 'src/content'),
    },
  },
});
