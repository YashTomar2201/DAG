module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  rules: {
    // Disallow bare console.log (use structured logger instead)
    'no-console': ['warn', { allow: ['warn', 'error'] }],
    // No implicit any — strict type safety everywhere
    '@typescript-eslint/no-explicit-any': 'error',
    // Unused vars allowed if prefixed with _ (common for unused destructure)
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
  },
  ignorePatterns: ['dist/', 'node_modules/', '*.config.js', 'generated/'],
  env: {
    node: true,
    es2022: true,
  },
};
