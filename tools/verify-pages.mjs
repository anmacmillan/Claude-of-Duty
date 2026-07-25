/** Boots the published Pages build the way an iPad would and reports what it gets. */
import { chromium } from 'playwright';

const URL = process.argv[2] ?? 'https://anmacmillan.github.io/Claude-of-Duty/';

const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--mute-audio'] });
// iPad-ish: touch, portrait-ish viewport, coarse pointer.
const p = await b.newPage({ viewport: { width: 1080, height: 810 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
const errs = [];
const failed = [];
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
p.on('console', (m) => m.type() === 'error' && errs.push('console: ' + m.text()));
p.on('requestfailed', (r) => failed.push(`${r.failure()?.errorText} ${r.url()}`));

const t0 = Date.now();
await p.goto(URL, { waitUntil: 'domcontentloaded' });
await p.waitForFunction('window.__READY__===true', null, { timeout: 120000 });
const bootMs = Date.now() - t0;

const info = await p.evaluate(() => {
  const e = window.__ENGINE__;
  return {
    bootOverlayCleared: !document.getElementById('boot'),
    diag: window.__DIAG__,
    quality: e.ctx.config.quality,
    touchOverlay: !!document.getElementById('ow-touch'),
    hasExplorer: !!e.ctx.peek('explorer'),
    hasWeapons: !!e.ctx.peek('weapons'),
    hasAi: !!e.ctx.peek('ai'),
    frame: e.time.frame,
    prewarm: window.__PREWARM__,
  };
});

console.log(JSON.stringify({ url: URL, bootMs, info, errs, failed }, null, 2));
await p.screenshot({ path: 'shots/pages-live.png' });
await b.close();
