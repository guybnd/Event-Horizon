import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      // Honor the `_`-prefix convention already used in this codebase (e.g. `_ticketId`,
      // `_branch`) for intentionally-unused args/vars/caught-errors. typescript-eslint's
      // default leaves these patterns unset, so the prefix was being flagged anyway.
      // Best-effort `try { ... } catch {}` (swallow-and-continue) is a deliberate,
      // pervasive pattern here (optional JSON parsing, fire-and-forget cleanup). Allow
      // the empty catch specifically; all other empty blocks remain flagged.
      'no-empty': ['error', { allowEmptyCatch: true }],
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      // React Compiler lint rules (shipped on-by-default in eslint-plugin-react-hooks v7's
      // `recommended` set). This project does NOT use the React Compiler, and these rules
      // flag deliberate, behavior-critical patterns rather than bugs:
      //   - set-state-in-effect: legitimate reset-on-dep-change / async-init effects.
      //   - refs / immutability / purity: intentional render-time ref reads (e.g. the
      //     documented false-dirty guard in useTaskForm) and forward-referenced values.
      //   - preserve-manual-memoization: hand-written useMemo/useCallback deps the compiler
      //     can't prove, which only matters when the compiler is actually running.
      //   - static-components: flags ANY locally-bound value returned from a function call
      //     and rendered as a JSX tag (e.g. `const Icon = resolveFeatureIcon(name); <Icon/>`),
      //     regardless of whether that function is pure/stable. `resolveFeatureIcon`
      //     (config/featureIcons.ts) always returns the SAME cached component reference for
      //     a given name (a lookup into lucide-react's static `icons` record), so there is no
      //     real "component created during render" here — restructuring around this false
      //     positive (e.g. via React.createElement to dodge the JSX-tag AST shape) would just
      //     obscure the same pattern, not fix a bug.
      // "Fixing" them would mean behavior-changing refactors, which is out of scope for a
      // lint burndown (FLUX-583). Re-enable if/when the React Compiler is adopted.
      // The classic, high-value hooks rules (rules-of-hooks, exhaustive-deps) stay on.
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/immutability': 'off',
      'react-hooks/purity': 'off',
      'react-hooks/preserve-manual-memoization': 'off',
      'react-hooks/static-components': 'off',
    },
  },
])
