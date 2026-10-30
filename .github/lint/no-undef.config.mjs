// Catches references to functions/variables that no longer exist, e.g. a helper removed
// upstream while custom code still calls it (a merge leaves no conflict, the page crashes).
// Run by .github/workflows/custom-latency-check.yml; tools are installed with --no-save.
import vue from 'eslint-plugin-vue';
import globals from 'globals';
import vueParser from 'vue-eslint-parser';

const workers = { WebSocketPair: 'readonly', WebSocketRequestResponsePair: 'readonly' };
export default [
  { ignores: ['dist/**', 'node_modules/**', 'agent/**'] },
  {
    files: ['src/**/*.vue'],
    languageOptions: { parser: vueParser, parserOptions: { ecmaVersion: 'latest', sourceType: 'module' }, globals: { ...globals.browser } },
    plugins: { vue },
    rules: { 'no-undef': 'error' }
  },
  {
    files: ['src/**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...globals.browser, ...globals.node, ...globals.worker, ...workers } },
    rules: { 'no-undef': 'error' }
  }
];
