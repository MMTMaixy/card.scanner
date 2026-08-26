import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Relative Pfade, damit der Build auch aus einem Unterordner (z. B. GitHub Pages) läuft
  base: './',
});
