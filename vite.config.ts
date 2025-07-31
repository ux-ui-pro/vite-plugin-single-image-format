import { defineConfig } from 'vite';
import terser from '@rollup/plugin-terser';
import dts from 'vite-plugin-dts';

const externals = [
  'sharp',
  'fs', 'path', 'os', 'stream', 'events', 'util', 'child_process', 'crypto',
  'node:fs', 'node:path', 'node:os', 'node:stream', 'node:events',
  'node:util', 'node:child_process', 'node:crypto',
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
    rollupOptions: {
      external: externals,
      plugins: [
        terser({
          compress: {
            drop_console: true,
            drop_debugger: true,
            dead_code: true,
            reduce_vars: true,
            reduce_funcs: true,
          },
          mangle: {
            toplevel: true,
            keep_fnames: false,
          },
          format: {
            comments: false,
          },
        }),
      ],
      output: {
        assetFileNames: 'index.[ext]',
      },
    },
  },
});
