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
    background() {}, noStroke() {},
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

test('idle sensor shake boosts wander step and clock, then settles without altering attraction', () => {
  const h = harness();
  h.frame();
  assert.equal(h.run('wanderSpeed'), 1);
  const before = h.run('noiseAccum');
  h.shake();
  h.frame();
  assert.ok(h.run('wanderSpeed') > 1);
  assert.ok(h.run('noiseAccum') - before > h.run('NOISE_BASE'));
  assert.ok(Math.abs(h.run('Math.hypot(boids[0].autoVel.x, boids[0].autoVel.y) - MOVE_BASE_PX * wanderSpeed')) < 1e-10);
  assert.equal(h.run('attraction'), h.run('ATTRACTION_IDLE'));
  for (let i = 0; i < 600; i++) h.frame();
  assert.ok(Math.abs(h.run('wanderSpeed') - 1) < 1e-8);
  assert.equal(h.run('attraction'), h.run('ATTRACTION_IDLE'));
});

test('wander multiplier leaves pair attraction and core repulsion unchanged at identical positions', () => {
  const h = harness();
  for (const distance of [h.run('blobSize * 2.9'), h.run('blobSize * 1.5')]) {
    h.run(`boids[1].pos.x = boids[0].pos.x + ${distance};
      boids[0].wander(0, 1); boids[0].applyAttraction(boids, attraction);`);
    const force = h.run('JSON.stringify(boids[0].attractForce)');
    assert.notEqual(h.run('boids[0].attractForce.x'), 0);
    h.run('boids[0].wander(0, 3); boids[0].applyAttraction(boids, attraction)');
    assert.equal(h.run('JSON.stringify(boids[0].attractForce)'), force);
  }
});

test('SIGNAL ignores preceding idle shake and retains held-shake attraction control', () => {
  const h = harness();
  h.shake();
  h.event('signal', 'pointerdown');
  h.frame();
  assert.equal(h.run('liveAttraction'), h.run('ATTRACTION_IDLE'));
  for (let i = 0; i < 60; i++) { h.shake(); h.frame(); }
  assert.ok(h.run('liveAttraction') < h.run('ATTRACTION_IDLE'));
  assert.equal(h.run('wanderSpeed'), 1);
  const held = h.run('liveAttraction');
  h.event('signal', 'pointerup');
  assert.equal(h.run('attraction'), held);
  assert.equal(h.run('shakeEnergy'), 0);
  h.frame();
  assert.equal(h.run('wanderSpeed'), 1);
});

test('saving shape and resetting flock clear residual speed energy', () => {
  const h = harness();
  for (const id of ['save-btn', 'reset-btn']) {
    h.shake(); h.frame();
    assert.ok(h.run('wanderSpeed') > 1);
    h.event(id, 'click');
    assert.equal(h.run('wanderSpeed'), 1);
    assert.equal(h.run('shakeEnergy'), 0);
    assert.equal(h.run('lastShakeAt'), -Infinity);
  }
});
