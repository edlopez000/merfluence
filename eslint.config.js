import js from '@eslint/js';
import globals from 'globals';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';

// Flat config. Order matters: every rule-setting block comes first and
// `prettier` comes LAST, so it can switch off the stylistic rules that would
// otherwise fight `prettier --write`. Formatting is Prettier's job here; ESLint
// only judges correctness.
export default [
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
    // Everything that ships or tests the app runs in a browser iframe: src/ is
    // the two Custom UI bundles, and test/ drives them under jsdom or real
    // Chromium. Vitest's globals are not declared because the suite imports
    // describe/it/expect explicitly from 'vitest'.
    files: ['src/**/*.{js,jsx}', 'test/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        // Build-time constants substituted by Vite (see vite.view.config.js,
        // and the same defines re-injected into both vitest projects). They are
        // real identifiers at runtime, so ESLint has to be told they exist.
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
      // This is a plain-JS React app with no PropTypes anywhere and only two
      // components with props, both internal to their own file. Adding runtime
      // type declarations to satisfy a linter is not a change worth making.
      'react/prop-types': 'off',
    },
  },

  {
    // Tooling that runs under Node, not in the browser: the deploy verifier and
    // the Vite/Vitest/commitlint configs.
    files: ['scripts/**/*.{js,mjs}', '*.config.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
  },

  prettier,
];
