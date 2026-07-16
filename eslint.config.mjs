// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/coverage/**', '**/next-env.d.ts'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // CLAUDE.md §5: no `any` — use `unknown` + narrowing
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  // Dependency direction (DOCS.md §2): core imports nothing internal
  {
    files: ['packages/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['@zygos/*'], message: 'packages/core must not import other workspace packages (DOCS.md §2).' },
            { group: ['node:*', 'fs', 'net', 'http', 'https', 'child_process'], message: 'packages/core is pure: no I/O (CLAUDE.md §5).' },
          ],
        },
      ],
    },
  },
  // venue-adapters may import core only
  {
    files: ['packages/venue-adapters/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['@zygos/server', '@zygos/web'], message: 'venue-adapters may import only @zygos/core (DOCS.md §2).' },
          ],
        },
      ],
    },
  },
  // web talks to server over HTTP/WS only — no workspace imports
  {
    files: ['apps/web/**/*.ts', 'apps/web/**/*.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['@zygos/*'], message: 'apps/web imports only its own code; talk to the server over HTTP/WS (DOCS.md §2).' },
          ],
        },
      ],
    },
  },
);
