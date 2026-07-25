import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const root = '/Users/alexandermacmillan/Projects/Claude-of-Duty';
const PORT = 5199;

const server = spawn(resolve(root, 'node_modules/.bin/vite'), ['--port', String(PORT), '--strictPort'], {
  cwd: root,
  stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 3000));

const b = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--mute-audio'],
});
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
p.on('console', (m) => m.type() === 'error' && errs.push('console: ' + m.text()));

await p.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await p.waitForFunction('window.__READY__===true', null, { timeout: 90000 });

const frames = (n) =>
  p.evaluate(
    (n) => new Promise((d) => { let i = 0; const t = () => (++i >= n ? d() : requestAnimationFrame(t)); requestAnimationFrame(t); }),
    n
  );

const state = () =>
  p.evaluate(() => {
    const e = window.__ENGINE__;
    const c = e.camera.position;
    return {
      hour: +e.ctx.peek('sky').timeOfDay.toFixed(3),
      timeRate: e.ctx.peek('sky').timeRate,
      flying: e.ctx.peek('explorer').flying,
      hudOn: e.ctx.peek('explorer').hudOn,
      hudTarget: e.ctx.peek('ui').hudTarget,
      controlEnabled: e.ctx.peek('player').controlEnabled,
      pos: [+c.x.toFixed(2), +c.y.toFixed(2), +c.z.toFixed(2)],
      nan: !Number.isFinite(c.x + c.y + c.z),
    };
  });

await p.evaluate(() => {
  const e = window.__ENGINE__;
  e.input.enabled = true;
  e.input.frozen = false;
});
await frames(3);

const results = {};
results.start = await state();

// --- H: hide the HUD --------------------------------------------------------
await p.keyboard.press('h');
await frames(5);
results.afterH = await state();

// --- T: let time run --------------------------------------------------------
await p.keyboard.press('t');
await frames(30);
results.afterT = await state();
await p.keyboard.press('t');
await frames(3);
results.afterT2 = await state();

// --- ]: scrub the sun forward ----------------------------------------------
const beforeScrub = (await state()).hour;
await p.keyboard.down(']');
await frames(45);
await p.keyboard.up(']');
await frames(3);
const afterScrub = await state();
results.scrub = { before: beforeScrub, after: afterScrub.hour, moved: afterScrub.hour !== beforeScrub };

// --- F: fly, move up, land --------------------------------------------------
await p.keyboard.press('f');
await frames(5);
results.afterF = await state();
await p.keyboard.down(' ');
await frames(45);
await p.keyboard.up(' ');
await frames(3);
results.afterClimb = await state();
await p.keyboard.press('f');
await frames(10);
results.afterLand = await state();

console.log(JSON.stringify({ results, errs }, null, 2));

await b.close();
server.kill();
