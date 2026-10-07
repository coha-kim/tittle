const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

function harness() {
  let now = 0;
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, {
      handlers: {}, style: { setProperty() {} },
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener(type, handler) { this.handlers[type] = handler; },
      setPointerCapture() {},
    });
    return elements.get(id);
  };
  const context = vm.createContext({
    Math, width: 1000, height: 1000, windowWidth: 1000, windowHeight: 1000,
    TWO_PI: Math.PI * 2, millis: () => now,
    constrain: (v, lo, hi) => Math.max(lo, Math.min(hi, v)),
    lerp: (a, b, t) => a + (b - a) * t,
    random: () => 0.5, noise: (x) => (Math.sin(x) + 1) / 2,
    createVector: (x, y) => ({
      x, y, set(x, y) { this.x = x; this.y = y; },
      magSq() { return this.x ** 2 + this.y ** 2; },
      setMag(m) { const ratio = m / Math.hypot(this.x, this.y); this.x *= ratio; this.y *= ratio; },
    }),
    background() {}, noStroke() {}, drawingContext: { save() {}, restore() {} },
    window: {}, document: { getElementById: element, body: element('body') },
  });
  const run = (code) => vm.runInContext(code, context);
  run(readFileSync(new URL('../mobile/sketch.js', `file://${__filename}`), 'utf8'));
  run(`wireUI(); appState = 'canvas';
    Boid.prototype.renderGlow = function() {};
    Boid.prototype.renderOrb = function() {};
    boids = [new Boid(400, 500), new Boid(520, 500)];`);
  return {
    run,
    frame() { now += 1000 / 60; run('draw()'); },
    shake() {
      run(`onMotion({ accelerationIncludingGravity: { x: 0, y: 0, z: 9.8 } });
        onMotion({ accelerationIncludingGravity: { x: 80, y: 0, z: 9.8 } });`);
    },
    event(id, type) { element(id).handlers[type]({ preventDefault() {}, pointerId: 1 }); },
  };
}

test('idle shake and SIGNAL leave movement and pair forces unchanged', () => {
  const a = harness(), b = harness();
  b.event('signal', 'pointerdown');
  for (let i = 0; i < 120; i++) {
    b.shake(); a.frame(); b.frame();
    assert.equal(a.run('JSON.stringify(boids.map(b => b.pos))'), b.run('JSON.stringify(boids.map(b => b.pos))'));
  }
  b.event('signal', 'pointerup');
  for (let i = 0; i < 60; i++) {
    b.shake(); a.frame(); b.frame();
    assert.equal(a.run('JSON.stringify(boids.map(b => b.pos))'), b.run('JSON.stringify(boids.map(b => b.pos))'));
  }
});

test('only shaking during a hold fades blobs; release retains opacity', () => {
  const h = harness();
  h.shake(); h.frame();
  assert.equal(h.run('blobOpacity'), 1);
  h.event('signal', 'pointerdown');
  h.frame();
  assert.equal(h.run('blobOpacity'), 1);
  for (let i = 0; i < 60; i++) { h.shake(); h.frame(); }
  assert.ok(Math.abs(h.run('blobOpacity') - 0.8) < 1e-9);
  h.event('signal', 'pointerup');
  const saved = h.run('blobOpacity');
  for (let i = 0; i < 600; i++) { h.shake(); h.frame(); }
  assert.equal(h.run('blobOpacity'), saved);
  h.event('signal', 'pointerdown');
  h.frame();
  assert.equal(h.run('blobOpacity'), saved);
  for (let i = 0; i < 300; i++) { h.shake(); h.frame(); }
  assert.equal(h.run('blobOpacity'), 0);
  h.event('signal', 'pointerup');
  h.event('reset-btn', 'click');
  assert.equal(h.run('blobOpacity'), 1);
});

test('pause and cancellation preserve fading, and canvas dragging cannot fake motion', () => {
  const h = harness();
  h.event('signal', 'pointerdown');
  for (let i = 0; i < 30; i++) { h.shake(); h.frame(); }
  for (let i = 0; i < 30; i++) h.frame(); // allow motion detection window to expire
  const paused = h.run('blobOpacity');
  for (let i = 0; i < 120; i++) h.frame();
  assert.equal(h.run('blobOpacity'), paused);
  h.event('signal', 'pointercancel');
  h.shake(); h.frame();
  assert.equal(h.run('blobOpacity'), paused);
  h.run('motionSeen = false; lastShakeAt = -Infinity; mouseDragged()');
  assert.equal(h.run('lastShakeAt'), -Infinity);
});
