/**
 * Screenshot from an arbitrary camera, which the named-shot harness cannot do.
 * Needed for the horizon: every canonical shot stands in the street, where the
 * buildings hide exactly the thing being tested.
 *
 *   node tools/shot-free.mjs --pos=0,60,90 --look=0,10,-120 --time=6.5 --out=shots/dawn.png
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const vec = (s) => s.split(',').map(Number);

const pos = vec(arg('pos', '0,70,110'));
const look = vec(arg('look', '0,20,-200'));
const time = Number(arg('time', '16.5'));
const fov = Number(arg('fov', '70'));
const out = arg('out', 'shots/free.png');
const q = arg('q', 'ultra');
const PORT = 5197;

const server = spawn(resolve(root, 'node_modules/.bin/vite'), ['--port', String(PORT), '--strictPort'], {
  cwd: root,
  stdio: 'ignore',
  env: { ...process.env, OW_NO_HMR: '1' },
});
await new Promise((r) => setTimeout(r, 3000));

const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));

await p.goto(`http://127.0.0.1:${PORT}/?q=${q}&prewarm=0`, { waitUntil: 'domcontentloaded' });
await p.waitForFunction('window.__READY__===true', null, { timeout: 120000 });

await p.evaluate(
  ([pos, look, time]) => {
    const e = window.__ENGINE__;
    e.ctx.peek('player')?.setControlEnabled?.(false);
    e.ctx.peek('ui')?.setHudVisible?.(false);
    e.ctx.peek('sky')?.setTimeOfDay?.(time);
    e.input.frozen = true;
    const cam = e.camera;
    cam.position.set(pos[0], pos[1], pos[2]);
    cam.lookAt(look[0], look[1], look[2]);
    cam.updateMatrixWorld();
    // Hold it there: the player rig would otherwise reclaim the transform.
    e.__hold = () => { cam.position.set(pos[0], pos[1], pos[2]); cam.lookAt(look[0], look[1], look[2]); cam.updateMatrixWorld(); };
    e.events.on('frame', e.__hold);
  },
  [pos, look, time]
);

// Let TAA settle and the sky rebake.
await p.evaluate(
  () => new Promise((d) => { let i = 0; const t = () => (++i >= 90 ? d() : requestAnimationFrame(t)); requestAnimationFrame(t); })
);
await p.evaluate(
  ([pos, look]) => {
    const cam = window.__ENGINE__.camera;
    cam.position.set(pos[0], pos[1], pos[2]);
    cam.lookAt(look[0], look[1], look[2]);
    cam.updateMatrixWorld();
  },
  [pos, look]
);
await p.evaluate(
  () => new Promise((d) => { let i = 0; const t = () => (++i >= 8 ? d() : requestAnimationFrame(t)); requestAnimationFrame(t); })
);

await p.locator('#game').screenshot({ path: out });
console.log(JSON.stringify({ ok: true, out, pos, look, time, errs }));

await b.close();
server.kill();
