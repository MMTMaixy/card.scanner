import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Pokémon-Karten-Scanner',
        short_name: 'Karten-Scanner',
        description: 'Karten stapelweise scannen und als CSV für das Cardmarket-Bulk-Listing exportieren',
        lang: 'de',
        start_url: './',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#14161b',
        theme_color: '#1a1d24',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // App-Shell inkl. OCR-Assets vorab cachen -> komplett offline nutzbar
        globPatterns: ['**/*.{js,css,html,png,svg,wasm}', 'tesseract/**/*'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
      },
    }),
  ],
  // Relative Pfade, damit der Build auch aus einem Unterordner (z. B. GitHub Pages) läuft
  base: './',
});
