// Bundle the legacy editor and copy its stylesheets/fonts into web/public/legacy.
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = p => fileURLToPath(new URL(p, import.meta.url));
const out = here('../public/legacy/');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [here('./src/entry.js')],
  bundle: true,
  minify: true,
  format: 'iife',
  globalName: 'LegacyBpmnModeler',
  footer: { js: 'LegacyBpmnModeler = LegacyBpmnModeler.default;' },
  target: 'es2019',
  platform: 'browser',
  // resolve packages like webpack 5 does: require('ids').default expects the ES module build
  mainFields: ['browser', 'module', 'main'],
  outfile: out + 'modeler.js',
  logLevel: 'warning'
});
cpSync(here('./node_modules/bpmn-js/dist/assets'), out + 'bpmn-js', { recursive: true });
cpSync(here('./node_modules/bpmn-js-properties-panel/dist/assets'), out + 'properties-panel', { recursive: true });
console.log('legacy modeler built →', out);
