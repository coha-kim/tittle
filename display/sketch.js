// orbmerge -- layered concentric-circle "orbs" for multiple populations, with a
// temporary, fully-reversible metaball MERGE where individuals from DIFFERENT
// populations meet.
//
// Two logic domains are kept deliberately separate -- this boundary is what
// later sensor mapping depends on:
//
//   AUTONOMOUS (fixed, never sensor-exposed) -- Orb.wander()
//     Each orb wanders on its OWN Perlin-noise walk (seeded per orb). Nothing
//     an orb does here depends on any other orb -- there is no intra-population
//     flocking or alignment. Movement SPEED is per population (see speedByPop);
//     the noise walk itself is fixed.
//
//   INTER-POPULATION (sensor-exposed: per-population attractionStrength; also
//   overallSize / per-population speed / colour) -- Orb.applyCrossPopulationForces()
//     attractionStrength is set by the PULLED orb's own population, so it can be
//     asymmetric (pop 1 can chase the others harder than they chase it), and it
//     sweeps that population's contact with the others from a clean BOUNCE (weak
//     -- a firm repulsion shell held outside metaball fusion range) to a MERGE
//     (strong -- the shell recedes and attraction pulls orbs deep enough to
//     fuse). Proximity also sets each orb's `mergeAmount` (0..1) for the render;
//     move apart and it falls straight back to 0 -- no retained state, no bond.
//
// RENDER: every orb goes through a real metaball pipeline, ONE PASS. Each orb
// is drawn as a single disc filled with a smooth radial gradient (base colour
// at the rim, lightened toward white at the centre -- a continuous falloff,
// not discrete bands), all into one offscreen buffer. That buffer is then
// blitted onto the canvas through an SVG "goo" filter -- a Gaussian blur
// followed by a steep alpha step (feColorMatrix). The blur makes nearby discs'
// fields overlap and their gradients blend; the alpha step is a HARD threshold
// on the SHAPE only (colour channels pass through untouched), so overlapping
// discs fuse into a single shape with a genuine neck and a crisp iso-surface
// edge -- no soft halo bleeding into the background. A lone orb thresholds
// straight back to a clean hard-edged disc with a smooth gradient inside it.
// Where two different-population discs overlap in the neck, the blur mixes
// their gradients, so the bridge is a smooth blend, not an alpha overlay.
// The field disc size is FIXED (FIELD_REACH) -- a lone orb is always the same
// size whatever its attractionStrength; fusion is gated by the physics letting
// orbs get close, not by inflating the discs.
//
// Each population has its own `speed` slider: it scales that population's
// wander-clock advance and its per-frame step size (see speedByPop).

// ---- fixed config (set at init, NOT live-adjustable) ----
const CANVAS_W = 1024;
const CANVAS_H = 600;
const POP_COUNT = 3;
const INDIVIDUALS_PER_POP = 5;
const POP_SEED_COLORS = ['#ff4d6d', '#49b6ff', '#ffcc4d']; // rose / azure / amber

// ---- orb shape ----
// Each orb is one disc at this radius (as a fraction of overallSize), filled
// with a smooth radial gradient: base colour at the rim, lerped toward white
// at the centre. "base outward, lighten inward only" -- the rim is exactly the
// base colour and the centre is the lightest point; nothing is darker than
// the base colour.
const OUTER_RATIO = 1.00;
const CENTER_LIGHTEN = 0.66;

// ---- autonomous wander (fixed) ----
const MOVE_BASE_PX = 2.0;    // px/frame at speed 1
const NOISE_BASE   = 0.006;  // wander-time advance per frame at speed 1
// vx = noise(seed+off0) - noise(seed+off1), vy likewise with off2/off3. Four
// far-apart offsets so the channels are mutually decorrelated; a difference of
// two noise samples is zero-mean whatever noise()'s own mean is (see wander()).
const WANDER_NOISE_OFFSETS = [0, 2113, 4229, 6337];
const EDGE_MARGIN  = 110;
const EDGE_STEER   = 2.6;

// ---- inter-population forces (attractionStrengthByPop is the exposed param) ----
// Radii scale with overallSize so the behaviour looks the same at any orb size.
//
// attractionStrength sweeps a population's cross-population contact from a clean
// BOUNCE to a MERGE:
//   weak  -> a firm repulsion shell sits OUTSIDE metaball fusion range, so
//            different-population orbs deflect off each other and never fuse.
//   strong-> the shell recedes to a small anti-collapse core AND attraction
//            pulls orbs deep past fusion range, so a fat coloured neck forms.
// mergeT in [0,1] is how far along that sweep this population sits (0 below
// MERGE_THRESHOLD, 1 at ATTR_MAX); it lerps both the shell radius and its gain.
const MERGE_THRESHOLD    = 0.6;   // attractionStrength at/below this = pure bounce, no merge
const INTERACTION_FACTOR = 2.6;   // attraction reaches this * overallSize
const MERGE_FULL_FACTOR  = 1.4;   // mergeAmount reaches 1 at this * overallSize (deep overlap)
const ATTRACT_BASE   = 0.09;      // px/frame per unit attractionStrength, at contact
const REPEL_DIST_BOUNCE = 2.8;    // soft-shell onset at mergeT 0 (* overallSize) -- beyond fusion range
const REPEL_DIST_MERGE  = 1.3;    // soft-shell onset at mergeT 1 (* overallSize) -- anti-collapse core only
const REPULSION_BOUNCE  = 3.0;    // px/frame max soft repel at mergeT 0 -- cushions the approach
const REPULSION_MERGE   = 0.9;    // px/frame max soft repel at mergeT 1 -- a light cushion
// HARD floor on different-population spacing, enforced as a position correction
// (resolveCrossPopulationSeparation). This is the actual guarantee that a weak
// pair BOUNCES: at mergeT 0 it holds them BOUNCE_SEPARATION * overallSize apart,
// just outside metaball fusion range; it shrinks to 0 as mergeT -> 1 so strong
// pairs are free to overlap and MERGE. The soft shell above just smooths it.
const BOUNCE_SEPARATION  = 2.5;   // * overallSize, at mergeT 0
const SEPARATION_ITERS   = 2;     // relaxation passes per frame (keeps 3-population shoves stable)

// ---- metaball merge rendering ----
// The goo filter runs at BUFFER resolution (cheap), then the thresholded layer
// is scaled up to the canvas with a plain bilinear blit -- that upscale also
// lends the hard iso-surface a slightly organic softness for free.
const MERGE_BUFFER_SCALE = 0.5;  // offscreen buffer res vs canvas (lower = cheaper; try 0.4 on a Pi)
const GOO_BLUR        = 5;        // SVG feGaussianBlur stdDeviation, in buffer px -- the field softness
const GOO_ALPHA_GAIN  = 16;      // feColorMatrix alpha slope -> iso-surface edge hardness (higher = harder)
const GOO_ALPHA_BIAS  = -6;      // feColorMatrix alpha offset -> where the threshold sits
// Disc radius fed into the field = ring radius * FIELD_REACH constant. This is
// FIXED -- an isolated orb is always the same size. Whether two orbs FUSE is
// decided purely by how close the physics (attraction vs the repulsion shell,
// see applyCrossPopulationForces) lets them get, not by inflating the discs.
const FIELD_REACH = 1.10;
const ATTR_MAX = 4;              // attraction slider max; the per-population sliders use this directly

// 0 at/below MERGE_THRESHOLD (pure bounce), ramping to 1 at ATTR_MAX (full
// merge). Drives the repulsion shell, the hard separation floor, and the
// render's mergeAmount, so one number moves a population along bounce<->merge.
function mergeTFor(pop) {
  return constrain((attractionStrengthByPop[pop] - MERGE_THRESHOLD) / (ATTR_MAX - MERGE_THRESHOLD), 0, 1);
}

// ---- live params (sliders now; updateParamsFromSensor() later) ----
let overallSize = 52;
// per-population, indexed by pop. Attraction on an orb uses ITS OWN population's
// value, so pop 1 chasing pop 2 need not equal pop 2 chasing pop 1.
let attractionStrengthByPop = Array(POP_COUNT).fill(1.3);
let speedByPop = Array(POP_COUNT).fill(1.0);

let orbs = [];
let popColorPickers = [];
let popColors = [];              // live p5.Color per population (rim), refreshed each frame
let popCenterColors = [];        // live p5.Color per population (gradient centre), refreshed each frame
let levelBuffer;                 // gradient-filled orb discs are drawn here
let gooBuffer;                   // levelBuffer put through the goo filter, still at buffer res
let WHITE;

let noiseAccumByPop = Array(POP_COUNT).fill(0);  // advanced by each pop's speed -> wander time

let sliderRefs = {};
let fpsSpan;

const CONTROL_X = CANVAS_W + 40;
const ROW_H = 44;
const SECTION_GAP = 16;

function setup() {
  const holder = document.getElementById('canvas-holder');
  const cnv = createCanvas(CANVAS_W, CANVAS_H);
  cnv.parent(holder);
  WHITE = color(255);
  const bw = Math.round(CANVAS_W * MERGE_BUFFER_SCALE);
  const bh = Math.round(CANVAS_H * MERGE_BUFFER_SCALE);
  levelBuffer = createGraphics(bw, bh);
  gooBuffer = createGraphics(bw, bh);
  injectGooFilter();

  let y = 10;
  y = addSlider(CONTROL_X, y, { label: 'overallSize', min: 16, max: 104, step: 1 }, overallSize,
    (v) => { overallSize = v; }, 'overallSize');

  y = addSectionHeader(CONTROL_X, y, 'Movement speed (per population)');
  for (let p = 0; p < POP_COUNT; p++) {
    const pp = p;
    y = addSlider(CONTROL_X, y, { label: 'pop ' + (pp + 1) + ' speed', min: 0, max: 3, step: 0.05 },
      speedByPop[pp], (v) => { speedByPop[pp] = v; }, 'speed' + pp);
  }

  y = addSectionHeader(CONTROL_X, y, 'Attraction strength (per population)');
  for (let p = 0; p < POP_COUNT; p++) {
    const pp = p;
    y = addSlider(CONTROL_X, y, { label: 'pop ' + (pp + 1) + ' attraction', min: 0, max: ATTR_MAX, step: 0.05 },
      attractionStrengthByPop[pp], (v) => { attractionStrengthByPop[pp] = v; }, 'attract' + pp);
  }

  y = addSectionHeader(CONTROL_X, y, 'Population colours');
  for (let p = 0; p < POP_COUNT; p++) {
    const lab = createSpan('population ' + (p + 1));
    lab.parent('controls');
    lab.position(CONTROL_X, y + 3);
    const picker = createColorPicker(POP_SEED_COLORS[p]);
    picker.parent('controls');
    picker.position(CONTROL_X + 96, y);
    popColorPickers.push(picker);
    y += 30;
  }

  y += SECTION_GAP;
  const resetBtn = createButton('reset orbs');
  resetBtn.parent('controls');
  resetBtn.position(CONTROL_X, y);
  resetBtn.mousePressed(initOrbs);
  y += 34;

  fpsSpan = createSpan('fps: --');
  fpsSpan.parent('controls');
  fpsSpan.position(CONTROL_X, y);
  fpsSpan.style('color', '#888');

  initOrbs();

  console.log(
    `[orbmerge] ${POP_COUNT} populations x ${INDIVIDUALS_PER_POP} = ${orbs.length} orbs, ` +
    `single-pass radial-gradient discs. Metaball buffer ${levelBuffer.width}x${levelBuffer.height} ` +
    `(${MERGE_BUFFER_SCALE}x of canvas).\n` +
    `PERF: the render is 1 pass/frame -- an SVG goo-filter (Gaussian blur + alpha ` +
    `step) applied at BUFFER res, then a plain upscale to the canvas. SVG filters ` +
    `ARE GPU-accelerated in the Pi Chromium. Mitigations if needed, in order: lower ` +
    `MERGE_BUFFER_SCALE to ~0.4, then reduce orb counts.`
  );
}

// One labelled slider row at (x, y). Mirrors the value into a span and (when
// refKey is given) registers it so updateParamsFromSensor() can push external
// values back into the UI later.
function addSlider(x, y, def, initial, onChange, refKey) {
  const lab = createSpan(def.label);
  lab.parent('controls');
  lab.position(x, y);

  const valSpan = createSpan(String(initial));
  valSpan.parent('controls');
  valSpan.position(x + 196, y);
  valSpan.style('color', '#9ad');

  const slider = createSlider(def.min, def.max, initial, def.step);
  slider.parent('controls');
  slider.position(x, y + 17);
  slider.style('width', '185px');
  slider.input(() => {
    onChange(slider.value());
    valSpan.html(String(slider.value()));
  });

  if (refKey) sliderRefs[refKey] = { slider, valSpan, min: def.min, max: def.max };
  return y + ROW_H;
}

// A bold section label at (x, y). Returns the y below it.
function addSectionHeader(x, y, text) {
  y += SECTION_GAP;
  const h = createSpan(text);
  h.parent('controls');
  h.position(x, y);
  h.style('font-weight', 'bold');
  h.style('font-size', '13px');
  return y + 24;
}

function initOrbs() {
  orbs = [];
  const cx = width / 2, cy = height / 2;
  for (let p = 0; p < POP_COUNT; p++) {
    // Each population starts loosely gathered around its own point, so the
    // first cross-population contact is a genuine approach (a merge event)
    // rather than everything spawning in one pile.
    const a = (p / POP_COUNT) * TWO_PI - HALF_PI;
    const gx = cx + Math.cos(a) * width * 0.28;
    const gy = cy + Math.sin(a) * height * 0.28;
    for (let i = 0; i < INDIVIDUALS_PER_POP; i++) {
      orbs.push(new Orb(
        constrain(gx + random(-70, 70), 60, width - 60),
        constrain(gy + random(-70, 70), 60, height - 60),
        p));
    }
  }
}

// STUB -- later WebSocket / sensor rig. Only the sensor-controllable params are
// reachable here (per-population attractionStrength + speed, overallSize,
// colours); the autonomous wander constants are intentionally out of reach.
// speeds / attractionStrengths are arrays indexed by population; undefined or
// missing entries are left untouched.
function updateParamsFromSensor(data) {
  if (data.overallSize !== undefined) setParam('overallSize', data.overallSize, (v) => { overallSize = v; });
  if (Array.isArray(data.speeds)) data.speeds.forEach((s, p) => {
    if (p < POP_COUNT && s !== undefined) setParam('speed' + p, s, (v) => { speedByPop[p] = v; });
  });
  if (Array.isArray(data.attractionStrengths)) data.attractionStrengths.forEach((a, p) => {
    if (p < POP_COUNT && a !== undefined) setParam('attract' + p, a, (v) => { attractionStrengthByPop[p] = v; });
  });
  if (Array.isArray(data.colors)) {
    data.colors.forEach((hex, i) => { if (popColorPickers[i] && hex) popColorPickers[i].value(hex); });
  }
}

function setParam(key, value, assign) {
  const ref = sliderRefs[key];
  const v = ref ? constrain(value, ref.min, ref.max) : value;
  assign(v);
  if (ref) { ref.slider.value(v); ref.valSpan.html(String(v)); }
}

function draw() {
  background(7, 7, 11);

  for (let p = 0; p < POP_COUNT; p++) {
    noiseAccumByPop[p] += NOISE_BASE * speedByPop[p];
  }

  // refresh live colours: picker -> base (rim) -> lightened-toward-white (centre)
  for (let p = 0; p < POP_COUNT; p++) {
    const base = popColorPickers[p].color();
    popColors[p] = base;
    popCenterColors[p] = lerpColor(base, WHITE, CENTER_LIGHTEN);
  }

  // --- AUTONOMOUS: each orb on its own seed, on its population's clock ---
  for (const o of orbs) o.wander(noiseAccumByPop[o.pop]);

  // --- INTER-POPULATION: attraction / soft repulsion shell + merge proximity ---
  for (const o of orbs) o.applyCrossPopulationForces(orbs);

  for (const o of orbs) o.update();

  // hard separation floor -> weak-attraction pairs bounce instead of fusing
  resolveCrossPopulationSeparation(orbs);

  // --- RENDER: every orb through the per-ring-level metaball pipeline ---
  renderOrbLayers();

  if (frameCount % 15 === 0) fpsSpan.html('fps: ' + nf(frameRate(), 1, 1));
}

// The SVG "goo" filter: Gaussian blur -> steep alpha step. Applied to a whole
// ring-level buffer, it fuses overlapping discs into one hard-edged shape with
// a neck, and thresholds a lone disc straight back to a crisp circle. Injected
// once into the page; referenced from the canvas via drawingContext.filter.
function injectGooFilter() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.style.position = 'absolute';
  svg.style.pointerEvents = 'none';

  const filter = document.createElementNS(NS, 'filter');
  filter.setAttribute('id', 'orbmerge-goo');
  // generous region so the blur is not clipped at the buffer edges
  filter.setAttribute('x', '-30%');
  filter.setAttribute('y', '-30%');
  filter.setAttribute('width', '160%');
  filter.setAttribute('height', '160%');
  filter.setAttribute('color-interpolation-filters', 'sRGB'); // keep colours as authored

  const blur = document.createElementNS(NS, 'feGaussianBlur');
  blur.setAttribute('in', 'SourceGraphic');
  blur.setAttribute('stdDeviation', String(GOO_BLUR));
  blur.setAttribute('result', 'blur');

  const cm = document.createElementNS(NS, 'feColorMatrix');
  cm.setAttribute('in', 'blur');
  cm.setAttribute('type', 'matrix');
  // identity on RGB; alpha' = GOO_ALPHA_GAIN * alpha + GOO_ALPHA_BIAS  -> hard step
  cm.setAttribute('values',
    `1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 ${GOO_ALPHA_GAIN} ${GOO_ALPHA_BIAS}`);

  filter.appendChild(blur);
  filter.appendChild(cm);
  svg.appendChild(filter);
  document.body.appendChild(svg);
}

// One pass. Draw every orb as a single disc filled with a smooth radial
// gradient (base colour at the rim, lightened toward white at the centre)
// into the shared buffer, then blit the whole buffer through the goo filter
// so the discs fuse (or a lone one thresholds back to a crisp circle with its
// gradient intact -- the alpha step only hardens the SHAPE edge, colour
// channels are untouched).
function renderOrbLayers() {
  const g = levelBuffer;
  const gc = g.drawingContext;
  const s = g.width / width;          // canvas px -> buffer px

  // 1. gradient-filled discs into levelBuffer
  g.clear();
  for (const o of orbs) {
    const rim = popColors[o.pop];
    const center = popCenterColors[o.pop];
    // fixed disc size; orbs the physics is actively merging get a small extra
    // reach so the visible fusion tracks the force coupling.
    const rr = OUTER_RATIO * overallSize * FIELD_REACH * (1 + 0.18 * o.mergeAmount);
    const cx = o.pos.x * s, cy = o.pos.y * s, r = rr * s;

    const grad = gc.createRadialGradient(cx, cy, 0, cx, cy, r);
    grad.addColorStop(0, `rgb(${red(center)}, ${green(center)}, ${blue(center)})`);
    grad.addColorStop(1, `rgb(${red(rim)}, ${green(rim)}, ${blue(rim)})`);
    gc.fillStyle = grad;
    gc.beginPath();
    gc.arc(cx, cy, r, 0, TWO_PI);
    gc.fill();
  }

  // 2. goo filter (blur + hard alpha step) -> gooBuffer, still at buffer res
  gooBuffer.clear();
  gooBuffer.drawingContext.filter = 'url(#orbmerge-goo)';
  gooBuffer.image(g, 0, 0);
  gooBuffer.drawingContext.filter = 'none';

  // 3. plain upscale onto the canvas (cheap; also softens the edge a touch)
  image(gooBuffer, 0, 0, width, height);
}

// HARD floor on different-population spacing -- the guarantee that a weak pair
// BOUNCES rather than merges. Each population's floor is BOUNCE_SEPARATION *
// overallSize scaled by (1 - mergeT), so a pop at attraction 0 keeps a gap wide
// enough that its metaball fields never fuse, and a pop near ATTR_MAX has no
// floor at all. For a mixed pair the WIDER floor wins -- if either side refuses
// to merge, the pair bounces. A couple of relaxation passes keep 3-population
// pile-ups from jittering. Runs after update(), so it also re-clamps to canvas.
function resolveCrossPopulationSeparation(all) {
  const sepByPop = [];
  for (let p = 0; p < POP_COUNT; p++) {
    sepByPop[p] = overallSize * BOUNCE_SEPARATION * (1 - mergeTFor(p));
  }
  for (let it = 0; it < SEPARATION_ITERS; it++) {
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i], b = all[j];
        if (a.pop === b.pop) continue;
        const minSep = Math.max(sepByPop[a.pop], sepByPop[b.pop]);
        if (minSep <= 0) continue;
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
  const r = OUTER_RATIO * overallSize;
  for (const o of all) {
    o.pos.x = constrain(o.pos.x, r, width - r);
    o.pos.y = constrain(o.pos.y, r, height - r);
  }
}

class Orb {
  constructor(x, y, pop) {
    this.pos = createVector(x, y);
    this.pop = pop;
    this.autoVel = createVector(0, 0);
    this.collisionForce = createVector(0, 0);
    this.mergeAmount = 0;
    // per-individual seed so wander paths never fall into sync across a population.
    this.noiseSeed = random(1000);
  }

  // AUTONOMOUS -- velocity is the DIFFERENCE of two Perlin channels per axis
  // (this orb's own seed + its population's wander clock), plus a soft steer
  // away from the canvas edges. No reference to any other orb.
  //
  // Why a difference: the earlier version took a SINGLE noise channel as an
  // angle (heading = noise * TWO_PI * turns). p5's noise() clusters around its
  // mean (~0.47, NOT 0.5), so that heading clustered around one direction and
  // every orb crept that way forever -- the "everything drifts right" bug.
  // noise()*2-1 has the same disease (mean ~= -0.06, so a steady pull). A
  // difference of two independent noise samples is exactly zero-mean and
  // symmetric no matter what noise()'s mean is, so there is no net drift.
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
    if (this.autoVel.magSq() > 1e-6) this.autoVel.setMag(MOVE_BASE_PX * speedByPop[this.pop]);
  }

  // INTER-POPULATION -- attraction toward, and a repulsion shell around,
  // DIFFERENT-population orbs, plus this orb's merge proximity (0..1) for the
  // render. Same-population orbs are skipped entirely.
  //
  // mergeT slides this population from BOUNCE to MERGE with its attraction
  // slider: at 0 the shell is wide (REPEL_DIST_BOUNCE) and firm (REPULSION_
  // BOUNCE) and sits outside metaball fusion range, so contact is a deflection;
  // at 1 the shell is a small soft core, and attraction (which is also 0 when
  // the slider is 0) drags orbs deep past fusion range into a fat neck.
  applyCrossPopulationForces(all) {
    this.collisionForce.set(0, 0);
    this.mergeAmount = 0;

    const attr = attractionStrengthByPop[this.pop];
    const mergeT = mergeTFor(this.pop);

    const attractReach = overallSize * INTERACTION_FACTOR;
    const repelDist = overallSize * lerp(REPEL_DIST_BOUNCE, REPEL_DIST_MERGE, mergeT);
    const repelGain = lerp(REPULSION_BOUNCE, REPULSION_MERGE, mergeT);
    const R = Math.max(attractReach, repelDist);
    const mergeFull = overallSize * MERGE_FULL_FACTOR;

    for (const other of all) {
      if (other === this || other.pop === this.pop) continue;
      const dx = other.pos.x - this.pos.x;
      const dy = other.pos.y - this.pos.y;
      const d = Math.hypot(dx, dy);
      if (d >= R) continue;

      const ux = d > 1e-4 ? dx / d : 1;
      const uy = d > 1e-4 ? dy / d : 0;

      // attraction: 0 at its edge, strongest at contact, and 0 whenever this
      // population's slider is 0. Keyed to THIS orb's population, so it can be
      // asymmetric; the repulsion shell below keeps an asymmetric pair honest.
      if (d < attractReach) {
        const attract = attr * ATTRACT_BASE * (1 - d / attractReach);
        this.collisionForce.x += ux * attract;
        this.collisionForce.y += uy * attract;
      }

      // repulsion shell: 0 at its onset, ramping to repelGain at full overlap.
      if (d < repelDist) {
        const repel = repelGain * (1 - d / repelDist);
        this.collisionForce.x -= ux * repel;
        this.collisionForce.y -= uy * repel;
      }

      // proximity 0..1, scaled by mergeT -- a weak-attraction pair contributes
      // nothing (and can't get close anyway); falls straight back to 0 on
      // separation, so the merge is fully reversible with no lingering.
      const m = mergeT * constrain(map(d, R, mergeFull, 0, 1), 0, 1);
      if (m > this.mergeAmount) this.mergeAmount = m;
    }
  }

  update() {
    this.pos.x += this.autoVel.x + this.collisionForce.x;
    this.pos.y += this.autoVel.y + this.collisionForce.y;
    // keep the whole outer ring on-canvas so the goo filter never clips a blob
    // at the edge (wander()'s edge steer usually keeps orbs off this clamp).
    const r = OUTER_RATIO * overallSize;
    this.pos.x = constrain(this.pos.x, r, width - r);
    this.pos.y = constrain(this.pos.y, r, height - r);
  }
}
