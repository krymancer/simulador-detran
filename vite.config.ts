import { defineConfig } from 'vite';

// base relativa: funciona em https://<usuario>.github.io/<repo>/ sem configurar o nome do repo.
export default defineConfig({
  base: './',
  build: { chunkSizeWarningLimit: 6000 },
});
