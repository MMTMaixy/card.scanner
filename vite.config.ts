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
        // Vorab (bei der Installation) nur die App-Shell und die
        // Sprachdaten — zusammen wenige MB.
        // assets/*.js bewusst als Ganzes: Ein Muster auf einen konkreten
        // Bundle-Namen bricht still, sobald der Einstiegspunkt umbenannt wird
        // — dann fehlt das Haupt-Bundle offline. Die großen Rechenkerne
        // liegen nicht unter assets/, sondern in opencv/ bzw. tesseract/.
        globPatterns: ['**/*.{css,html,png,svg}', 'assets/*.js', 'tesseract/*.traineddata.gz'],
        globIgnores: ['**/node_modules/**/*', 'sw.js', 'workbox-*.js', 'selftest.html'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        runtimeCaching: [
          {
            // Die großen Rechenkerne: OpenCV (~15 MB) und die
            // Tesseract-WASM-Cores (3 Varianten à ~4 MB, wovon das Gerät nur
            // EINE lädt). Beim ersten Kamerastart holen und dann dauerhaft
            // behalten — statt bei der Installation alle Varianten zu ziehen.
            urlPattern: ({ url }: { url: URL }) =>
              /\/opencv\/opencv\.js$/.test(url.pathname) ||
              /\/tesseract\/(tesseract-core|worker).*\.js$/.test(url.pathname),
            handler: 'CacheFirst',
            options: {
              cacheName: 'rechenkerne',
              expiration: { maxEntries: 8, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
              rangeRequests: true,
            },
          },
        ],
      },
    }),
  ],
  // Relative Pfade, damit der Build auch aus einem Unterordner (z. B. GitHub Pages) läuft
  base: './',
  build: {
    rollupOptions: {
      // selftest.html wird mitgebaut, damit die Vision-Pipeline gegen den
      // ECHTEN Produktions-Build geprüft werden kann (und bei Bedarf direkt
      // auf dem Tablet). Sie ist nirgends verlinkt.
      input: {
        main: 'index.html',
        selftest: 'selftest.html',
      },
    },
  },
});
