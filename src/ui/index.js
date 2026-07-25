import * as THREE from 'three';
import { installStyles, removeStyles } from './style.js';
import { el, clamp, damp, setStyle } from './util.js';
import { Compass } from './compass.js';
import { Minimap } from './minimap.js';
import { WorldMarkers } from './markers.js';
import { Prompt, Banner } from './prompts.js';
import { PauseMenu } from './menu.js';

/**
 * ===========================================================================
 * HUD / UI subsystem — explorer build
 * ===========================================================================
 *
 * A DOM+CSS overlay (see style.js for the design system) driven entirely from
 * `lateUpdate`, after the camera has reached its final transform for the frame.
 * Nothing animates on a CSS keyframe or transition: every value is integrated
 * from `dt` here, which is what makes the capture harness deterministic and
 * lets the whole HUD freeze correctly when the game is paused.
 *
 * The combat HUD (crosshair, hitmarkers, ammo, killfeed, damage arcs, health,
 * match bar) is gone along with the weapons and ai subsystems. What is left is
 * navigation and signage: where you are, which way you are facing, and what is
 * worth walking towards.
 *
 * ---------------------------------------------------------------------------
 * PUBLIC API — `const ui = ctx.get('ui')`
 * ---------------------------------------------------------------------------
 *   ui.banner.show(title, sub, life)      arrival / discovery card
 *   ui.setPrompt({key,text,sub,progress}) / ui.clearPrompt()
 *   ui.setPlaces([{position,label,name}]) points of interest, compass + map
 *   ui.setHudVisible(bool)                hide everything (photo mode)
 *   ui.pause() / ui.resume() / ui.menu.toggle()
 *   ui.debugState('clean'|'menu')
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SUBSYSTEM READS FROM OTHERS (all optional, all duck-typed)
 * ---------------------------------------------------------------------------
 *   player.getHudState() -> { move, sprint, crouch, airborne, position }
 *                           (or plain `player.position`)
 *   audio.playUi(id, gain) | audio.play(id) — menu ticks
 *
 * Events consumed: player:state, resize.
 * Events emitted:  ui:pause, ui:quality, ui:sensitivity, ui:fov, ui:setting.
 */
export class UiSystem {
  static id = 'ui';
  static deps = ['render'];

  async init(ctx) {
    this.ctx = ctx;
    this.rng = ctx.rng.fork();
    installStyles();

    const host = document.getElementById('ui') ?? document.body;
    this.root = el('div', 'ow-hud', host);

    // Stacking order: world-space markers under the chrome, the menu over all.
    this.worldLayer = el('div', 'ow-layer', this.root);
    this.chromeLayer = el('div', 'ow-layer', this.root);

    this.markers = new WorldMarkers(this.worldLayer, this.rng.fork());
    this.minimap = new Minimap(this.chromeLayer, this.rng.fork());
    this.compass = new Compass(this.chromeLayer);
    this.prompt = new Prompt(this.chromeLayer);
    this.banner = new Banner(this.chromeLayer);
    this.menu = new PauseMenu(this.root, ctx);

    /** Single source of truth for everything the HUD draws. */
    this.state = {
      move: 0,
      sprint: false,
      crouch: false,
      airborne: false,
      time: 0,
    };

    this.k = 1;
    this.vw = 1920;
    this.vh = 1080;
    this.hudVisible = 1;
    this.hudTarget = 1;
    this._lastRaw = ctx.time.raw;
    this._hadPointerLock = false;
    this._bakeFrame = 0;

    this._pos = new THREE.Vector3();
    this._prevPos = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._places = [];
    this._compassObjs = [];

    this._unsubs = [];
    const on = (type, fn) => this._unsubs.push(ctx.events.on(type, fn));

    on('player:state', (e) => {
      if (!e) return;
      const s = this.state;
      if (e.sprinting !== undefined) s.sprint = !!e.sprinting;
      if (e.stance !== undefined) s.crouch = e.stance === 'crouch' || e.stance === 'prone';
    });

    this.resize(ctx.canvas.clientWidth || innerWidth, ctx.canvas.clientHeight || innerHeight, ctx);
    this._prevPos.copy(this._playerPos());
  }

  /* ------------------------------------------------------------- helpers -- */

  _playerState() {
    const p = this.ctx.peek('player');
    const s = typeof p?.getHudState === 'function' ? p.getHudState() : p?.hudState ?? null;
    return s && typeof s === 'object' ? s : null;
  }

  _playerPos() {
    const p = this.ctx.peek('player');
    const pos = p?.position ?? p?.getPosition?.();
    if (pos && pos.isVector3) return this._pos.copy(pos);
    return this._pos.copy(this.ctx.camera.position);
  }

  /** Fire-and-forget audio; the audio subsystem may not exist yet. */
  sfx(id, gain = 1) {
    const a = this.ctx.peek('audio');
    if (!a) return;
    try {
      if (typeof a.playUi === 'function') a.playUi(id, gain);
      else if (typeof a.play === 'function') a.play(id, { gain });
      else if (typeof a.sfx === 'function') a.sfx(id, gain);
    } catch {
      /* audio is optional feedback — never let it break the HUD */
    }
  }

  /* ---------------------------------------------------------------- api --- */

  setPrompt(p) {
    this.prompt.set(p);
  }

  clearPrompt() {
    this.prompt.clear();
  }

  /** Points of interest: drawn on the compass strip and the map. */
  setPlaces(list) {
    this._places = list ?? [];
  }

  addPlace(o) {
    this._places.push(o);
  }

  removePlace(id) {
    const i = this._places.findIndex((o) => o.id === id);
    if (i >= 0) this._places.splice(i, 1);
  }

  setHudVisible(v) {
    this.hudTarget = v ? 1 : 0;
  }

  pause() {
    this.menu.show();
  }

  resume() {
    this.menu.close();
  }

  /* --------------------------------------------------------------- debug -- */

  debugState(name = 'clean') {
    if (name === 'menu') {
      this.menu.show();
      return { state: 'menu' };
    }
    this.markers.clear();
    this.clearPrompt();
    this.menu.close();
    return { state: 'clean' };
  }

  /* -------------------------------------------------------------- frame --- */

  lateUpdate(dt, ctx) {
    const t = ctx.time;
    const rawDt = clamp(t.raw - this._lastRaw, 0, 0.1);
    this._lastRaw = t.raw;
    const s = this.state;
    s.time = t.elapsed;

    // ---- pause -----------------------------------------------------------
    if (ctx.input.enabled && !ctx.input.frozen) {
      if (ctx.input.actionPressed('pause')) this.menu.toggle();
      // Losing pointer lock mid-walk is the same intent as pressing Escape.
      if (ctx.input.pointerLocked) this._hadPointerLock = true;
      else if (this._hadPointerLock && !this.menu.open) {
        this._hadPointerLock = false;
        this.menu.show();
      }
    }
    this.menu.update(rawDt);

    // ---- external state --------------------------------------------------
    const ps = this._playerState();
    if (ps) {
      if (ps.move !== undefined) s.move = ps.move;
      if (ps.sprint !== undefined) s.sprint = !!ps.sprint;
      if (ps.crouch !== undefined) s.crouch = !!ps.crouch;
      if (ps.airborne !== undefined) s.airborne = !!ps.airborne;
    }

    const pos = this._playerPos();
    if (!ps) {
      this._dir.copy(pos).sub(this._prevPos);
      this._dir.y = 0;
      const speed = dt > 0 ? this._dir.length() / dt : 0;
      s.move = damp(s.move, clamp(speed / 6.2, 0, 1), 12, Math.max(rawDt, 1e-3));
    }
    this._prevPos.copy(pos);

    // ---- camera basis ----------------------------------------------------
    const m = ctx.camera.matrixWorld.elements;
    let fx = -m[8];
    let fz = -m[10];
    const fl = Math.hypot(fx, fz) || 1;
    fx /= fl;
    fz /= fl;
    const heading = (Math.atan2(fx, -fz) * 180) / Math.PI;

    // ---- widgets ---------------------------------------------------------
    const hudGoal = this.hudTarget * (this.menu.open ? 0.15 : 1);
    this.hudVisible = damp(this.hudVisible, hudGoal, 10, rawDt);
    setStyle(this.chromeLayer, 'opacity', this.hudVisible.toFixed(3));
    setStyle(this.worldLayer, 'opacity', this.hudVisible.toFixed(3));

    this.prompt.update(dt);
    this.banner.update(dt);

    this._buildCompassPlaces(pos);
    this.compass.update(heading, this._compassObjs);

    this.markers.updateObjectives(this._places, ctx.camera, this.vw, this.vh, this.k);

    // ---- minimap ---------------------------------------------------------
    if (!this.minimap.bakeDone && ++this._bakeFrame > 6 && this._bakeFrame % 20 === 0) {
      this.minimap.tryBake(ctx);
    }
    this._mmState = this._mmState ?? { x: 0, z: 0, heading: 0, fov: 80, blips: null, objectives: null };
    this._mmState.x = pos.x;
    this._mmState.z = pos.z;
    this._mmState.heading = heading;
    this._mmState.fov = ctx.camera.fov;
    this._mmState.blips = null;
    this._mmState.objectives = this._mmObjs ?? (this._mmObjs = []);
    this._mmObjs.length = 0;
    for (const o of this._places) {
      if (!o.position) continue;
      this._mmObjs.push(o._mm ?? (o._mm = { x: 0, z: 0, label: o.label }));
      const last = this._mmObjs[this._mmObjs.length - 1];
      last.x = o.position.x;
      last.z = o.position.z;
      last.label = o.label;
    }
    this.minimap.draw(this._mmState);
  }

  _buildCompassPlaces(pos) {
    const out = this._compassObjs;
    out.length = 0;
    for (const o of this._places) {
      if (!o.position) continue;
      const dx = o.position.x - pos.x;
      const dz = o.position.z - pos.z;
      const bearing = (Math.atan2(dx, -dz) * 180) / Math.PI;
      out.push(o._cmp ?? (o._cmp = { bearing: 0, label: o.label, color: o.color }));
      const last = out[out.length - 1];
      last.bearing = bearing;
      last.label = o.label;
      last.color = o.color;
    }
    return out;
  }

  resize(w, h, ctx) {
    this.vw = w;
    this.vh = h;
    // Height alone sizes the HUD wrongly on a phone held upright: a 390x844
    // screen is tall enough to score k=0.78, which puts a 139px minimap across
    // a third of the width and runs the compass strip off the left edge. Take
    // the smaller of the two axes so narrow screens shrink the chrome.
    this.k = clamp(Math.min(h / 1080, w / 1500), 0.42, 2.4);
    this.root.style.setProperty('--k', this.k.toFixed(4));
    this.compass.setScale(this.k);
    this.minimap.resize(this.k);
  }

  dispose() {
    for (const off of this._unsubs) off();
    this._unsubs.length = 0;
    this.compass.dispose();
    this.minimap.dispose();
    this.markers.dispose();
    this.prompt.dispose();
    this.banner.dispose();
    this.menu.dispose();
    this.root.remove();
    removeStyles();
  }
}
