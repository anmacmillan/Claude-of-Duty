/**
 * Drives the on-screen touch controls with synthetic TouchEvents, the way an
 * iPad would, and asserts that movement, look and the buttons all reach the
 * engine. Run against a desktop Chromium with ?touch=1 forcing the overlay on.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const PORT = 5198;

const server = spawn(resolve(root, 'node_modules/.bin/vite'), ['--port', String(PORT), '--strictPort'], {
  cwd: root,
  stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 3000));

const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1024, height: 768 }, hasTouch: true, isMobile: true });
const errs = [];
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
p.on('console', (m) => m.type() === 'error' && errs.push('console: ' + m.text()));

await p.goto(`http://127.0.0.1:${PORT}/?touch=1`, { waitUntil: 'domcontentloaded' });
await p.waitForFunction('window.__READY__===true', null, { timeout: 90000 });

const frames = (n) =>
  p.evaluate((n) => new Promise((d) => { let i = 0; const t = () => (++i >= n ? d() : requestAnimationFrame(t)); requestAnimationFrame(t); }), n);

// Synthetic multi-touch: the handlers read identifier/clientX/clientY only.
await p.evaluate(() => {
  window.__touch = (type, target, id, x, y) => {
    const el = document.querySelector(target);
    const t = new Touch({ identifier: id, target: el, clientX: x, clientY: y });
    el.dispatchEvent(new TouchEvent(type, { changedTouches: [t], touches: [t], bubbles: true, cancelable: true }));
  };
});
const touch = (type, target, id, x, y) => p.evaluate(([type, target, id, x, y]) => window.__touch(type, target, id, x, y), [type, target, id, x, y]);

const state = () =>
  p.evaluate(() => {
    const e = window.__ENGINE__;
    const c = e.camera.position;
    return {
      quality: e.ctx.config.quality,
      overlay: !!document.getElementById('ow-touch'),
      stick: { x: +e.input.stick.moveX.toFixed(2), y: +e.input.stick.moveY.toFixed(2) },
      pos: [+c.x.toFixed(2), +c.y.toFixed(2), +c.z.toFixed(2)],
      yaw: +e.camera.rotation.y.toFixed(3),
      flying: e.ctx.peek('explorer').flying,
      hour: +e.ctx.peek('sky').timeOfDay.toFixed(2),
    };
  });

await p.evaluate(() => { const e = window.__ENGINE__; e.input.enabled = true; e.input.frozen = false; });
await frames(3);

const out = {};
out.start = await state();

// --- push the movement stick forward ---------------------------------------
await touch('touchstart', '.move', 1, 200, 600);
await touch('touchmove', '.move', 1, 200, 520);
await frames(4);
out.stickPushed = await state();
await frames(45);
out.afterWalk = await state();
await touch('touchend', '.move', 1, 200, 520);
await frames(3);
out.stickReleased = await state();

// --- drag to look -----------------------------------------------------------
const yawBefore = (await state()).yaw;
await touch('touchstart', '.look', 2, 800, 300);
for (let i = 1; i <= 6; i++) await touch('touchmove', '.look', 2, 800 - i * 25, 300);
await frames(4);
await touch('touchend', '.look', 2, 650, 300);
const yawAfter = (await state()).yaw;
out.look = { before: yawBefore, after: yawAfter, moved: yawBefore !== yawAfter };

// --- FLY button -------------------------------------------------------------
const flyBtn = '#ow-touch .tools button[data-code="KeyF"]';
await touch('touchstart', flyBtn, 3, 980, 150);
await frames(3);
await touch('touchend', flyBtn, 3, 980, 150);
await frames(5);
out.afterFlyButton = await state();

// --- SUN + button -----------------------------------------------------------
const sunBtn = '#ow-touch .tools button[data-code="BracketRight"]';
const hourBefore = (await state()).hour;
await touch('touchstart', sunBtn, 4, 980, 300);
await frames(40);
await touch('touchend', sunBtn, 4, 980, 300);
await frames(3);
const hourAfter = (await state()).hour;
out.sun = { before: hourBefore, after: hourAfter, moved: hourAfter !== hourBefore };

console.log(JSON.stringify({ out, errs }, null, 2));

await b.close();
server.kill();
