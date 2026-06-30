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
      // FLUX-351: the engine can run as a stdio MCP server, where the JSON-RPC framing
      // is written to STDOUT by the SDK transport. ANY stray stdout write corrupts that
      // framing, so `console.log` (which goes to stdout) is banned in engine source.
      // Route diagnostics through the stderr-only `log` helper (`engine/src/log.ts`).
      // `console.warn`/`console.error` already go to stderr and are allowed; the
      // deliberate transport stdout writes live in the SDK, not in engine source.
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
