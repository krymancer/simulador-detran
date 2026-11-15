/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

// base relativa: funciona em https://<usuario>.github.io/<repo>/ sem configurar o nome do repo.
export default defineConfig({
  base: './',
  build: { chunkSizeWarningLimit: 6000 },
  // testes de física rodam muitos passos: no runner do GitHub levam bem mais de 5 s
  test: { testTimeout: 60000 },
});
