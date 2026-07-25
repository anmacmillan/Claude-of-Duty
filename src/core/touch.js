/**
 * ===========================================================================
 * TOUCH — controls for iPad and other coarse-pointer devices
 * ===========================================================================
 *
 * Safari on iPadOS does not implement pointer lock at all, so the mouse-look
 * path in input.js can never engage there. Rather than special-case the player
 * and explorer systems, this module feeds the two seams the engine already
 * has for a gamepad:
 *
 *   input.touch.moveX/moveY   read by Input._pollGamepad into input.stick,
 *                             which moveVector() already folds into WASD
 *   input.addLook(dx, dy)     the same accumulator mouse movement writes to
 *   input.injectDown/Up(code) synthesised key codes, so the on-screen buttons
 *                             go through ACTIONS like any other key
 *
 * Everything downstream — movement, the camera rig, the explorer's fly mode —
 * is therefore untouched and cannot tell the difference.
 *
 * Sign convention for the stick matches a real gamepad's left stick: pushing
 * AWAY from you is moveY = -1, because moveVector() does `y -= stick.moveY`.
 */

/** True on a device whose primary input is a finger. */
export function isTouchDevice() {
  if (typeof navigator === 'undefined') return false;
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  return coarse || navigator.maxTouchPoints > 1;
}

const CSS = `
#ow-touch { position:fixed; inset:0; z-index:60; touch-action:none; -webkit-user-select:none;
  user-select:none; -webkit-tap-highlight-color:transparent; pointer-events:none; }
#ow-touch .zone { position:absolute; pointer-events:auto; }
#ow-touch .move { left:0; bottom:0; width:48%; height:62%; }
#ow-touch .look { right:0; top:0; width:52%; height:100%; }
#ow-touch .ring { position:absolute; width:132px; height:132px; margin:-66px 0 0 -66px;
  border-radius:50%; border:2px solid rgba(255,255,255,.28); background:rgba(0,0,0,.16);
  opacity:0; transition:opacity .12s linear; }
#ow-touch .knob { position:absolute; width:58px; height:58px; margin:-29px 0 0 -29px;
  border-radius:50%; background:rgba(255,255,255,.42); box-shadow:0 2px 10px rgba(0,0,0,.4);
  opacity:0; transition:opacity .12s linear; }
#ow-touch .ring.on, #ow-touch .knob.on { opacity:1; }
#ow-touch button { pointer-events:auto; position:absolute; border:1px solid rgba(255,255,255,.3);
  background:rgba(12,14,18,.44); color:rgba(255,255,255,.9); border-radius:14px;
  font:600 13px/1 ui-sans-serif,system-ui,sans-serif; letter-spacing:.04em;
  backdrop-filter:blur(6px); -webkit-backdrop-filter:blur(6px); }
#ow-touch button:active { background:rgba(255,255,255,.28); }
#ow-touch .jump { right:26px; bottom:34px; width:96px; height:96px; border-radius:50%; font-size:15px; }
#ow-touch .crouch { right:140px; bottom:44px; width:76px; height:66px; }
#ow-touch .tools { position:absolute; right:20px; top:96px; display:flex; flex-direction:column; gap:10px;
  pointer-events:none; }
#ow-touch .tools button { position:relative; right:auto; top:auto; width:64px; height:44px; }
`;

/**
 * @param {import('./input.js').Input} input
 * @returns {{dispose():void}|null} null when the device is not touch-driven
 */
export function installTouch(input, { force = false } = {}) {
  if (!force && !isTouchDevice()) return null;

  const style = document.createElement('style');
  style.id = 'ow-touch-style';
  style.textContent = CSS;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.id = 'ow-touch';
  root.innerHTML = `
    <div class="zone move"></div>
    <div class="zone look"></div>
    <div class="ring"></div>
    <div class="knob"></div>
    <button class="jump" data-code="Space">JUMP</button>
    <button class="crouch" data-code="KeyC">CROUCH</button>
    <div class="tools">
      <button data-code="KeyF">FLY</button>
      <button data-code="KeyH">HUD</button>
      <button data-code="BracketLeft">SUN −</button>
      <button data-code="BracketRight">SUN +</button>
      <button data-code="KeyT">TIME</button>
    </div>`;
  document.body.appendChild(root);

  const moveZone = root.querySelector('.move');
  const lookZone = root.querySelector('.look');
  const ring = root.querySelector('.ring');
  const knob = root.querySelector('.knob');

  input.touch = { active: false, moveX: 0, moveY: 0 };

  // --- movement stick -------------------------------------------------------
  // The ring is drawn wherever the thumb lands rather than at a fixed spot: on
  // a tablet held two-handed, "wherever my thumb already is" is the only place
  // that is comfortable, and it differs by hand size.
  const RADIUS = 62;
  let moveId = null;
  let originX = 0;
  let originY = 0;

  const showStick = (x, y) => {
    ring.style.left = `${x}px`;
    ring.style.top = `${y}px`;
    knob.style.left = `${x}px`;
    knob.style.top = `${y}px`;
    ring.classList.add('on');
    knob.classList.add('on');
  };

  const hideStick = () => {
    ring.classList.remove('on');
    knob.classList.remove('on');
  };

  const onMoveStart = (e) => {
    if (moveId !== null) return;
    const t = e.changedTouches[0];
    moveId = t.identifier;
    originX = t.clientX;
    originY = t.clientY;
    showStick(originX, originY);
    input.touch.active = true;
    e.preventDefault();
  };

  const onMoveMove = (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier !== moveId) continue;
      let dx = t.clientX - originX;
      let dy = t.clientY - originY;
      const len = Math.hypot(dx, dy);
      if (len > RADIUS) {
        dx = (dx / len) * RADIUS;
        dy = (dy / len) * RADIUS;
      }
      knob.style.left = `${originX + dx}px`;
      knob.style.top = `${originY + dy}px`;
      input.touch.moveX = dx / RADIUS;
      input.touch.moveY = dy / RADIUS;
      e.preventDefault();
    }
  };

  const onMoveEnd = (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier !== moveId) continue;
      moveId = null;
      input.touch.active = false;
      input.touch.moveX = 0;
      input.touch.moveY = 0;
      hideStick();
    }
  };

  // --- look drag ------------------------------------------------------------
  // Fed straight into the same accumulator as mouse movement, so the sensitivity
  // setting in the pause menu applies to both. The multiplier compensates for a
  // finger travelling far fewer pixels than a mouse over the same intent.
  const LOOK_GAIN = 1.6;
  let lookId = null;
  let lastX = 0;
  let lastY = 0;

  const onLookStart = (e) => {
    if (lookId !== null) return;
    const t = e.changedTouches[0];
    lookId = t.identifier;
    lastX = t.clientX;
    lastY = t.clientY;
    e.preventDefault();
  };

  const onLookMove = (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier !== lookId) continue;
      input.addLook((t.clientX - lastX) * LOOK_GAIN, (t.clientY - lastY) * LOOK_GAIN);
      lastX = t.clientX;
      lastY = t.clientY;
      e.preventDefault();
    }
  };

  const onLookEnd = (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier === lookId) lookId = null;
    }
  };

  moveZone.addEventListener('touchstart', onMoveStart, { passive: false });
  moveZone.addEventListener('touchmove', onMoveMove, { passive: false });
  moveZone.addEventListener('touchend', onMoveEnd);
  moveZone.addEventListener('touchcancel', onMoveEnd);

  lookZone.addEventListener('touchstart', onLookStart, { passive: false });
  lookZone.addEventListener('touchmove', onLookMove, { passive: false });
  lookZone.addEventListener('touchend', onLookEnd);
  lookZone.addEventListener('touchcancel', onLookEnd);

  // --- buttons --------------------------------------------------------------
  // Held, not tapped: JUMP and CROUCH need to repeat while the finger is down,
  // and SUN ± is a scrub the explorer system reads with input.held().
  const buttons = [...root.querySelectorAll('button')];
  const btnDown = (e) => {
    const code = e.currentTarget.dataset.code;
    input.injectDown(code);
    e.preventDefault();
  };
  const btnUp = (e) => {
    input.injectUp(e.currentTarget.dataset.code);
    e.preventDefault();
  };
  for (const b of buttons) {
    b.addEventListener('touchstart', btnDown, { passive: false });
    b.addEventListener('touchend', btnUp, { passive: false });
    b.addEventListener('touchcancel', btnUp);
  }

  return {
    dispose() {
      moveZone.removeEventListener('touchstart', onMoveStart);
      moveZone.removeEventListener('touchmove', onMoveMove);
      moveZone.removeEventListener('touchend', onMoveEnd);
      moveZone.removeEventListener('touchcancel', onMoveEnd);
      lookZone.removeEventListener('touchstart', onLookStart);
      lookZone.removeEventListener('touchmove', onLookMove);
      lookZone.removeEventListener('touchend', onLookEnd);
      lookZone.removeEventListener('touchcancel', onLookEnd);
      for (const b of buttons) {
        b.removeEventListener('touchstart', btnDown);
        b.removeEventListener('touchend', btnUp);
        b.removeEventListener('touchcancel', btnUp);
      }
      root.remove();
      style.remove();
      input.touch = null;
    },
  };
}
