// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/out/**',
      '**/generated/**',
      '**/dev-dist/**',
      '**/release/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      // The single-file suite writes its own report and results beside the served one.
      '**/playwright-report-local/**',
      '**/test-results-local/**',
      'docs/reference/**',
      // Build output that happens to be committed, so people can download one file and run it.
      // Its source is `local-helper/src`, which is linted; bundled esbuild output is not ours.
      'local-helper/now-playing-helper.mjs',
      // wasm-bindgen's glue for the AWSP client, generated from music-player/awsp-web (Rust, linted by clippy).
      'music-player/src/shell/awsp-web/**',
      'music-player/awsp-web/target/**',
      // The Android build copies the built player here (git-ignored output, like dist/).
      'android/app/src/main/assets/app/**',
      '**/*.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.browser, ...globals.es2022 },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports', fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
      'no-empty': ['error', { allowEmptyCatch: false }],
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
    },
  },
  {
    files: ['**/*.tsx'],
    plugins: { 'react-hooks': reactHooks, 'jsx-a11y': jsxA11y },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.configs.recommended.rules,
    },
  },
  {
    files: ['**/scripts/**', '**/*.config.{ts,js,mjs,cjs}', '**/tests/**', '**/*.test.{ts,tsx}', 'scripts/**'],
    rules: { 'no-console': 'off' },
  },
  {
    // CommonJS build configuration (electron-builder loads these with `require`), where a
    // `require()` call is the file format rather than a lapse.
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs' },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
);
