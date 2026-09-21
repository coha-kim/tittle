// orbmerge-mobile -- shape your population, then set it loose.
//
// Two screens, one shared devicemotion channel reused per screen:
//
//   SHAPE screen -- a single preview blob. Shake energy drives both the
//     spike COUNT and spike SHARPNESS of a polygon, from a smooth circle at
//     rest up toward a many-pointed spiky shape under a hard shake. Whatever
//     shape is live when SAVE is tapped becomes the population's shape --
//     every boid on the canvas screen renders with it (own rotation only).
//
//   CANVAS screen -- the flock, each boid rendered in the chosen shape.
//     Boids have a constant idle mutual ATTRACTION (gentle clustering) plus a
//     small always-on anti-collapse core so they never fully overlap.
//     Holding SIGNAL redirects the shake channel (which otherwise drives
//     wander speed) into a LIVE PREVIEW of that attraction: shake harder and
//     it weakens in real time. Releasing SIGNAL bakes whatever value was live
//     at that instant in as the new resting attraction.
//
// AUTONOMOUS vs LIVE, same split as the original: wander() is a fixed
// per-boid Perlin walk that never reads a sensor; shape, attraction, speed,
// size and colour are the live channels.

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

// ---- shape screen: shake -> spike count + sharpness ----
const SHAPE_SEGMENTS      = 64;   // vertices traced per blob outline
const SHAPE_MAX_SPIKES    = 10;   // spike count at full shake
const SHAPE_MAX_AMP       = 0.55; // spike height as a fraction of base radius, at full shake
const SHAPE_SPIKE_SHARPNESS = 3.5; // higher = narrower, more pointed spikes
const SHAPE_LEVEL_EASE    = 6;    // preview smoothing rate (per second)

// ---- PARAM 1: mutual attraction between boids ----
const ATTRACTION_IDLE    = 1.2;   // resting attraction -- gentle clustering
const ATTRACTION_MIN     = 0.05;  // weakest attraction a full shake can dial down to
const ATTRACT_FACTOR     = 3.4;   // reach = ATTRACT_FACTOR * blobSize
const ATTRACT_GAIN       = 0.55;  // px/frame at contact, per unit of attraction
const ATTRACT_CORE_FACTOR = 0.95; // anti-collapse core radius = this * blobSize, always on
const ATTRACT_CORE_GAIN   = 1.6;  // px/frame max core repel at full overlap

// ---- PARAM 2: speed from motion (only live when SIGNAL isn't held) ----
const SPEED_MIN      = 0.5;   // resting drift (never fully still)
const SPEED_MAX      = 3.0;   // full-shake frenzy
const SHAKE_GAIN     = 0.05;  // accel-delta magnitude -> energy (per motion event)
const SHAKE_DEADZONE = 0.7;   // ignore resting hand jitter (delta below this)
const SHAKE_DECAY    = 2.0;   // energy bled off per second
const SHAKE_FULL     = 4.0;   // energy that maps to SPEED_MAX / full shape spikiness / min attraction
const SPEED_EASE     = 5;     // speedMul approach rate (per second)

// ---- live params ----
let blobSize = 42;
let attraction = ATTRACTION_IDLE;
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
let speedMul    = SPEED_MIN;
let signaling   = false;
let liveAttraction = ATTRACTION_IDLE;

let lastMs = 0;
let lastAccel = null;
let motionSeen = false;

let signalEl;
let shapeHintEl;
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
    document.body.classList.remove('state-shape');
    document.body.classList.add('state-canvas');
    initBoids();
  });

  signalEl = document.getElementById('signal');
  const press = (e) => { e.preventDefault(); signaling = true; signalEl.classList.add('on'); };
  const release = () => {
    if (signaling) {
      attraction = liveAttraction;
      shakeEnergy = 0;
    }
    signaling = false;
    signalEl.classList.remove('on');
    signalEl.style.setProperty('--level', 0);
  };
  signalEl.addEventListener('pointerdown', press);
  signalEl.addEventListener('pointerup', release);
  signalEl.addEventListener('pointercancel', release);
  signalEl.addEventListener('pointerleave', release);

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
    attraction = ATTRACTION_IDLE;
  });

  // iOS 13+ gates devicemotion behind an explicit permission call that must
  // run inside a user gesture -- the first tap anywhere kicks it off, with no
  // separate loading screen in the way.
  window.addEventListener('pointerdown', startMotion, { once: true });
}

// ---- motion sensor (drives shape spikes / speed / live attraction, depending on screen+mode) ----
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
  background(7, 7, 11);

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

  if (!signaling) {
    const target = lerp(SPEED_MIN, SPEED_MAX, constrain(shakeEnergy / SHAKE_FULL, 0, 1));
    speedMul += (target - speedMul) * Math.min(1, dt * SPEED_EASE);
  }
  noiseAccum += NOISE_BASE * speedMul;

  if (signaling) {
    const shakeLevel = constrain(shakeEnergy / SHAKE_FULL, 0, 1);
    liveAttraction = lerp(ATTRACTION_IDLE, ATTRACTION_MIN, shakeLevel);
    signalEl.style.setProperty('--level', shakeLevel.toFixed(3));
  }
  const currentAttraction = signaling ? liveAttraction : attraction;

  background(7, 7, 11);

  for (const b of boids) b.wander(noiseAccum);
  for (const b of boids) b.applyAttraction(boids, currentAttraction);
  for (const b of boids) b.update();

  noStroke();
  for (const b of boids) b.renderGlow();
  for (const b of boids) b.renderOrb();
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
    if (this.autoVel.magSq() > 1e-6) this.autoVel.setMag(MOVE_BASE_PX * speedMul);
  }

  // PARAM 1 -- pull toward every other boid within reach, scaled by the live
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
