import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  // Netlify sert le site à la racine ; GitHub Pages le sert sous
  // /<nom-du-depot>/. On laisse donc le chemin de base se régler par variable
  // d'environnement plutôt que de le figer.
  base: process.env.VITE_BASE ?? '/',
  plugins: [react(), tailwindcss()],
  server: {
    // `netlify dev` sert les fonctions sur 8888 ; en `vite dev` seul, on proxifie
    // /api vers ce port pour que le front parle à la même URL dans les deux cas.
    proxy: {
      '/api': {
        target: process.env.FUNCTIONS_ORIGIN || 'http://localhost:8888',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    // Le moteur de lecture (ONNX Runtime + ppu-paddle-ocr) part dans le chunk
    // du worker, hors du chemin critique du premier rendu.
    chunkSizeWarningLimit: 1200,
  },
});
