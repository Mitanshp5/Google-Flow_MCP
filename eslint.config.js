// P2-3: minimal lint gate — catches unused imports (P1-5 class) and
// undefined-variable typos (the P0-1 live ReferenceError class) before they
// ship. Deliberately not opinionated (no style rules). Node + browser globals
// because page.evaluate() callbacks execute in the browser context
// (document/window/navigator) while everything else runs in Node.
import globals from 'globals';

export default [
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'logs/**',
      'outputs/**',
      'screenshots-debug/**',
      'chrome-profile-kiara/**',
    ],
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      'no-unused-vars': ['error', { args: 'after-used', ignoreRestSiblings: true }],
      'no-undef': 'error',
    },
  },
];
