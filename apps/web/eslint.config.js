// ESLint flat config — strict mode for TS + Svelte.
//
// Rules enforce the project hard rules:
//   - no console.* outside the shared logger (the structured logger is the
//     only sanctioned emission point; semgrep rules layer the project-
//     specific bans).
//
import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import sveltePlugin from 'eslint-plugin-svelte';
import svelteParser from 'svelte-eslint-parser';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        project: false
      },
      globals: {
        ...globals.browser,
        ...globals.node
      }
    },
    plugins: {
      '@typescript-eslint': tsPlugin
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      'no-console': ['error', { allow: ['warn', 'error'] }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ],
      // (T16 / G-T11-9 mirror is scoped below to non-retention production
      //  source so files within the retention library can deep-import from
      //  their sibling modules.)
    }
  },
  {
    files: ['**/*.svelte'],
    languageOptions: {
      parser: svelteParser,
      parserOptions: {
        parser: tsParser,
        extraFileExtensions: ['.svelte']
      },
      globals: { ...globals.browser }
    },
    plugins: { svelte: sveltePlugin },
    rules: {
      ...(sveltePlugin.configs?.recommended?.rules ?? {})
    }
  },
  {
    // Tests use frozen-clock + test sinks; relax certain rules.
    files: ['test/**/*.ts', '**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off'
    }
  },
  {
    // The logger module IS the sanctioned console.* boundary.
    files: ['src/lib/log/**/*.ts', 'src/lib/observability/**/*.ts'],
    rules: {
      'no-console': 'off'
    }
  },
  {
    // T16 / G-T11-9 mirror — production code (outside the retention library
    // itself) must NEVER deep-import the retention test-only override hooks.
    // Tests reach these via deep-import; production consumes only the public
    // barrel `lib/retention`.
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    ignores: ['src/lib/retention/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/lib/retention/memory-retention-store',
                '**/lib/retention/schedule',
                '**/lib/retention/retention-core',
                '**/lib/retention/retention-store',
                '**/lib/retention/types',
                '**/retention/memory-retention-store',
                '**/retention/schedule',
                '**/retention/retention-core',
                '**/retention/retention-store',
                '**/retention/types',
                '$lib/retention/memory-retention-store',
                '$lib/retention/schedule',
                '$lib/retention/retention-core',
                '$lib/retention/retention-store',
                '$lib/retention/types'
              ],
              message:
                'Use the public retention barrel `lib/retention`. Deep-import surfaces (MemoryRetentionStore, __setScheduleOverrideForTest, __debug*) are test-only.'
            }
          ]
        }
      ]
    }
  },
  {
    ignores: [
      'node_modules/',
      '.svelte-kit/',
      'build/',
      'dist/',
      'coverage/',
      '.vite/',
      '**/*.min.js',
      // Test files are owned by the test-writer and are read-only for
      // implementer + scaffolder per .context/test-plan.md hard rules.
      // Lint warnings on test internals (unused imports planted for
      // future tests) cannot be auto-corrected without modifying tests.
      // The Vitest run is the test-side correctness gate; ESLint runs
      // over scaffold + implementation source only.
      'test/**'
    ]
  }
];
