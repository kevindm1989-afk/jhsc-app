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
      ]
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
    // T17 / ADR-0018 mirror — production code (outside the backup library
    // itself) must NEVER deep-import the backup test-only override hooks.
    // Tests reach these via deep-import; production consumes only the public
    // barrel `lib/backup`. All three path shapes covered from the start
    // (Finding 1 lesson from T16 reviewer pass).
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    ignores: ['src/lib/backup/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/lib/backup/memory-backup-store',
                '**/lib/backup/backup-tables',
                '**/lib/backup/backup-core',
                '**/lib/backup/backup-store',
                '**/lib/backup/types',
                '**/backup/memory-backup-store',
                '**/backup/backup-tables',
                '**/backup/backup-core',
                '**/backup/backup-store',
                '**/backup/types',
                '$lib/backup/memory-backup-store',
                '$lib/backup/backup-tables',
                '$lib/backup/backup-core',
                '$lib/backup/backup-store',
                '$lib/backup/types'
              ],
              message:
                'Use the public backup barrel `lib/backup`. Deep-import surfaces (MemoryBackupStore, __forceUploadFailure, __debug*) are test-only.'
            }
          ]
        }
      ]
    }
  },
  {
    // T18 / ADR-0019 mirror — production code (outside the audit-integrity
    // library itself) must NEVER deep-import the integrity test-only override
    // hooks. Tests reach these via deep-import; production consumes only the
    // public barrel `lib/audit-integrity`. All three path shapes covered from
    // the start (Finding 1 lesson from T16 reviewer pass; Option J pattern).
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    ignores: ['src/lib/audit-integrity/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/lib/audit-integrity/memory-integrity-store',
                '**/lib/audit-integrity/integrity-event-types',
                '**/lib/audit-integrity/integrity-core',
                '**/lib/audit-integrity/integrity-store',
                '**/lib/audit-integrity/types',
                '**/audit-integrity/memory-integrity-store',
                '**/audit-integrity/integrity-event-types',
                '**/audit-integrity/integrity-core',
                '**/audit-integrity/integrity-store',
                '**/audit-integrity/types',
                '$lib/audit-integrity/memory-integrity-store',
                '$lib/audit-integrity/integrity-event-types',
                '$lib/audit-integrity/integrity-core',
                '$lib/audit-integrity/integrity-store',
                '$lib/audit-integrity/types'
              ],
              message:
                'Use the public audit-integrity barrel `lib/audit-integrity`. Deep-import surfaces (MemoryIntegrityStore, runIntegrityEventTypesDriftCheck, __debug*) are test-only.'
            }
          ]
        }
      ]
    }
  },
  {
    // G-T17-7 / ADR-0018 §13 — retention library MUST NOT depend on the
    // backup library. The retention sweep and the backup pass are
    // independent passes (Option G binding in ADR-0018); the architectural
    // seal is structural (verified by code review today) and
    // ESLint-enforced from this PR onward. A retention->backup import is
    // a re-architecture event, not a refactor; the ban fail-closes it
    // until a deliberate amendment to ADR-0017/0018 lands.
    files: ['src/lib/retention/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/lib/backup/**',
                '**/backup/**',
                '$lib/backup/**',
                '../backup/**',
                '../../backup/**',
                './backup/**'
              ],
              message:
                'G-T17-7 / ADR-0018 §13: retention library MUST NOT import the backup library. The two passes are independent (Option G). A retention->backup dependency re-couples them; if you genuinely need this, propose an architect amendment first.'
            }
          ]
        }
      ]
    }
  },
  {
    // G-T17-8 / ADR-0018 §task #8 — `BACKUP_TABLES` is a closed allowlist
    // by construction (F-70 / SECURITY DEFINER + closed-set invariant).
    // Spreading it into another array (`[...BACKUP_TABLES, ...]`)
    // creates a derived mutable list that defeats the closed-set
    // guarantee — a regression could silently widen the dump scope. The
    // belt-and-braces ban catches that pattern at lint time; the
    // Object.freeze(BACKUP_TABLES) at the declaration site is the
    // runtime backstop. The backup-tables.ts source file itself is
    // exempt — it's where `BACKUP_TABLES` is declared + frozen, and
    // the `BACKUP_TABLE_KEYS_RUNTIME` mirror legitimately enumerates
    // the same const for drift checking.
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    ignores: ['src/lib/backup/backup-tables.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "SpreadElement[argument.name='BACKUP_TABLES']",
          message:
            'G-T17-8 / ADR-0018 §task #8: spreading BACKUP_TABLES into an array defeats the F-70 closed-allowlist invariant. Pass BACKUP_TABLES directly, or open an architect amendment if the closed-set contract needs to widen.'
        }
      ]
    }
  },
  {
    // G-T11-9 / G-T11-24 / F-19 — the export payload is built field-by-field
    // from the closed allowlist (the `projectMinutesByAllowlist` /
    // `projectRecommendationByAllowlist` switch statements in
    // export-renderer.ts). Spreading a source row object into the payload
    // (`{ ...row }`) would bypass the allowlist and leak un-allowlisted
    // columns — the exact F-19 LAUNCH-BLOCKER anti-pattern. The compile-time
    // exhaustiveness (`never` cast in the switch default) is the load-bearing
    // gate; this lint rule is the belt-and-braces F-19 contract the threat
    // model named ("an ESLint rule forbids spread-into-export-payload").
    //
    // Scoped to the two payload-construction modules. The banned pattern is
    // spreading a BOUND IDENTIFIER (a source row/object variable —
    // `{ ...row }`, `{ ...event }`) into an object literal, which would carry
    // un-allowlisted columns straight through. Legitimate idioms are NOT
    // touched: array spreads (`[...row.agenda_items]`, `[...allowlist]`) are
    // ArrayExpression; the conditional-optional-field idiom
    // (`...(cond ? { x } : {})`) spreads an inline expression, not an
    // identifier. memory-export-store.ts (test store; defensive clones) is
    // out of scope.
    //
    // MUST come AFTER the G-T17-8 block: ESLint flat config is last-match-wins
    // per rule, and G-T17-8's broader `src/**/*.ts` scope would otherwise
    // clobber this `no-restricted-syntax`. Both selectors are carried here so
    // the two export files keep the BACKUP_TABLES ban too (harmless — they
    // never reference it — but loses nothing on the override).
    files: ['src/lib/export/export-renderer.ts', 'src/lib/export/export-core.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "ObjectExpression > SpreadElement[argument.type='Identifier']",
          message:
            'G-T11-9 / F-19: spreading a source object variable into the export payload (`{ ...row }`) is forbidden — it bypasses the closed allowlist and leaks un-allowlisted columns. Build the payload field-by-field from EXPORT_ALLOWLIST_* (see projectMinutesByAllowlist). Array spreads + conditional-field spreads are fine.'
        },
        {
          selector: "SpreadElement[argument.name='BACKUP_TABLES']",
          message:
            'G-T17-8 / ADR-0018 §task #8: spreading BACKUP_TABLES into an array defeats the F-70 closed-allowlist invariant.'
        }
      ]
    }
  },
  {
    // G-T18-4 / ADR-0019 §13 — audit-integrity library MUST NOT depend
    // on either the retention library OR the backup library. The
    // integrity check reads `retention_sweep_runs` rows through a
    // dedicated SECURITY DEFINER fn boundary (NOT via the library's
    // public surface) and reads backup manifests through a similarly
    // narrow fn boundary. The structural property is checked by code
    // review today; from this PR the ESLint rule fail-closes a
    // cross-library import attempt.
    files: ['src/lib/audit-integrity/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/lib/retention/**',
                '**/lib/backup/**',
                '**/retention/**',
                '**/backup/**',
                '$lib/retention/**',
                '$lib/backup/**',
                '../retention/**',
                '../../retention/**',
                './retention/**',
                '../backup/**',
                '../../backup/**',
                './backup/**'
              ],
              message:
                'G-T18-4 / ADR-0019 §13: audit-integrity library MUST NOT import the retention or backup libraries. Reach `retention_sweep_runs` + `backup_manifests` only through the narrow SECURITY DEFINER fn boundary. A cross-library TS import re-couples them.'
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
