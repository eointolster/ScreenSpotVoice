import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';

mkdirSync('dist', { recursive: true });
await build({ entryPoints: ['src/main.ts'], outfile: 'dist/main.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'], target: 'node24' });
await build({ entryPoints: ['src/preload.ts'], outfile: 'dist/preload.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'], target: 'node24' });
await build({ entryPoints: ['src/renderer.ts'], outfile: 'dist/renderer.js', bundle: true, platform: 'browser', format: 'iife', target: 'chrome152' });
await build({ entryPoints: ['src/overlay.ts'], outfile: 'dist/overlay.js', bundle: true, platform: 'browser', format: 'iife', target: 'chrome152' });
await build({ entryPoints: ['src/geometry.ts'], outfile: 'dist/geometry.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node24' });
await build({ entryPoints: ['src/response.ts'], outfile: 'dist/response.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node24' });
await build({ entryPoints: ['src/capture-region.ts'], outfile: 'dist/capture-region.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node24' });
await build({ entryPoints: ['src/secure-key.ts'], outfile: 'dist/secure-key.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node24' });
for (const name of ['index.html', 'overlay.html', 'style.css', 'overlay.css', 'mic-worklet.js']) cpSync(`static/${name}`, `dist/${name}`);
