import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

const externals = [
  'sharp',
  'fs', 'path', 'os', 'stream', 'events', 'util', 'child_process', 'crypto',
  'node:fs', 'node:path', 'node:os', 'node:stream', 'node:events', 'node:util', 'node:child_process', 'node:crypto',
];

export default defineConfig({
  plugins: [
    dts({
      outDir: 'dist',
      insertTypesEntry: true,
      entryRoot: 'src',
      cleanVueFileName: true,
    }),
  ],
  build: {
    lib: {
      entry: 'src/index.ts',
      name: 'VitePluginSingleImageFormat',
      formats: ['es', 'cjs'],
      fileName: (format) => `index.${format}.js`,
    },
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      external: externals,
      output: {
        assetFileNames: 'index.[ext]',
      },
    },
  },
});
