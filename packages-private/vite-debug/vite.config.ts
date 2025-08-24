import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { entries } from '../../scripts/aliases.js'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: entries,
  },
  define: {
    __DEV__: true,
    __TEST__: false,
    __VERSION__: '"dev"',
    __BROWSER__: true,
    __GLOBAL__: false,
    __ESM_BUNDLER__: true,
    __ESM_BROWSER__: false,
    __CJS__: false,
    __SSR__: false,
    __FEATURE_OPTIONS_API__: true,
    __FEATURE_SUSPENSE__: true,
    __FEATURE_PROD_DEVTOOLS__: false,
    __FEATURE_PROD_HYDRATION_MISMATCH_DETAILS__: true,
    __COMPAT__: false,
  },
  server: {
    fs: {
      allow: [repoRoot],
    },
  },
  optimizeDeps: {
    exclude: [
      'vue',
      '@vue/shared',
      '@vue/reactivity',
      '@vue/runtime-core',
      '@vue/runtime-dom',
      '@vue/compiler-core',
      '@vue/compiler-dom',
      '@vue/compiler-sfc',
      '@vue/compiler-ssr',
      '@vue/server-renderer',
    ],
  },
})
