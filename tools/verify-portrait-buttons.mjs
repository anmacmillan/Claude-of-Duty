/**
 * The geometric overlap probe says CROUCH sits inside the movement zone in
 * portrait. That is by design now (the move zone is the whole bottom band and
 * the buttons float on it), but "by design" is worth nothing if the touch lands
 * on the wrong thing. This asks the only question that matters: touching CROUCH
 * must press crouch and must NOT start the walk stick.
 */
import { chromium } from 'playwright';

const URL = process.argv[2] ?? 'https://anmacmillan.github.io/Claude-of-Duty/';

const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--mute-audio'] });
const p = await b.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 });
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));

await p.goto(URL, { waitUntil: 'domcontentloaded' });
await p.waitForFunction('window.__READY__===true', null, { timeout: 120000 });
await p.evaluate(() => { const e = window.__ENGINE__; e.input.enabled = true; e.input.frozen = false; });

const frames = (n) =>
  p.evaluate((n) => new Promise((d) => { let i = 0; const t = () => (++i >= n ? d() : requestAnimationFrame(t)); requestAnimationFrame(t); }), n);

// Dispatch a real touch at the centre of a given element.
const touchEl = (sel, type, id) =>
  p.evaluate(
    ([sel, type, id]) => {
      const el = document.querySelector(sel);
      const r = el.getBoundingClientRect();
      const x = r.x + r.width / 2;
      const y = r.y + r.height / 2;
      // Whatever is actually on top at that point is what a finger would hit.
      const hit = document.elementFromPoint(x, y);
      const t = new Touch({ identifier: id, target: hit, clientX: x, clientY: y });
      hit.dispatchEvent(new TouchEvent(type, { changedTouches: [t], touches: [t], bubbles: true, cancelable: true }));
      return { hitTag: hit.tagName, hitClass: hit.className, hitCode: hit.dataset?.code ?? null };
    },
    [sel, type, id]
  );

const probe = () =>
  p.evaluate(() => {
    const e = window.__ENGINE__;
    return {
      crouchHeld: e.input.held('KeyC'),
      stickActive: !!e.input.touch?.active,
      stick: { x: e.input.stick.moveX, y: e.input.stick.moveY },
      ringVisible: document.querySelector('#ow-touch .ring')?.classList.contains('on') ?? null,
    };
  });

const out = {};
out.idle = await probe();

out.hitTest = await touchEl('#ow-touch .crouch', 'touchstart', 11);
await frames(4);
out.whileTouchingCrouch = await probe();

await touchEl('#ow-touch .crouch', 'touchend', 11);
await frames(4);
out.afterRelease = await probe();

// And the control case: a touch in the open part of the walk band must start
// the stick, not a button.
await p.evaluate(() => {
  const el = document.elementFromPoint(80, 700);
  const t = new Touch({ identifier: 12, target: el, clientX: 80, clientY: 700 });
  el.dispatchEvent(new TouchEvent('touchstart', { changedTouches: [t], touches: [t], bubbles: true, cancelable: true }));
});
await frames(4);
out.whileTouchingOpenGround = await probe();

out.verdict = {
  crouchButtonWorks: out.whileTouchingCrouch.crouchHeld === true,
  crouchDidNotStartWalking: out.whileTouchingCrouch.stickActive === false,
  openGroundStartsWalking: out.whileTouchingOpenGround.stickActive === true,
};

console.log(JSON.stringify({ out, errs }, null, 2));
await b.close();
