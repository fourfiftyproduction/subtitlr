import { defineConfig } from 'vite';

export default defineConfig({
  base: './', // works on GitHub Pages under /subtitlr/ and at any root
  build: { target: 'es2022' },
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
});
