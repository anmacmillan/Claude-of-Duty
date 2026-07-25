import * as THREE from 'three';

/**
 * ===========================================================================
 * EXPLORER — the controls that replace shooting
 * ===========================================================================
 *
 * This subsystem owns everything that makes the level a place to wander rather
 * than a place to win. It touches no other subsystem's internals: it drives
 * `sky` through its public setTimeOfDay/setTimeRate, `ui` through setHudVisible
 * and the banner, and `player` through setControlEnabled/teleport.
 *
 *   H                 hide / show the HUD
 *   [  ]              wind the sun back / forward (hold to scrub)
 *   T                 let time run on its own, and stop it again
 *   F                 free-fly camera, and walk again
 *     in fly:         WASD to move, Space up, Ctrl down, Shift to go fast
 *
 * Fly mode takes the camera off the player rig entirely rather than trying to
 * noclip the character controller: the rig only writes to the camera while
 * `player.controlEnabled` is true, so switching that off leaves the transform
 * ours to drive. Landing puts the player back wherever the camera ended up.
 */
export class ExplorerSystem {
  static id = 'explorer';
  static deps = ['sky', 'ui', 'player'];

  async init(ctx) {
    this.ctx = ctx;

    this.flying = false;
    this.hudOn = true;
    this.timeRunning = false;

    this.yaw = 0;
    this.pitch = 0;
    this.flySpeed = 8;

    // Preallocated: nothing in update() may allocate.
    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
    this._move = new THREE.Vector3();
    this._euler = new THREE.Euler(0, 0, 0, 'YXZ');
    this._eye = new THREE.Vector3();

    // A quiet welcome instead of a mission briefing.
    const ui = ctx.peek('ui');
    ui?.banner?.show?.('Have a wander', 'H hides the HUD · [ ] move the sun · F to fly', 7);
  }

  _sky() {
    return this.ctx.peek('sky');
  }

  /* ----------------------------------------------------------------- time -- */

  nudgeTime(hours) {
    const sky = this._sky();
    if (!sky) return;
    sky.setTimeOfDay(sky.timeOfDay + hours);
  }

  toggleTimeFlow() {
    const sky = this._sky();
    if (!sky) return;
    this.timeRunning = !this.timeRunning;
    // A full day in four minutes: fast enough to watch the shadows swing,
    // slow enough that a sunset lasts long enough to stand in.
    sky.setTimeRate(this.timeRunning ? 0.1 : 0);
    this.ctx.peek('ui')?.banner?.show?.(this.timeRunning ? 'Time running' : 'Time held', '', 2.5);
  }

  /* ------------------------------------------------------------------ hud -- */

  toggleHud() {
    this.hudOn = !this.hudOn;
    this.ctx.peek('ui')?.setHudVisible?.(this.hudOn);
  }

  /* ------------------------------------------------------------------ fly -- */

  toggleFly() {
    const player = this.ctx.peek('player');
    const cam = this.ctx.camera;
    if (!player) return;

    if (!this.flying) {
      // Inherit the camera's current aim so the view does not jump.
      this._euler.setFromQuaternion(cam.quaternion, 'YXZ');
      this.yaw = this._euler.y;
      this.pitch = this._euler.x;
      player.setControlEnabled(false);
      this.flying = true;
      this.ctx.peek('ui')?.banner?.show?.('Flying', 'Space up · Ctrl down · Shift fast · F to land', 4);
    } else {
      this.flying = false;
      // Put the walker where the camera is, facing the same way, so landing
      // feels like stepping down rather than being yanked back.
      this._eye.copy(cam.position);
      player.teleport(this._eye, this.yaw);
      player.setControlEnabled(true);
      this.ctx.peek('ui')?.banner?.show?.('Walking', '', 2);
    }
  }

  update(dt, ctx) {
    const input = ctx.input;
    if (!input.enabled || input.frozen) return;

    if (input.pressed('KeyH')) this.toggleHud();
    if (input.pressed('KeyT')) this.toggleTimeFlow();
    if (input.pressed('KeyF')) this.toggleFly();

    // Held, not pressed: leaning on the bracket keys should sweep the sun.
    const scrub = (input.held('BracketRight') ? 1 : 0) - (input.held('BracketLeft') ? 1 : 0);
    if (scrub !== 0) this.nudgeTime(scrub * dt * 2.5);

    if (this.flying) this._updateFly(dt, ctx);
  }

  _updateFly(dt, ctx) {
    const input = ctx.input;
    const cam = ctx.camera;

    // ---- look ------------------------------------------------------------
    this.yaw -= input.look.x;
    this.pitch -= input.look.y;
    const lim = Math.PI / 2 - 0.01;
    this.pitch = Math.max(-lim, Math.min(lim, this.pitch));
    this._euler.set(this.pitch, this.yaw, 0, 'YXZ');
    cam.quaternion.setFromEuler(this._euler);

    // ---- move ------------------------------------------------------------
    this._fwd.set(0, 0, -1).applyQuaternion(cam.quaternion);
    this._right.set(1, 0, 0).applyQuaternion(cam.quaternion);

    this._move.set(0, 0, 0);
    if (input.action('forward')) this._move.add(this._fwd);
    if (input.action('back')) this._move.sub(this._fwd);
    if (input.action('right')) this._move.add(this._right);
    if (input.action('left')) this._move.sub(this._right);
    if (input.action('jump')) this._move.add(this._up);
    if (input.action('crouch')) this._move.sub(this._up);

    if (this._move.lengthSq() > 0) {
      this._move.normalize();
      const speed = this.flySpeed * (input.action('sprint') ? 4 : 1);
      cam.position.addScaledVector(this._move, speed * dt);
    }

    // Nobody wants to fly under the pavement and lose the world.
    if (cam.position.y < 0.4) cam.position.y = 0.4;
    cam.updateMatrixWorld();
  }

  dispose() {
    this._sky()?.setTimeRate?.(0);
  }
}
