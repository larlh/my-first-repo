// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Single flat config for the whole monorepo (`pnpm lint` at the root, or `pnpm lint` inside a
 * package — ESLint finds this file by walking up). Formatting is Prettier's job.
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      'packages/db/drizzle/**',
      'packages/renderer/test-output/**',
      'data/**',
      'tmp/**',
      // Python virtualenvs / caches of services/avatar-engine ship third-party .js files.
      '**/.venv/**',
      '**/__pycache__/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/ban-ts-comment': [
        'error',
        { 'ts-ignore': true, 'ts-expect-error': 'allow-with-description' },
      ],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always'],
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
          message:
            'Math.random() is forbidden: use a seeded PRNG in render code and node:crypto for secrets.',
        },
      ],
    },
  },
  {
    // Browser code
    files: ['apps/web/**/*.{ts,tsx}', 'packages/renderer/src/browser/**/*.ts'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    // CLI scripts and entry points may print to stdout.
    files: ['**/scripts/**', '**/*.config.{ts,js,mjs}', 'scripts/**'],
    rules: { 'no-console': 'off' },
  },
  {
    // Tests may use Math.random for fixtures and console for debugging output.
    files: ['**/*.test.{ts,tsx}', '**/test/**', '**/testing/**'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  prettier,
);
