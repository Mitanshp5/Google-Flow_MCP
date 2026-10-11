import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js', 'tests/**/*.spec.js'],
    exclude: [
      ...configDefaults.exclude,
      'qa-output/**',
      '**/qa-output/**',
      'staging/**',
      '**/staging/**',
      'outputs/**',
      'reliability-evidence/**',
      'evidence-v2/**',
      'screenshots-debug/**',
    ],
  },
});
