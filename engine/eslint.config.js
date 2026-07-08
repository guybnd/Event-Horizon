import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', 'node_modules']),
  {
    files: ['src/**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      // FLUX-351: `console.log` (which goes to stdout) is banned in engine source — route
      // diagnostics through the stderr-only `log` helper (`engine/src/log.ts`) instead.
      // `console.warn`/`console.error` already go to stderr and are allowed.
      'no-console': ['error', { allow: ['warn', 'error'] }],
      // Match the `_`-prefix unused convention used across the codebase (see portal config).
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
])
