// orbmerge-mobile -- one flock of layered "orb" boids, sized for a phone screen.
//
// Ported from ../orbmerge with the multi-population metaball MERGE removed:
// here there is a SINGLE flock and boids DO NOT fuse when they overlap -- each
// boid is always a crisp layered bullseye that simply passes over its
// neighbours. Two control channels, both physical:
//
//   PARAM 1 -- repulsion between boids -- the neumorphic PUSH pad, bottom-left.
//     Each tap adds an impulse to `repulsion`, which bleeds back toward 0 every
//     frame. At rest the boids drift through each other freely; mash the pad
//     and they shove apart; stop and they drift back together. Holding the
//     flock open is an ongoing gesture, not a set-and-forget slider. The ring
//     under the pad shows the current `repulsion` level.
//
//   PARAM 2 -- speed -- the phone's motion sensor.
//     `devicemotion` acceleration deltas feed a decaying `shakeEnergy`, which
//     maps to a global speed multiplier on the wander walk: a gentle tilt is a
//     slow drift, a hard shake is frantic. iOS only hands over the sensor
//     after a user gesture (the start overlay) and only over https; where no
//     sensor reports in, dragging on the canvas stands in for a shake.
//
//   Side panel (right edge, collapsible): base colour + blob size.
//
// AUTONOMOUS vs LIVE, same split as the original: wander() is a fixed per-boid
// Perlin walk that never reads a sensor; repulsion / speed / size / colour are
// the live channels.

// ---- fixed config ----
const NUM_BOIDS  = 35;
const SEED_COLOR = '#49b6ff';

// smooth radial gradient -- base colour on the rim, lightening toward white
// at the centre.
const CENTER_LIGHTEN = 0.66;

// ---- autonomous wander (fixed, never sensor-exposed) ----
const MOVE_BASE_PX = 1.9;    // px/frame at speed multiplier 1
const NOISE_BASE   = 0.006;  // wander-clock advance per frame at multiplier 1
// vx = noise(seed+off0) - noise(seed+off1), vy likewise -- a difference of two
// noise samples is zero-mean whatever noise()'s own mean is, so no net drift.
const WANDER_NOISE_OFFSETS = [0, 2113, 4229, 6337];
const EDGE_MARGIN = 90;
const EDGE_STEER  = 2.8;

// cosmetic per-orb breathing
const PULSE_AMP  = 0.05;
const PULSE_RATE = 0.9;

// ---- PARAM 1: intra-flock repulsion (the PUSH pad) ----
const REPEL_FACTOR  = 2.8;   // reach = REPEL_FACTOR * blobSize
const REPEL_GAIN    = 0.7;   // px/frame at contact, per unit of `repulsion`
const REPEL_MAX     = 5;     // ceiling on `repulsion`
const REPEL_PER_TAP = 1.5;   // added to `repulsion` per press
const REPEL_DECAY   = 2.2;   // units/second bled off toward 0

// ---- PARAM 2: speed from motion ----
const SPEED_MIN      = 0.5;   // resting drift (never fully still)
const SPEED_MAX      = 3.0;   // full-shake frenzy
const SHAKE_GAIN     = 0.05;  // accel-delta magnitude -> energy (per motion event)
const SHAKE_DEADZONE = 0.7;   // ignore resting hand jitter (delta below this)
const SHAKE_DECAY    = 2.0;   // energy bled off per second
const SHAKE_FULL     = 4.0;   // energy that maps to SPEED_MAX
const SPEED_EASE     = 5;     // speedMul approach rate (per second)

// ---- live params ----
let blobSize = 42;

// ---- state ----
let boids = [];
let baseColor;
let centerColor;
let WHITE;
let noiseAccum = 0;

let repulsion   = 0;
let shakeEnergy = 0;
let speedMul    = SPEED_MIN;

let lastMs = 0;
let lastAccel = null;
let motionSeen = false;

let pulseEl;
let dragLast = null;

function setup() {
  const cnv = createCanvas(windowWidth, windowHeight);
  cnv.parent('canvas-holder');
  pixelDensity(Math.min(2, window.devicePixelRatio || 1));
  WHITE = color(255);
  setBaseColor(SEED_COLOR);
  wireUI();
  lastMs = millis();
  // boids are spawned on the first draw() frame, by which point the canvas is
  // guaranteed to be at its real viewport size (some mobile browsers finish
  // layout a beat after setup()).
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
// --accent CSS var the PUSH ring + slider thumb pick up.
function setBaseColor(hex) {
  baseColor = color(hex);
  centerColor = lerpColor(baseColor, WHITE, CENTER_LIGHTEN);
  document.documentElement.style.setProperty('--accent', hex);
}

// ---- UI wiring ----
function wireUI() {
  pulseEl = document.getElementById('pulse');
  const press = (e) => { e.preventDefault(); onPush(); pulseEl.classList.add('on'); };
  const release = () => pulseEl.classList.remove('on');
  pulseEl.addEventListener('pointerdown', press);
  pulseEl.addEventListener('pointerup', release);
  pulseEl.addEventListener('pointercancel', release);
  pulseEl.addEventListener('pointerleave', release);

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
    repulsion = 0;
  });

  const overlay = document.getElementById('start-overlay');
  overlay.addEventListener('click', () => {
    startMotion();
    overlay.classList.add('hidden');
  });
}

function onPush() {
  repulsion = Math.min(REPEL_MAX, repulsion + REPEL_PER_TAP);
  if (navigator.vibrate) navigator.vibrate(8);
}

// ---- motion sensor (PARAM 2) ----
// iOS 13+ gates devicemotion behind an explicit permission call that must run
// inside a user gesture -- hence the start overlay. Elsewhere the listener just
// attaches.
function startMotion() {
  const DME = window.DeviceMotionEvent;
  if (DME && typeof DME.requestPermission === 'function') {
    DME.requestPermission()
      .then((state) => { if (state === 'granted') window.addEventListener('devicemotion', onMotion); })
      .catch(() => {});
  } else if (DME) {
    window.addEventListener('devicemotion', onMotion);
  }
}

function onMotion(e) {
  const a = e.accelerationIncludingGravity || e.acceleration;
  if (!a) return;
  motionSeen = true;
  if (lastAccel) {
    const dx = (a.x || 0) - lastAccel.x;
    const dy = (a.y || 0) - lastAccel.y;
    const dz = (a.z || 0) - lastAccel.z;
    const jolt = Math.sqrt(dx * dx + dy * dy + dz * dz) - SHAKE_DEADZONE;
    if (jolt > 0) {
      shakeEnergy = Math.min(SHAKE_FULL * 1.4, shakeEnergy + jolt * SHAKE_GAIN);
    }
  }
  lastAccel = { x: a.x || 0, y: a.y || 0, z: a.z || 0 };
}

// Desktop / no-sensor stand-in: drag across the canvas to "shake".
function mouseDragged() {
  if (motionSeen) return;
  if (dragLast) {
    const j = Math.hypot(mouseX - dragLast.x, mouseY - dragLast.y);
    shakeEnergy = Math.min(SHAKE_FULL * 1.4, shakeEnergy + j * 0.012);
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

  if (!boids.length) initBoids();

  const now = millis();
  let dt = (now - lastMs) / 1000;
  lastMs = now;
  dt = Math.min(dt, 0.05);

  // both live impulses bleed back toward rest every frame
  repulsion   = Math.max(0, repulsion - REPEL_DECAY * dt);
  shakeEnergy = Math.max(0, shakeEnergy - SHAKE_DECAY * dt);

  const target = lerp(SPEED_MIN, SPEED_MAX, constrain(shakeEnergy / SHAKE_FULL, 0, 1));
  speedMul += (target - speedMul) * Math.min(1, dt * SPEED_EASE);

  noiseAccum += NOISE_BASE * speedMul;

  background(7, 7, 11);

  for (const b of boids) b.wander(noiseAccum);
  for (const b of boids) b.applyRepulsion(boids);
  for (const b of boids) b.update();

  noStroke();
  for (const b of boids) b.renderGlow();
  for (const b of boids) b.renderOrb();

  if (frameCount % 4 === 0) {
    pulseEl.style.setProperty('--level', constrain(repulsion / REPEL_MAX, 0, 1).toFixed(3));
  }
}

class Boid {
  constructor(x, y) {
    this.pos = createVector(x, y);
    this.autoVel = createVector(0, 0);
    this.repelForce = createVector(0, 0);
    // per-individual seeds so paths and breathing never fall into sync.
    this.noiseSeed = random(1000);
    this.pulsePhase = random(1000);
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
    if (this.autoVel.magSq() > 1e-6) this.autoVel.setMag(MOVE_BASE_PX * speedMul);
  }

  // PARAM 1 -- push away from every other boid within reach, scaled by the live
  // `repulsion` level. Zero when the pad hasn't been tapped recently.
  applyRepulsion(all) {
    this.repelForce.set(0, 0);
    if (repulsion <= 0) return;
    const reach = blobSize * REPEL_FACTOR;
    for (const other of all) {
      if (other === this) continue;
      const dx = this.pos.x - other.pos.x;
      const dy = this.pos.y - other.pos.y;
      const d = Math.hypot(dx, dy);
      if (d >= reach || d < 1e-4) continue;
      const push = repulsion * REPEL_GAIN * (1 - d / reach);
      this.repelForce.x += (dx / d) * push;
      this.repelForce.y += (dy / d) * push;
    }
  }

  update() {
    this.pos.x += this.autoVel.x + this.repelForce.x;
    this.pos.y += this.autoVel.y + this.repelForce.y;
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

  // one disc, filled with a smooth radial gradient from the centre (lightened)
  // out to the rim (base colour) -- a continuous falloff, no banded rings.
  renderOrb() {
    const outer = this._outerRadius();
    const ctx = drawingContext;
    const grad = ctx.createRadialGradient(this.pos.x, this.pos.y, 0, this.pos.x, this.pos.y, outer);
    grad.addColorStop(0, `rgb(${red(centerColor)}, ${green(centerColor)}, ${blue(centerColor)})`);
    grad.addColorStop(1, `rgb(${red(baseColor)}, ${green(baseColor)}, ${blue(baseColor)})`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(this.pos.x, this.pos.y, outer, 0, TWO_PI);
    ctx.fill();
  }
}
