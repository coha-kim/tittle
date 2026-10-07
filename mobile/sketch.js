// Mobile: shake to select a shape, then hold SIGNAL and shake to fade it.
// Canvas motion and pair forces are independent of sensor input.
// Opacity accumulates over held shaking time and persists until reset.

// ---- fixed config ----
const NUM_BOIDS  = 10;
const SEED_COLOR = '#2A9284';
const BACKGROUND_COLOR = '#ECEADB';

// smooth radial gradient -- base colour on the rim, lightening toward white
// at the centre.
const CENTER_LIGHTEN = 0.66;

// ---- autonomous wander (fixed, independent of shaking) ----
const MOVE_BASE_PX = 1.9;    // baseline px/frame wander speed
const NOISE_BASE   = 0.006;  // baseline wander-clock advance per frame
// vx = noise(seed+off0) - noise(seed+off1), vy likewise -- a difference of two
// noise samples is zero-mean whatever noise()'s own mean is, so no net drift.
const WANDER_NOISE_OFFSETS = [0, 2113, 4229, 6337];
const EDGE_MARGIN = 90;
const EDGE_STEER  = 2.8;

// cosmetic per-orb breathing
const PULSE_AMP  = 0.05;
const PULSE_RATE = 0.9;

// ---- shape screen: shake -> spike count + sharpness ----
const SHAPE_SEGMENTS      = 64;   // vertices traced per blob outline
const SHAPE_MAX_SPIKES    = 10;   // spike count at full shake
const SHAPE_MAX_AMP       = 0.55; // spike height as a fraction of base radius, at full shake
const SHAPE_SPIKE_SHARPNESS = 3.5; // higher = narrower, more pointed spikes
const SHAPE_LEVEL_EASE    = 6;    // preview smoothing rate (per second)

// ---- fixed mutual attraction between boids ----
const ATTRACTION_IDLE    = 0.45;  // resting attraction -- a light, organic drift together, not a snap-to-cluster pull
const ATTRACT_FACTOR     = 3.2;   // reach = ATTRACT_FACTOR * blobSize -- local, not a whole-screen pull
const ATTRACT_GAIN       = 0.35;  // px/frame at contact, per unit of attraction
// Core is wide enough that even at max breathing-pulse size (see PULSE_AMP)
// boids' edges stay clear of touching -- at rest they drift loosely near
// each other (like the display app's boids) but never visually fuse.
const ATTRACT_CORE_FACTOR = 2.6;  // anti-collapse core radius = this * blobSize, always on
const ATTRACT_CORE_GAIN   = 2.4;  // px/frame max core repel at full overlap
// A soft force alone isn't a guarantee -- two boids wandering toward each
// other can close faster than ATTRACT_CORE_GAIN can push back, so they'd
// still visually fuse for a moment. This is a HARD floor enforced as a
// direct position correction after movement, the same technique the display
// app uses (resolveCrossPopulationSeparation) -- it's what actually
// guarantees boids never overlap, with the soft core above just there to
// make the approach feel like a cushion rather than a hard bounce.
const SEPARATION_FACTOR = 2.3;    // hard-floor spacing = this * blobSize
const SEPARATION_ITERS  = 2;      // relaxation passes per frame
const FADE_SECONDS = 5; // cumulative held shaking time from opaque to transparent

// ---- shake sensing (feeds the shape screen, and "is shaking happening now?") ----
const SHAKE_GAIN     = 0.05;  // accel-delta magnitude -> shape energy
const SHAKE_DEADZONE = 0.7;   // ignore resting hand jitter (delta below this)
const SHAKE_DECAY    = 2.0;   // shake energy bled off per second
const SHAKE_FULL     = 4.0;   // energy that maps to full shape spikiness
const SHAKE_ACTIVE_WINDOW_MS = 300; // a qualifying jolt within this long ago counts as "still shaking"

// ---- live params ----
let blobSize = 24;
const attraction = ATTRACTION_IDLE;
let chosenShapeSpec = { numSpikes: 0, spikeAmp: 0 };

// ---- state ----
let appState = 'shape'; // 'shape' | 'canvas'
let boids = [];
let baseColor;
let centerColor;
let WHITE;
let noiseAccum = 0;
let shapeLevel = 0; // smoothed 0..1, shape screen only

let shakeEnergy = 0;
let signaling   = false;
let blobOpacity = 1;
let signalPointerId = null;
let lastShakeAt = -Infinity; // millis() of the last qualifying jolt

let lastMs = 0;
let lastAccel = null;
let motionSeen = false;
let motionStatus = 'needs-permission'; // needs-permission | requesting | granted | denied | unsupported

let signalEl;
let shapeHintEl;
let motionBtnEl;
let motionStatusEl;
let dragLast = null;

function setup() {
  const cnv = createCanvas(windowWidth, windowHeight);
  cnv.parent('canvas-holder');
  pixelDensity(Math.min(2, window.devicePixelRatio || 1));
  WHITE = color(255);
  setBaseColor(SEED_COLOR);
  wireUI();
  lastMs = millis();
  // boids are spawned the first time we enter the canvas screen, by which
  // point the canvas is guaranteed to be at its real viewport size.
}

// Keep the canvas locked to the viewport. Boid positions are rescaled with it
// so a rotation / URL-bar collapse doesn't strand the flock off-screen or
// bunched in a corner.
function windowResized() {
  const ow = width, oh = height;
  resizeCanvas(windowWidth, windowHeight);
  if (ow > 1 && oh > 1) {
    for (const b of boids) {
      b.pos.x *= width / ow;
      b.pos.y *= height / oh;
    }
  }
}

function initBoids() {
  boids = [];
  for (let i = 0; i < NUM_BOIDS; i++) {
    boids.push(new Boid(random(width), random(height)));
  }
}

// picker hex -> base p5.Color (rim) + lightened-toward-white (centre), and the
// --accent CSS var the SIGNAL ring + slider thumb pick up.
function setBaseColor(hex) {
  baseColor = color(hex);
  centerColor = lerpColor(baseColor, WHITE, CENTER_LIGHTEN);
  document.documentElement.style.setProperty('--accent', hex);
}

// ---- UI wiring ----
function wireUI() {
  shapeHintEl = document.getElementById('shape-hint');

  document.getElementById('save-btn').addEventListener('click', () => {
    appState = 'canvas';
    shakeEnergy = 0; // shaping motion must not carry into idle movement
    lastShakeAt = -Infinity;
    document.body.classList.remove('state-shape');
    document.body.classList.add('state-canvas');
    initBoids();
  });

  signalEl = document.getElementById('signal');
  // Pointer capture is essential here: while the user shakes the phone with
  // their thumb still on SIGNAL, the touch point can easily drift outside
  // the button's small hit area for a moment. Without capture that fires
  // pointerleave and releases (bakes in) almost instantly, before any real
  // shake has accumulated -- SIGNAL would appear to "do nothing". Capture
  // keeps the button receiving events for this pointer regardless of where
  // it physically wanders until a real pointerup/cancel ends the gesture.
  const press = (e) => {
    e.preventDefault();
    if (signalPointerId !== null) return;
    signalPointerId = e.pointerId;
    signalEl.setPointerCapture(e.pointerId);
    shakeEnergy = 0;
    lastShakeAt = -Infinity; // idle shaking must not contribute to fading
    signaling = true;
    signalEl.classList.add('on');
  };
  const release = (e) => {
    if (signalPointerId === null || (e && e.pointerId !== signalPointerId)) return;
    signalPointerId = null;
    signaling = false;
    lastShakeAt = -Infinity;
    signalEl.classList.remove('on');
    signalEl.style.setProperty('--level', (1 - blobOpacity).toFixed(3));
  };
  signalEl.addEventListener('pointerdown', press);
  signalEl.addEventListener('pointerup', release);
  signalEl.addEventListener('pointercancel', release);
  signalEl.addEventListener('lostpointercapture', release);

  const tab = document.getElementById('panel-tab');
  tab.addEventListener('click', () => document.body.classList.toggle('panel-open'));

  const picker = document.getElementById('color-input');
  picker.value = SEED_COLOR;
  picker.addEventListener('input', () => setBaseColor(picker.value));

  const size = document.getElementById('size-input');
  size.value = blobSize;
  size.addEventListener('input', () => { blobSize = +size.value; });

  document.getElementById('reset-btn').addEventListener('click', () => {
    initBoids();
    blobOpacity = 1;
    signalEl.style.setProperty('--level', 0);
    shakeEnergy = 0;
    lastShakeAt = -Infinity;
  });

  // iOS 13+ gates devicemotion behind an explicit permission call that WebKit
  // only reliably honours (shows the OS prompt) when invoked directly inside
  // a real `click` handler on a button -- a generic `pointerdown` on window
  // is not trusted the same way and silently no-ops. So this is a dedicated
  // button tap, not a passive first-touch listener.
  motionBtnEl = document.getElementById('motion-btn');
  motionStatusEl = document.getElementById('motion-status');
  const DME = window.DeviceMotionEvent;
  if (DME && typeof DME.requestPermission === 'function') {
    motionStatus = 'needs-permission';
    motionBtnEl.addEventListener('click', startMotion);
  } else if (DME) {
    // no permission gate on this browser (e.g. Android) -- attach right away
    motionStatus = 'granted';
    window.addEventListener('devicemotion', onMotion);
  } else {
    motionStatus = 'unsupported';
  }
  updateMotionUI();
}

// ---- motion sensor (drives shape spikes and held-shake opacity) ----
function startMotion() {
  const DME = window.DeviceMotionEvent;
  motionStatus = 'requesting';
  updateMotionUI();
  DME.requestPermission()
    .then((state) => {
      if (state === 'granted') {
        motionStatus = 'granted';
        window.addEventListener('devicemotion', onMotion);
      } else {
        motionStatus = 'denied';
      }
      updateMotionUI();
    })
    .catch(() => { motionStatus = 'denied'; updateMotionUI(); });
}

// Reflects motionStatus (+ whether any devicemotion event has actually
// arrived yet) into the shape screen's status line and shows/hides the
// permission button -- this is the only window we get into what's actually
// happening with the sensor on a real phone, so keep it visible always.
function updateMotionUI() {
  if (motionBtnEl) {
    motionBtnEl.style.display = (motionStatus === 'needs-permission' || motionStatus === 'requesting') ? 'inline-flex' : 'none';
  }
  if (!motionStatusEl) return;
  const label = {
    'needs-permission': 'tap "enable motion" below, then shake',
    requesting: 'requesting motion access…',
    granted: motionSeen ? 'motion: live' : 'motion allowed -- shake now',
    denied: 'motion denied -- Settings > Safari > Motion & Orientation Access, then reload. dragging works meanwhile.',
    unsupported: 'no motion sensor on this browser -- drag to shake instead',
  }[motionStatus] || '';
  motionStatusEl.textContent = label;
}

function onMotion(e) {
  const a = e.accelerationIncludingGravity || e.acceleration;
  if (!a) return;
  if (!motionSeen) { motionSeen = true; updateMotionUI(); }
  if (lastAccel) {
    const dx = (a.x || 0) - lastAccel.x;
    const dy = (a.y || 0) - lastAccel.y;
    const dz = (a.z || 0) - lastAccel.z;
    const jolt = Math.sqrt(dx * dx + dy * dy + dz * dz) - SHAKE_DEADZONE;
    if (jolt > 0) {
      shakeEnergy = Math.min(SHAKE_FULL * 1.4, shakeEnergy + jolt * SHAKE_GAIN);
      lastShakeAt = millis();
    }
  }
  lastAccel = { x: a.x || 0, y: a.y || 0, z: a.z || 0 };
}

// Desktop / no-sensor stand-in: drag across the canvas to "shake".
function mouseDragged() {
  if (motionSeen || appState !== 'shape') return;
  if (dragLast) {
    const j = Math.hypot(mouseX - dragLast.x, mouseY - dragLast.y);
    if (j > 0) {
      shakeEnergy = Math.min(SHAKE_FULL * 1.4, shakeEnergy + j * 0.012);
      lastShakeAt = millis();
    }
  }
  dragLast = { x: mouseX, y: mouseY };
}

function mouseReleased() {
  dragLast = null;
}

// ---- main loop ----
function draw() {
  // catch a resize event p5 may have missed (e.g. tab shown after load)
  if (width !== windowWidth || height !== windowHeight) windowResized();

  const now = millis();
  let dt = (now - lastMs) / 1000;
  lastMs = now;
  dt = Math.min(dt, 0.05);

  // shake energy always bleeds back toward rest, on either screen
  shakeEnergy = Math.max(0, shakeEnergy - SHAKE_DECAY * dt);

  if (appState === 'shape') {
    drawShapeScreen(dt);
    return;
  }

  drawCanvasScreen(dt);
}

function drawShapeScreen(dt) {
  background(BACKGROUND_COLOR);

  const target = constrain(shakeEnergy / SHAKE_FULL, 0, 1);
  shapeLevel += (target - shapeLevel) * Math.min(1, dt * SHAPE_LEVEL_EASE);

  const numSpikes = Math.round(lerp(0, SHAPE_MAX_SPIKES, shapeLevel));
  const spikeAmp = lerp(0, SHAPE_MAX_AMP, shapeLevel);
  chosenShapeSpec = { numSpikes, spikeAmp };

  const cx = width / 2, cy = height / 2;
  const R = Math.min(width, height) * 0.30;
  const ctx = drawingContext;
  pathForBlob(ctx, cx, cy, R, numSpikes, spikeAmp, frameCount * 0.002);
  fillGradientBlob(ctx, cx, cy, R, spikeAmp, centerColor, baseColor);

  if (frameCount % 6 === 0 && shapeHintEl) {
    shapeHintEl.textContent = numSpikes === 0 ? 'smooth circle' : numSpikes + ' spikes';
  }
}

function drawCanvasScreen(dt) {
  if (!boids.length) initBoids();

  noiseAccum += NOISE_BASE;
  const shaking = millis() - lastShakeAt < SHAKE_ACTIVE_WINDOW_MS;
  if (signaling && shaking) {
    blobOpacity = Math.max(0, blobOpacity - dt / FADE_SECONDS);
  }
  signalEl.style.setProperty('--level', (1 - blobOpacity).toFixed(3));

  background(BACKGROUND_COLOR);

  for (const b of boids) b.wander(noiseAccum);
  for (const b of boids) b.applyAttraction(boids, attraction);
  for (const b of boids) b.update();
  resolveSeparation(boids);

  drawingContext.save();
  drawingContext.globalAlpha = blobOpacity;
  noStroke();
  for (const b of boids) b.renderGlow();
  for (const b of boids) b.renderOrb();
  drawingContext.restore();
}

// HARD floor on boid spacing -- the actual guarantee that boids never
// visually fuse, regardless of how fast wander + attraction move them
// toward each other in a single frame. Runs after update(), so it also
// re-clamps to canvas.
function resolveSeparation(all) {
  const minSep = SEPARATION_FACTOR * blobSize;
  for (let it = 0; it < SEPARATION_ITERS; it++) {
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i], b = all[j];
        let dx = b.pos.x - a.pos.x, dy = b.pos.y - a.pos.y;
        let d = Math.hypot(dx, dy);
        if (d >= minSep) continue;
        if (d < 1e-4) { dx = 1; dy = 0; d = 1e-4; }
        const push = (minSep - d) / 2;
        const ux = dx / d, uy = dy / d;
        a.pos.x -= ux * push; a.pos.y -= uy * push;
        b.pos.x += ux * push; b.pos.y += uy * push;
      }
    }
  }
  const r = blobSize;
  for (const o of all) {
    o.pos.x = constrain(o.pos.x, r, width - r);
    o.pos.y = constrain(o.pos.y, r, height - r);
  }
}

// ---- shared shape drawing (shape-screen preview + every boid) ----
function pathForBlob(ctx, cx, cy, baseRadius, numSpikes, spikeAmp, rotation) {
  ctx.beginPath();
  for (let i = 0; i <= SHAPE_SEGMENTS; i++) {
    const theta = (i / SHAPE_SEGMENTS) * TWO_PI + rotation;
    const bump = (spikeAmp > 0 && numSpikes > 0)
      ? Math.pow(Math.max(0, Math.cos(numSpikes * theta)), SHAPE_SPIKE_SHARPNESS)
      : 0;
    const r = baseRadius * (1 + spikeAmp * bump);
    const x = cx + Math.cos(theta) * r;
    const y = cy + Math.sin(theta) * r;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function fillGradientBlob(ctx, cx, cy, baseRadius, spikeAmp, centerCol, rimCol) {
  const outer = baseRadius * (1 + spikeAmp);
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, outer);
  grad.addColorStop(0, `rgb(${red(centerCol)}, ${green(centerCol)}, ${blue(centerCol)})`);
  grad.addColorStop(1, `rgb(${red(rimCol)}, ${green(rimCol)}, ${blue(rimCol)})`);
  ctx.fillStyle = grad;
  ctx.fill();
}

class Boid {
  constructor(x, y) {
    this.pos = createVector(x, y);
    this.autoVel = createVector(0, 0);
    this.attractForce = createVector(0, 0);
    // per-individual seeds so paths, breathing and spike facing never fall
    // into sync.
    this.noiseSeed = random(1000);
    this.pulsePhase = random(1000);
    this.rotationOffset = random(TWO_PI);
  }

  // AUTONOMOUS -- velocity is the difference of two Perlin channels per axis
  // (this boid's own seed + the shared wander clock), plus a soft steer away
  // from the canvas edges. No reference to any other boid.
  wander(nz) {
    const [o0, o1, o2, o3] = WANDER_NOISE_OFFSETS;
    let vx = noise(this.noiseSeed + o0, nz) - noise(this.noiseSeed + o1, nz);
    let vy = noise(this.noiseSeed + o2, nz) - noise(this.noiseSeed + o3, nz);

    const m = EDGE_MARGIN;
    if (this.pos.x < m)          vx += EDGE_STEER * (1 - this.pos.x / m);
    if (this.pos.x > width - m)  vx -= EDGE_STEER * (1 - (width - this.pos.x) / m);
    if (this.pos.y < m)          vy += EDGE_STEER * (1 - this.pos.y / m);
    if (this.pos.y > height - m) vy -= EDGE_STEER * (1 - (height - this.pos.y) / m);

    this.autoVel.set(vx, vy);
    if (this.autoVel.magSq() > 1e-6) this.autoVel.setMag(MOVE_BASE_PX);
  }

  // Pull toward every other boid within reach, scaled by the fixed
  // `attraction` level, plus a small always-on anti-collapse core so boids
  // never fully overlap however strong the attraction.
  applyAttraction(all, currentAttraction) {
    this.attractForce.set(0, 0);
    const reach = blobSize * ATTRACT_FACTOR;
    const core = blobSize * ATTRACT_CORE_FACTOR;
    for (const other of all) {
      if (other === this) continue;
      const dx = other.pos.x - this.pos.x;
      const dy = other.pos.y - this.pos.y;
      const d = Math.hypot(dx, dy);
      if (d < 1e-4) continue;
      const ux = dx / d, uy = dy / d;

      if (currentAttraction > 0 && d < reach) {
        const pull = currentAttraction * ATTRACT_GAIN * (1 - d / reach);
        this.attractForce.x += ux * pull;
        this.attractForce.y += uy * pull;
      }
      if (d < core) {
        const push = ATTRACT_CORE_GAIN * (1 - d / core);
        this.attractForce.x -= ux * push;
        this.attractForce.y -= uy * push;
      }
    }
  }

  update() {
    this.pos.x += this.autoVel.x + this.attractForce.x;
    this.pos.y += this.autoVel.y + this.attractForce.y;
    const r = blobSize;
    this.pos.x = constrain(this.pos.x, r, width - r);
    this.pos.y = constrain(this.pos.y, r, height - r);
  }

  _outerRadius() {
    const pulse = 1 + PULSE_AMP * (noise(this.pulsePhase, frameCount * 0.01 * PULSE_RATE) * 2 - 1);
    return blobSize * pulse;
  }

  // faint wide halo -- all glows are drawn before any rings so a neighbour's
  // halo never dims another orb's core.
  renderGlow() {
    const outer = this._outerRadius();
    fill(red(baseColor), green(baseColor), blue(baseColor), 18);
    circle(this.pos.x, this.pos.y, outer * 2.8);
  }

  // the population's chosen shape, filled with a smooth radial gradient from
  // the centre (lightened) out to the rim (base colour).
  renderOrb() {
    const outer = this._outerRadius();
    const ctx = drawingContext;
    pathForBlob(ctx, this.pos.x, this.pos.y, outer,
      chosenShapeSpec.numSpikes, chosenShapeSpec.spikeAmp, this.rotationOffset);
    fillGradientBlob(ctx, this.pos.x, this.pos.y, outer, chosenShapeSpec.spikeAmp, centerColor, baseColor);
  }
}
