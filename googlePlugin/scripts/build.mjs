import { build } from 'esbuild';
import { cp, mkdir, writeFile } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
const common = { bundle: true, outdir: 'dist', format: 'iife', target: 'chrome142', logLevel: 'info' };
await build({ ...common, entryPoints: { background: 'src/background.ts', offscreen: 'src/offscreen.ts', content: 'src/content.ts', panel: 'src/panel.tsx', 'mic-permission': 'src/mic-permission.ts' } });
await cp('static', 'dist', { recursive: true });
await writeFile('dist/manifest.json', JSON.stringify({
  manifest_version: 3,
  name: 'ScreenSpot Voice',
  version: '0.1.0',
  description: 'Live voice guidance for one authorized browser tab.',
  minimum_chrome_version: '142',
  permissions: ['activeTab', 'scripting', 'sidePanel', 'offscreen', 'tabCapture'],
  host_permissions: ['http://127.0.0.1/*'],
  action: { default_title: 'Open ScreenSpot Voice' },
  background: { service_worker: 'background.js' },
  side_panel: { default_path: 'panel.html' },
  content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'; connect-src 'self' ws://127.0.0.1:*" }
}, null, 2));
