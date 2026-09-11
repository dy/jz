import unusedImports from 'eslint-plugin-unused-imports'

export default [{
  ignores: ['**/node_modules/**', 'dist/**', '.work/**', 'test/test262/**', 'assets/sprae.js'],
}, {
  files: ['*.js', 'src/**/*.js', 'jzify/**/*.js', 'module/**/*.js'],
  linterOptions: { reportUnusedDisableDirectives: 'off' },
  plugins: { 'unused-imports': unusedImports },
  rules: { 'unused-imports/no-unused-imports': 'error' },
}]
