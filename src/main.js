import { Engine } from './core/engine.js';
import { createConfig } from './core/config.js';

import { RenderSystem } from './render/index.js';
import { MaterialSystem } from './materials/index.js';
import { SkySystem } from './sky/index.js';
import { WorldSystem } from './world/index.js';
import { PhysicsSystem } from './physics/index.js';
import { PlayerSystem } from './player/index.js';
import { FxSystem } from './fx/index.js';
import { UiSystem } from './ui/index.js';
import { ExplorerSystem } from './explorer/index.js';
import { AudioSystem } from './audio/index.js';

import { installShotApi } from './dev/shots.js';
import { prewarm } from './core/prewarm.js';
import { installTouch, isTouchDevice } from './core/touch.js';

const params = new URLSearchParams(location.search);
const capture = params.get('capture') === '1';
// Deterministic shutter for the pixel gate: the engine does not schedule its own
// frames, the driver advances exactly N of them through window.__PUMP__. Opt-in,
// because tools that measure real frame pacing (tools/perf.mjs) need the loop to
// free-run. See the long comment in src/dev/shots.js.
const lockstep = capture && params.get('lockstep') === '1';

// A finger on the glass means a mobile GPU and no pointer lock. Both are
// decided here, before any subsystem builds a render target, and both can be
// overridden from the URL: ?q=ultra to force quality, ?touch=1 to bring the
// on-screen controls up on a desktop for testing.
const touchDevice = params.get('touch') === '1' || (params.get('touch') !== '0' && isTouchDevice());

// `low` rather than `potato` for the touch default. The target devices are an
// A14 iPad and an A15 iPhone, both with 4 GB: the renderer caps pixel ratio at
// 1.5, so `low`'s 0.72 render scale works out around 1274x886 on the iPad with
// no TAA, GTAO, SSR or volumetrics in the frame. `potato`'s 0.5 scale looks
// soft on a retina screen for no reason on that hardware. Older or hotter
// devices can drop with ?q=potato.
const config = createConfig({
  quality: params.get('q') ?? (touchDevice ? 'low' : 'ultra'),
  deterministic: capture,
});

const canvas = document.getElementById('game');

const engine = new Engine({ canvas, config });

// Registration order is irrelevant — Registry topo-sorts on static deps.
engine
  .add(RenderSystem)
  .add(MaterialSystem)
  .add(SkySystem)
  .add(WorldSystem)
  .add(PhysicsSystem)
  .add(PlayerSystem)
  .add(FxSystem)
  .add(UiSystem)
  .add(AudioSystem)
  .add(ExplorerSystem);

const boot = globalThis.__BOOT__ ?? { stage() {}, fail() {}, done() {} };
boot.stage('building the world', 0.15);

// What the device actually reports, captured before anything can go wrong with
// it. When a boot fails on hardware we cannot hold, this is the difference
// between a diagnosis and a guess.
window.__DIAG__ = (() => {
  try {
    const probe = document.createElement('canvas').getContext('webgl2');
    if (!probe) return { webgl2: false, note: 'no WebGL2 context — this device cannot run it' };
    const info = probe.getExtension('WEBGL_debug_renderer_info');
    return {
      webgl2: true,
      renderer: info ? probe.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'hidden',
      vendor: info ? probe.getParameter(info.UNMASKED_VENDOR_WEBGL) : 'hidden',
      maxTexture: probe.getParameter(probe.MAX_TEXTURE_SIZE),
      colorBufferFloat: !!probe.getExtension('EXT_color_buffer_float'),
      floatLinear: !!probe.getExtension('OES_texture_float_linear'),
      parallelCompile: !!probe.getExtension('KHR_parallel_shader_compile'),
      dpr: globalThis.devicePixelRatio,
      screen: `${screen.width}x${screen.height}`,
      ua: navigator.userAgent,
    };
  } catch (e) {
    return { error: String(e) };
  }
})();
console.info('[boot] device', window.__DIAG__);
if (params.get('diag') === '1') boot.fail(JSON.stringify(window.__DIAG__, null, 2));

try {
  await engine.init();
} catch (err) {
  console.error('[boot] init failed', err);
  boot.fail(err.stack ?? err.message);
  document.body.insertAdjacentHTML(
    'beforeend',
    `<pre style="position:fixed;inset:0;padding:2rem;color:#f66;background:#000;
       font:12px/1.5 ui-monospace,monospace;overflow:auto;z-index:9999;white-space:pre-wrap">
BOOT FAILURE\n\n${err.stack ?? err.message}</pre>`
  );
  throw err;
}

const shotApi = installShotApi(engine, { capture, lockstep });

// After init: the input instance exists, and the overlay must sit above the
// canvas the engine has by now taken over. Skipped under capture so the
// screenshot harness never photographs a thumbstick.
const touchUi = capture ? null : installTouch(engine.ctx.input, { force: params.get('touch') === '1' });
if (touchUi) console.info('[boot] touch controls installed');

// Compile every shader permutation before the frame loop starts. Measured: without
// this, 86 programs compile lazily during play, up to 30 on one frame, producing
// 3.1-3.9 SECOND stalls. See src/core/prewarm.js.
//
// ON BY DEFAULT since the capture path was made frame-deterministic; opt out with
// `?prewarm=0`. It is now PROVEN pixel-neutral: `tools/baseline.mjs` with
// `--query=prewarm=0` vs `--query=prewarm=1` reports identical:true on all 11
// shots (0 changed pixels, maxDelta 0). The two things that previously made the
// ~1.4 s pre-warm spend look like a visual change were both boot-duration
// couplings OUTSIDE the subsystems: (1) the shutter frame index was latency-bound
// because the engine kept stepping through the driver's round trips — fixed by
// lockstep in src/dev/shots.js; (2) `will-change: transform` on the compass strip
// cached a composited-layer raster taken at a wall-clock-dependent moment — fixed
// in src/ui/style.js.
//
// TOUCH DEVICES: prewarm is awaited, so anything that stops it resolving stops
// the boot dead — the touch overlay is already up by this point, which is
// exactly the "buttons on a black screen" a real iPad reported. It leans on
// compileAsync / KHR_parallel_shader_compile, which iOS Safari handles poorly.
// So it is off by default on touch (?prewarm=1 forces it back on), and
// wherever it does run it now races a timeout it cannot outlive. Losing the
// prewarm costs some first-minute hitching. Losing the boot costs everything.
const prewarmWanted = params.get('prewarm') === '1' || (params.get('prewarm') !== '0' && !touchDevice);

const withTimeout = (promise, ms, onTimeout) =>
  Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(onTimeout), ms)),
  ]);

let warmup;
if (!prewarmWanted) {
  warmup = { ok: false, reason: touchDevice ? 'skipped on touch device' : 'disabled by ?prewarm=0' };
} else {
  boot.stage('compiling shaders', 0.5);
  warmup = await withTimeout(prewarm(engine), 25000, { ok: false, reason: 'timed out after 25s, starting anyway' });
}
console.info('[boot] prewarm', warmup);
window.__PREWARM__ = warmup;

boot.stage('almost there', 0.9);
engine.start();

// Capture harness handshake: only flag ready once a frame has actually landed.
//
// BOOT_FRAMES is deliberately a frame COUNT, not a rAF race. In lockstep mode the
// engine has no loop of its own, so we hand-pump exactly this many frames and only
// then raise __READY__; the shot is therefore always applied at engine frame 3, no
// matter how long boot (or pre-warm) took in wall-clock terms.
const BOOT_FRAMES = 3;
if (lockstep) {
  await shotApi.pump(BOOT_FRAMES);
  window.__READY__ = true;
  boot.done();
} else {
  let warm = 0;
  const readyProbe = () => {
    if (++warm >= BOOT_FRAMES) {
      window.__READY__ = true;
      // Only now, with real frames on the canvas, is it safe to lift the
      // overlay. Lifting it any earlier just shows black with more confidence.
      boot.done();
      return;
    }
    requestAnimationFrame(readyProbe);
  };
  requestAnimationFrame(readyProbe);

  // A black screen must explain itself, and there are two very different black
  // screens. If frames never land, the engine is stuck. If frames DO land and
  // the screen is still black, the frame is being drawn and then lost somewhere
  // in the post chain. probeHdr reads the HDR buffer straight back off the GPU
  // and tells the two apart without anyone having to hold the device.
  window.__WHYBLACK__ = () => {
    const render = engine.ctx.peek('render');
    let hdr = null;
    try {
      hdr = render?.probeHdr?.(0.2, 0.2, 0.8, 0.8) ?? null;
    } catch (e) {
      hdr = { error: String(e) };
    }
    const lit = hdr && hdr.max > 0.001;
    return {
      build: window.__BUILD__,
      framesLanded: engine.time?.frame ?? 0,
      ready: !!window.__READY__,
      quality: config.quality,
      prewarm: warmup.reason ?? 'ran',
      hdrAverage: hdr && !hdr.error ? { r: +hdr.r.toFixed(4), g: +hdr.g.toFixed(4), b: +hdr.b.toFixed(4), max: +hdr.max.toFixed(4) } : hdr,
      verdict: !engine.time?.frame
        ? 'engine never rendered a frame'
        : lit
          ? 'the world IS being rendered; it is lost in the post chain or the canvas'
          : 'frames render but the HDR buffer is black; the scene or lighting is not drawing',
      device: window.__DIAG__,
    };
  };

  // Only speak up if something is actually wrong. A healthy boot says nothing.
  setTimeout(() => {
    const r = window.__WHYBLACK__();
    const healthy = r.framesLanded > 0 && r.hdrAverage && !r.hdrAverage.error && r.hdrAverage.max > 0.001;
    if (healthy && params.get('diag') !== '1') return;
    boot.report(JSON.stringify(r, null, 2));
  }, 12000);
}

window.__ENGINE__ = engine;

if (import.meta.hot) {
  import.meta.hot.dispose(() => engine.dispose());
}
