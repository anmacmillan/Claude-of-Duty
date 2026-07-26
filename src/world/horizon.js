import * as THREE from 'three';
import { fbm3 } from './util.js';

/**
 * ===========================================================================
 * HORIZON — the land beyond the town
 * ===========================================================================
 *
 * The original level is a sealed box: a 168 m ground square, a ring of
 * buildings, a gate closing the vista, and past that nothing but sky. On foot
 * you never notice. Fly up over the rooftops and it reads as a film set,
 * because there is no outside.
 *
 * This is the outside: rolling land running out from under the town, hills
 * closing east and west, a plain falling away south through the gate axis with
 * mountains at the far end. The town becomes a place in a landscape.
 *
 * Two hard lessons are baked into how this is built, both learned the hard way
 * against this renderer:
 *
 * 1. **No flat sheet.** A dead-flat disc at a fixed low height did not
 *    rasterise reliably from above while its raised rim did. Every ring here
 *    has relief, everywhere, so there is no degenerate flat span.
 *
 * 2. **No shader injection for the haze.** Splicing an aerial-perspective term
 *    into `onBeforeCompile` failed silently — the marker it targeted was not
 *    always present, so distant land rendered at full albedo and blew to
 *    white. The distance haze is instead baked into the vertex colours at
 *    build time and recomputed when the time of day changes (a rare event, not
 *    per frame), which needs no shader surgery and cannot fail quietly.
 *
 * Built in LEVEL space, the same coordinates as `layout.js`: south is -Z, so
 * the valley lines up with the gate with no trigonometry.
 */

/** Inner edge, tucked well under the town's 168 m ground square (±84 m). */
const R0 = 46;
/** Outer edge. Inside the 1200 m camera far plane, hazed to sky long before it. */
const R1 = 1100;
const RINGS = 72;
const SEGMENTS = 200;

/** The land opens out southwards, down the gate axis. */
const VALLEY_DIR = -Math.PI / 2;
const VALLEY_HALF_ANGLE = 0.72;

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const smoothstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/**
 * Height of the land at a level-space point, in metres. Relief EVERYWHERE:
 * even the valley floor breathes a metre or two, so no triangle is part of a
 * perfectly flat low span.
 */
function heightAt(x, z) {
  const r = Math.hypot(x, z);
  const t = clamp01((r - R0) / (R1 - R0));

  const ang = Math.atan2(z, x);
  let dAng = Math.abs(ang - VALLEY_DIR);
  if (dAng > Math.PI) dAng = Math.PI * 2 - dAng;
  const offAxis = smoothstep(VALLEY_HALF_ANGLE, VALLEY_HALF_ANGLE + 0.85, dAng);

  const ridge = (fx, fz, oct) => {
    const n = fbm3(x * fx, 11.7, z * fz, oct) * 2 - 1;
    return 1 - Math.abs(n);
  };

  // Ground swell present at every radius, so nothing is a flat sheet. Tiny near
  // the town (it must not poke up through the -0.03 sand plane there), growing
  // outward.
  const swell = (fbm3(x * 0.02, 8.1, z * 0.02, 3) - 0.5) * (0.6 + 3.5 * t);

  // Rise past the town: gentle, starting just beyond the ground square.
  const rise = smoothstep(0.06, 0.30, t);

  const hills = ridge(0.0024, 0.0024, 4) * 82 * offAxis;
  const floor = (fbm3(x * 0.0013, 3.1, z * 0.0013, 3) - 0.5) * 18 - t * 20;
  const far = smoothstep(0.42, 0.95, t) * ridge(0.0009, 0.0011, 5) * (160 + 200 * offAxis);

  // Base sits a touch under the town's ground so the square reads as a low rise
  // in continuous land rather than a plateau on a disc.
  return -1.2 + swell + (hills + far + floor) * rise;
}

/**
 * Base (un-hazed) linear albedo for a vertex at height y and radius r. LINEAR,
 * not sRGB — three reads vertex colours linearly. These are deliberately dark;
 * an early pass used sRGB-looking values (~0.4) which as linear blew to white.
 */
const SAND = new THREE.Color(0.150, 0.122, 0.080);
const GRASS = new THREE.Color(0.052, 0.079, 0.038);
const SCRUB = new THREE.Color(0.104, 0.100, 0.055);
const ROCK = new THREE.Color(0.120, 0.108, 0.092);
const SNOW = new THREE.Color(0.230, 0.230, 0.225);

function baseAlbedo(out, x, z, y, r) {
  const hN = clamp01((y + 18) / 200);
  const jitter = (fbm3(x * 0.004, 5.5, z * 0.004, 2) - 0.5) * 0.14;
  const h = clamp01(hN + jitter);

  if (h < 0.30) out.copy(GRASS).lerp(SCRUB, h / 0.30);
  else if (h < 0.66) out.copy(SCRUB).lerp(ROCK, (h - 0.30) / 0.36);
  else out.copy(ROCK).lerp(SNOW, (h - 0.66) / 0.34);

  // Fade to the town's sand as the ring nears it: the ground square then sits
  // in matching ground rather than on a green disc.
  const near = 1 - smoothstep(R0, R0 * 3.6, r);
  if (near > 0) out.lerp(SAND, near);
  return out;
}

/**
 * @returns {{ mesh, setHaze(color): void, dispose(): void }}
 */
export function buildHorizon(rng, hazeColor = new THREE.Color(0.04, 0.05, 0.07)) {
  const vertCount = (RINGS + 1) * (SEGMENTS + 1);
  const positions = new Float32Array(vertCount * 3);
  const colors = new Float32Array(vertCount * 3);
  // Per-vertex base albedo and haze fraction, kept so the haze can be recomputed
  // when the sky's colour changes without rebuilding anything.
  const baseCols = new Float32Array(vertCount * 3);
  const hazeFrac = new Float32Array(vertCount);
  const indices = [];

  const radii = new Float32Array(RINGS + 1);
  for (let i = 0; i <= RINGS; i++) {
    radii[i] = R0 + (R1 - R0) * (i / RINGS) ** 2.1;
  }

  // Haze fraction by radius: 0 at the town, 1 well before the far edge, so the
  // outer rim has already become sky and the seam at R1 is never visible.
  const HAZE_START = 90;
  const HAZE_FULL = 720;

  const c = new THREE.Color();
  let v = 0;
  for (let i = 0; i <= RINGS; i++) {
    const r = radii[i];
    const hz = smoothstep(HAZE_START, HAZE_FULL, r);
    for (let j = 0; j <= SEGMENTS; j++) {
      const a = (j / SEGMENTS) * Math.PI * 2;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const y = heightAt(x, z);

      positions[v * 3] = x;
      positions[v * 3 + 1] = y;
      positions[v * 3 + 2] = z;

      baseAlbedo(c, x, z, y, r);
      baseCols[v * 3] = c.r;
      baseCols[v * 3 + 1] = c.g;
      baseCols[v * 3 + 2] = c.b;
      hazeFrac[v] = hz;
      v++;
    }
  }

  const stride = SEGMENTS + 1;
  for (let i = 0; i < RINGS; i++) {
    for (let j = 0; j < SEGMENTS; j++) {
      const a = i * stride + j;
      const b = a + stride;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const colorAttr = new THREE.BufferAttribute(colors, 3);
  geo.setAttribute('color', colorAttr);
  geo.setIndex(indices);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.97,
    metalness: 0,
    // Double-sided: a flat-ish disc seen from above must not depend on winding.
    side: THREE.DoubleSide,
  });

  /**
   * Recompute vertex colours as base albedo lerped toward the sky's colour by
   * the baked haze fraction. Cheap (a few multiplies over ~14k verts) and only
   * called when the time of day actually changes.
   */
  const applyHaze = (col) => {
    const hr = col.r;
    const hg = col.g;
    const hb = col.b;
    for (let k = 0; k < vertCount; k++) {
      const f = hazeFrac[k];
      const g = 1 - f;
      colors[k * 3] = baseCols[k * 3] * g + hr * f;
      colors[k * 3 + 1] = baseCols[k * 3 + 1] * g + hg * f;
      colors[k * 3 + 2] = baseCols[k * 3 + 2] * g + hb * f;
    }
    colorAttr.needsUpdate = true;
  };
  applyHaze(hazeColor);

  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'horizon';
  mesh.frustumCulled = false; // it wraps the whole scene; never cull it
  mesh.matrixAutoUpdate = false;
  mesh.userData.owNoShadow = true;
  mesh.receiveShadow = false;
  mesh.castShadow = false;

  return {
    mesh,
    /** Follow the sky so dusk hazes orange and night hazes near-black. */
    setHaze(color) {
      applyHaze(color);
    },
    dispose() {
      geo.dispose();
      material.dispose();
    },
  };
}
