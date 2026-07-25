/** Boots the live Pages build at iPhone viewport sizes, portrait and landscape. */
import { chromium } from 'playwright';

const URL = 'https://anmacmillan.github.io/Claude-of-Duty/';
const CASES = [
  { name: 'phone-portrait', width: 390, height: 844 },
  { name: 'phone-landscape', width: 844, height: 390 },
];

const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--mute-audio'] });

for (const c of CASES) {
  const p = await b.newPage({
    viewport: { width: c.width, height: c.height },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 3,
  });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));

  const t0 = Date.now();
  await p.goto(URL, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction('window.__READY__===true', null, { timeout: 120000 });
  const bootMs = Date.now() - t0;

  // Where do the controls actually land at this size?
  const layout = await p.evaluate(() => {
    const r = (sel) => {
      const e = document.querySelector(sel);
      if (!e) return null;
      const b = e.getBoundingClientRect();
      return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
    };
    const overlaps = (a, b) => a && b && a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    const move = r('#ow-touch .move');
    const crouch = r('#ow-touch .crouch');
    const jump = r('#ow-touch .jump');
    const tools = r('#ow-touch .tools');
    return {
      viewport: { w: innerWidth, h: innerHeight },
      move, jump, crouch, tools,
      crouchOverMoveZone: overlaps(crouch, move),
      toolsOffScreen: tools ? tools.y + tools.h > innerHeight : null,
      minimap: r('.ow-minimap, [class*=minimap]'),
    };
  });

  // Does it hold a frame rate? Measure over 120 frames.
  const fps = await p.evaluate(
    () =>
      new Promise((done) => {
        let n = 0;
        const t0 = performance.now();
        const tick = () => (++n >= 120 ? done(Math.round((n * 1000) / (performance.now() - t0))) : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      })
  );

  await p.screenshot({ path: `shots/${c.name}.png` });
  console.log(JSON.stringify({ case: c.name, bootMs, fps, layout, errs }, null, 2));
  await p.close();
}

await b.close();
