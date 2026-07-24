import js from '@eslint/js';
import globals from 'globals';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

// Flat config, composed with typescript-eslint's `config()` helper. Order
// matters: every rule-setting block comes first and `prettier` comes LAST, so it
// can switch off the stylistic rules that would otherwise fight `prettier
// --write`. Formatting is Prettier's job here; ESLint only judges correctness.
export default tseslint.config(
  {
    // Build output, coverage, and test artifacts. Nothing here is authored, so
    // linting it only produces noise (and, for the bundles, thousands of it).
    ignores: [
      'node_modules/',
      'static/**/dist/',
      'coverage/',
      '.vitest-attachments/',
      '__screenshots__/',
      '.forge/',
    ],
  },

  js.configs.recommended,

  {
    // The app source is TypeScript. typescript-eslint's parser reads the type
    // syntax the default parser can't, and `recommended` adds correctness rules
    // and switches off the base rules it supersedes (e.g. no-unused-vars,
    // no-undef — TS already checks those). Scoped to src so it never touches the
    // Node config files or the JS test suite.
    files: ['src/**/*.{ts,tsx}'],
    extends: [tseslint.configs.recommended],
  },

  {
    // Everything that ships or tests the app runs in a browser iframe: src/ is
    // the two Custom UI bundles (TypeScript), and test/ drives them under jsdom
    // or real Chromium (still JS/JSX). Vitest's globals are not declared because
    // the suite imports describe/it/expect explicitly from 'vitest'.
    files: ['src/**/*.{ts,tsx}', 'test/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        // Build-time constants substituted by Vite (see vite.view.config.js,
        // and the same defines re-injected into both vitest projects). They are
        // real identifiers at runtime; declared in types/globals.d.ts for tsc.
        __MERMAID_11_VERSION__: 'readonly',
        __MERMAID_10_VERSION__: 'readonly',
      },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    settings: { react: { version: 'detect' } },
    plugins: { react, 'react-hooks': reactHooks },
    rules: {
      ...react.configs.flat.recommended.rules,
      // React 19's automatic JSX runtime: `React` need not be in scope for JSX,
      // so jsx-runtime turns off react-in-jsx-scope. It must come after
      // recommended, which sets it.
      ...react.configs.flat['jsx-runtime'].rules,
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // Component props are typed by TypeScript now, so runtime PropTypes would
      // be redundant.
      'react/prop-types': 'off',
    },
  },

  {
    // Tooling that runs under Node, not in the browser: the deploy verifier and
    // the Vite/Vitest/commitlint configs. These stay plain JS.
    files: ['scripts/**/*.{js,mjs}', '*.config.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
  },

  prettier,
);
