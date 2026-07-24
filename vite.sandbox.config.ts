import { defineConfig } from 'vite'
import { fileURLToPath, URL } from 'node:url'

/**
 * Separate build for the Layer 2 sandbox script.
 *
 * MV3 sandboxed pages run on an opaque origin where ES module scripts fail to
 * load (module fetch is CORS-checked against the opaque origin). So the sandbox
 * must use a CLASSIC, self-contained IIFE script.
 *
 * This build runs AFTER the main @crxjs build and writes sandbox.js straight
 * into dist/public/sandbox/, next to the (already-copied) index.html. We can't
 * ship it via public/ because @crxjs treats the manifest-referenced sandbox
 * HTML as a build input and won't copy a sibling .js. publicDir:false stops
 * Vite from copying public/ into this outDir; emptyOutDir:false preserves the
 * main build output.
 */
export default defineConfig({
  publicDir: false,
  resolve: {
    alias: {
      '@core': fileURLToPath(new URL('./src/core', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist/public/sandbox',
    emptyOutDir: false,
    target: 'es2020',
    lib: {
      entry: fileURLToPath(new URL('./src/sandbox/main.ts', import.meta.url)),
      formats: ['iife'],
      name: 'snJavaSandbox',
      fileName: () => 'sandbox.js',
    },
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
})
