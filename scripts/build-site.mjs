// Build the static site into dist/site: the whole studio runs in the browser, any static host can serve it.
//   node scripts/build-site.mjs           (the legacy editor bundle is built first by web/legacy/build.mjs)
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = p => fileURLToPath(new URL(p, import.meta.url));
const OUT = here('../dist/site/');
const nm = p => here(`../node_modules/${p}`);

if (!existsSync(here('../web/public/legacy/modeler.js'))) {
  throw new Error('web/public/legacy/modeler.js is missing: run "node web/legacy/build.mjs" first (npm run build does)');
}
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT + 'vendor', { recursive: true });

await build({
  entryPoints: [here('../web/assistant/core.js')],
  bundle: true,
  minify: true,
  format: 'iife',
  globalName: 'BpmnCore',
  platform: 'browser',
  target: 'es2022',
  outfile: OUT + 'core.js',
  logLevel: 'warning'
});

for (const f of ['index.html', 'app.js', 'app.css']) cpSync(here(`../web/public/${f}`), OUT + f);
cpSync(here('../web/public/legacy'), OUT + 'legacy', { recursive: true });
cpSync(nm('camunda-bpmn-js/dist/camunda-cloud-modeler.production.min.js'), OUT + 'vendor/modeler-cloud.js');
cpSync(nm('camunda-bpmn-js/dist/camunda-platform-modeler.production.min.js'), OUT + 'vendor/modeler-platform.js');
cpSync(nm('camunda-bpmn-js/dist/assets'), OUT + 'vendor/assets', { recursive: true });
cpSync(nm('marked/lib/marked.umd.js'), OUT + 'vendor/marked.js');
cpSync(nm('dompurify/dist/purify.min.js'), OUT + 'vendor/purify.js');
// the "Local API" server the settings dialog packs into a zip for download
for (const f of ['server.js', 'package.json', 'README.md']) cpSync(here(`../local-server/${f}`), OUT + `local-server/${f}`);
// The site's config: $STUDIO_CONFIG, else the private bpmn-studio.config.json (internal servers; never
// committed), else the public one. The GitHub Pages workflow always uses the public config.
const configSource = process.env.STUDIO_CONFIG
  ? here(`../${process.env.STUDIO_CONFIG}`)
  : existsSync(here('../bpmn-studio.config.json')) ? here('../bpmn-studio.config.json') : here('../bpmn-studio.config.public.json');
if (!existsSync(configSource)) throw new Error(`config not found: ${configSource}`);
cpSync(configSource, OUT + 'bpmn-studio.config.json');
// GitHub Pages: publish files as they are (no Jekyll processing)
writeFileSync(OUT + '.nojekyll', '');
console.log('site built →', OUT, `(config: ${configSource.split('/').pop()})`);
