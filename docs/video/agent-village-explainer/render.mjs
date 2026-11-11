// Renders film.js to JPEG frames with headless Chromium.
// Usage: node render.mjs <outDir> [startFrame] [endFrame] [--stills 1.5,8,...]
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// require() honours NODE_PATH, so a globally installed Playwright works too.
const { chromium } = createRequire(import.meta.url)('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const [outDir, a, b] = process.argv.slice(2);
const stillsAt = process.argv.includes('--stills') ? process.argv[process.argv.indexOf('--stills') + 1].split(',').map(Number) : null;
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
page.on('pageerror', e => { console.error('page error:', e.message); process.exitCode = 1; });
await page.goto(pathToFileURL(join(here, 'index.html')).href);
await page.evaluate(() => document.fonts.ready);
const { frames, FPS } = await page.evaluate(() => ({ frames: film.frames, FPS: film.FPS }));
const list = stillsAt ? stillsAt.map(s => Math.round(s * FPS)) : Array.from({ length: Math.min(+b || frames, frames) - (+a || 0) }, (_, i) => i + (+a || 0));
for (const f of list) {
  const url = await page.evaluate(n => { film.draw(n); return document.getElementById('c').toDataURL('image/jpeg', 0.94); }, f);
  writeFileSync(join(outDir, `f${String(f).padStart(5, '0')}.jpg`), Buffer.from(url.split(',')[1], 'base64'));
}
await browser.close();
