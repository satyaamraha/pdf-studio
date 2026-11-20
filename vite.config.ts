import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// https://v2.tauri.app/start/frontend/vite/
const host = process.env.TAURI_DEV_HOST;
const isTauriBuild = !!process.env.TAURI_ENV_PLATFORM;

export default defineConfig({
  // Set VITE_BASE when hosting under a sub-path, e.g. /pdf-studio/ on GitHub Pages.
  base: process.env.VITE_BASE || '/',
  plugins: [
    react(),
    VitePWA({
      // The desktop app doesn't need (or want) a service worker.
      disable: isTauriBuild,
      // Registered from src/pwa.ts so updates can wait for unsaved work.
      injectRegister: false,
      registerType: 'prompt',
      includeAssets: ['icon.svg', 'icons/apple-touch-icon.png'],
      manifest: {
        id: '/',
        name: 'PDF Studio',
        short_name: 'PDF Studio',
        description: 'Read, annotate and organize PDFs. Works offline; your files never leave your device.',
        start_url: '.',
        scope: '.',
        display: 'standalone',
        display_override: ['window-controls-overlay', 'standalone'],
        background_color: '#f3f3f5',
        theme_color: '#3355e0',
        categories: ['productivity', 'utilities'],
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        // Installed on Chrome/Edge, PDF Studio can be chosen to open PDFs from the OS.
        file_handlers: [{ action: '.', accept: { 'application/pdf': ['.pdf'] } }],
        launch_handler: { client_mode: 'focus-existing' },
      },
      workbox: {
        // Everything the app needs to work offline is downloaded on first visit, including
        // the PDF.js fonts used for PDFs that don't embed their own.
        globPatterns: ['**/*.{js,mjs,css,html,svg,png,ico,webmanifest,pfb,ttf}'],
        // Character maps (168 small files) are only needed for Chinese, Japanese and Korean
        // PDFs, so they are fetched when such a PDF is opened and kept from then on.
        globIgnores: ['samples/**', 'pdfjs/cmaps/**'],
        runtimeCaching: [
          {
            // The editing engine (4 MB) is kept after its first use rather than downloaded on install.
            urlPattern: ({ url }) => url.pathname.endsWith('.wasm'),
            handler: 'CacheFirst',
            options: { cacheName: 'pdf-engine', expiration: { maxEntries: 4 } },
          },
          {
            urlPattern: ({ url }) => url.pathname.includes('/pdfjs/cmaps/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'pdfjs-cmaps',
              expiration: { maxEntries: 200 },
            },
          },
        ],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    target: ['es2022', 'chrome111', 'safari16'],
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
