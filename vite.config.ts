import { defineConfig } from 'vite';
import { resolve } from 'path';
import { copyFileSync, mkdirSync, existsSync } from 'fs';
import { execSync } from 'child_process';

// Plugin to copy static files and build the content script as IIFE
function extensionPlugin() {
  return {
    name: 'chrome-extension',
    closeBundle() {
      const distDir = resolve(__dirname, 'dist');

      // Copy manifest.json
      copyFileSync(
        resolve(__dirname, 'manifest.json'),
        resolve(distDir, 'manifest.json')
      );

      // Copy icons
      const iconsDir = resolve(distDir, 'icons');
      if (!existsSync(iconsDir)) mkdirSync(iconsDir, { recursive: true });
      for (const size of [16, 48, 128]) {
        const src = resolve(__dirname, `icons/icon-${size}.png`);
        if (existsSync(src)) {
          copyFileSync(src, resolve(iconsDir, `icon-${size}.png`));
        }
      }

      // Build content script as IIFE (self-contained, no imports)
      try {
        execSync(
          `npx vite build --config vite.content.config.ts`,
          { cwd: __dirname, stdio: 'inherit' }
        );
      } catch (err) {
        console.error('Content script build failed:', err);
      }

      // Create extension zip file
      try {
        // Run zip command on Mac to zip the dist directory contents excluding src/guide/
        execSync(`zip -r lycoris-extension.zip manifest.json icons src assets -x "src/guide/*"`, {
          cwd: distDir,
          stdio: 'inherit'
        });
        console.log('Successfully created lycoris-extension.zip inside dist');
      } catch (err) {
        console.error('Failed to create extension zip:', err);
      }
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [extensionPlugin()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    modulePreload: false,
    sourcemap: mode === 'development' ? 'inline' : false,
    minify: mode === 'production',
    rollupOptions: {
      input: {
        'service-worker': resolve(__dirname, 'src/background/service-worker.ts'),
        'popup': resolve(__dirname, 'src/popup/popup.html'),
        'options': resolve(__dirname, 'src/options/options.html'),
        'offscreen': resolve(__dirname, 'src/offscreen/offscreen.html'),
        'guide': resolve(__dirname, 'src/guide/guide.html'),
      },
      output: {
        entryFileNames: (chunkInfo) => {
          const nameMap: Record<string, string> = {
            'service-worker': 'src/background/service-worker.js',
            'popup': 'src/popup/popup.js',
            'options': 'src/options/options.js',
            'offscreen': 'src/offscreen/offscreen.js',
            'guide': 'src/guide/guide.js',
          };
          return nameMap[chunkInfo.name] || 'assets/[name]-[hash].js';
        },
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: (assetInfo) => {
          if (assetInfo.name?.endsWith('.css')) {
            return 'assets/[name][extname]';
          }
          return 'assets/[name]-[hash][extname]';
        },
      },
    },
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@storage': resolve(__dirname, 'src/storage'),
      '@queue': resolve(__dirname, 'src/queue'),
      '@content': resolve(__dirname, 'src/content'),
      '@background': resolve(__dirname, 'src/background'),
      '@processing': resolve(__dirname, 'src/processing'),
      '@downloads': resolve(__dirname, 'src/downloads'),
      '@popup': resolve(__dirname, 'src/popup'),
      '@options': resolve(__dirname, 'src/options'),
      '@offscreen': resolve(__dirname, 'src/offscreen'),
    },
  },
}));
