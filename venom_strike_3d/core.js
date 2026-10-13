/* =====================================================================
   MODIS MONGOOSE: VENOM STRIKE 3D  -  core.js
   Config, maths helpers, the procedural RetroSoundEngine, input polling
   (keyboard / mouse / touch / gamepads) and procedural canvas textures.
   Nothing is loaded from other sites: every texture and sound is generated.
   ===================================================================== */
'use strict';

// ---------------------------------------------------------------- CONFIG
const CFG = {
  ARENA_R: 24,              // fighting clearing radius (world units ~ metres)
  GROUND_SIZE: 220,
  M_SPEED: 8.5,             // mongoose run speed - lightning fast
  M_ACCEL: 60,
  M_HP: 100,
  BITE_RANGE: 1.35,         // jaws reach from the body centre
  BITE_LUNGE: 1.7,          // forward leap distance of a bite
  BITE_TIME: 0.16,
  BITE_CD: 0.4,
  BITE_DMG: 14,
  DODGE_DIST: 4.2,
  DODGE_TIME: 0.32,
  DODGE_COST: 28,
  AGI_REGEN: 22,            // agility per second
  COUNTER_WINDOW: 0.42,     // dodge this close before a strike lands = Counter-Strike Reflex
  COUNTER_SLOWMO: 0.22,     // world time scale during bullet time
  COUNTER_TIME: 1.5,        // real seconds of bullet time
  COUNTER_MULT: 3,
  SCREECH_CD: 8, SCREECH_RANGE: 8.5, SCREECH_ARC: 0.62, SCREECH_STUN: 2.2,
  WHIP_CD: 6, WHIP_RANGE: 4.6, WHIP_STUN: 0.9, WHIP_PUSH: 5,
  ANTIDOTE_CD: 20, ANTIDOTE_HEAL: 28, ANTIDOTE_HASTE: 4,
  CLONE_CD: 26, CLONE_TIME: 9, CLONE_COUNT: 3,
  UNLOCK: { screech: 2, whip: 3, antidote: 4, clones: 6 },
  VENOM_DPS: 2.4, VENOM_TIME: 6,
  SNAKE_SEGS: 56,
  SNAKE_SPACING: 0.13,
  STRIKE_RANGE: 3.4,
  HYPNO_RANGE: 9,
  MAX_ON_FIELD: 3,
};

// ---------------------------------------------------------------- helpers
const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a = 1, b) => (b === undefined ? Math.random() * a : a + Math.random() * (b - a));
const smooth = (t) => t * t * (3 - 2 * t);
const angDiff = (a, b) => { let d = (b - a) % TAU; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU; return d; };
const dist2 = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);
function seeded(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const store = {
  get(k, d) { try { const v = localStorage.getItem('venomstrike3d_' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('venomstrike3d_' + k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
};

// ======================================================================
//  RetroSoundEngine - every sound is synthesised on the fly (WebAudio).
//  Sounds come only from actions (no music or ambience loops).
// ======================================================================
class RetroSoundEngine {
  constructor() { this.ctx = null; this.muted = store.get('muted', false); this.last = {}; }
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.55;
      const comp = this.ctx.createDynamicsCompressor();
      this.master.connect(comp); comp.connect(this.ctx.destination);
      const len = this.ctx.sampleRate * 2;
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }
  toggleMute() { this.muted = !this.muted; store.set('muted', this.muted); if (this.master) this.master.gain.value = this.muted ? 0 : 0.55; return this.muted; }
  ok(name, gap = 0.04) { // throttle identical sounds piling up in one frame
    if (!this.ctx || this.muted) return false;
    const t = this.ctx.currentTime;
    if (this.last[name] && t - this.last[name] < gap) return false;
    this.last[name] = t; return true;
  }
  env(g, t, a, peak, hold, rel) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.setValueAtTime(peak, t + a + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + hold + rel);
  }
  noiseSrc(t, dur) { const s = this.ctx.createBufferSource(); s.buffer = this.noise; s.loop = true; s.start(t, Math.random() * 1.5); s.stop(t + dur + 0.05); return s; }
  filt(type, f, q = 1) { const b = this.ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; }
  osc(type, f, t, dur) { const o = this.ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(f, t); o.start(t); o.stop(t + dur + 0.05); return o; }
  chain(...nodes) { for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]); nodes[nodes.length - 1].connect(this.master); }

  // Slithering hiss - breathy high noise (real snakes hiss, they do not growl)
  hiss(dur = 0.7, vol = 0.35) {
    if (!this.ok('hiss', 0.12)) return; const t = this.ctx.currentTime;
    const n = this.noiseSrc(t, dur), hp = this.filt('highpass', 2200), bp = this.filt('bandpass', 5200, 0.6), g = this.ctx.createGain();
    bp.frequency.setValueAtTime(3800, t); bp.frequency.linearRampToValueAtTime(6200, t + dur);
    this.env(g, t, 0.04, vol, dur * 0.55, dur * 0.4); this.chain(n, hp, bp, g);
  }
  // Low-frequency tail rattle - noise chopped by a fast LFO
  rattle(dur = 0.6, vol = 0.3) {
    if (!this.ok('rattle', 0.2)) return; const t = this.ctx.currentTime;
    const n = this.noiseSrc(t, dur), bp = this.filt('bandpass', 2600, 1.4), g = this.ctx.createGain(), am = this.ctx.createGain();
    am.gain.value = 0; const lfo = this.osc('square', 34, t, dur), lg = this.ctx.createGain(); lg.gain.value = 0.5;
    lfo.connect(lg); lg.connect(am.gain);
    this.env(g, t, 0.02, vol, dur * 0.6, dur * 0.3); n.connect(bp); bp.connect(am); am.connect(g); g.connect(this.master);
    const th = this.osc('sine', 70, t, 0.2), tg = this.ctx.createGain(); this.env(tg, t, 0.005, vol * 0.6, 0.02, 0.15); this.chain(th, tg);
  }
  // Fast dodging swoosh - band-passed noise sweeping up then down
  swoosh(vol = 0.32) {
    if (!this.ok('swoosh', 0.06)) return; const t = this.ctx.currentTime, dur = 0.28;
    const n = this.noiseSrc(t, dur), bp = this.filt('bandpass', 500, 2.2), g = this.ctx.createGain();
    bp.frequency.setValueAtTime(400, t); bp.frequency.exponentialRampToValueAtTime(2600, t + dur * 0.45); bp.frequency.exponentialRampToValueAtTime(600, t + dur);
    this.env(g, t, 0.02, vol, 0.06, dur - 0.08); this.chain(n, bp, g);
  }
  bite(vol = 0.4) {
    if (!this.ok('bite', 0.05)) return; const t = this.ctx.currentTime;
    const n = this.noiseSrc(t, 0.08), hp = this.filt('highpass', 1200), g = this.ctx.createGain();
    this.env(g, t, 0.002, vol, 0.01, 0.06); this.chain(n, hp, g);
    const o = this.osc('triangle', 260, t, 0.12), og = this.ctx.createGain(); o.frequency.exponentialRampToValueAtTime(70, t + 0.1);
    this.env(og, t, 0.002, vol * 0.8, 0.01, 0.1); this.chain(o, og);
  }
  // Mongoose's own call: quick squeaky chitters
  chatter(vol = 0.18) {
    if (!this.ok('chatter', 0.6)) return; const t0 = this.ctx.currentTime;
    for (let i = 0; i < 4; i++) {
      const t = t0 + i * 0.07, o = this.osc('square', 1500 + Math.random() * 500, t, 0.05), g = this.ctx.createGain(), bp = this.filt('bandpass', 2200, 3);
      o.frequency.exponentialRampToValueAtTime(900, t + 0.05); this.env(g, t, 0.003, vol, 0.01, 0.04); this.chain(o, bp, g);
    }
  }
  screech(vol = 0.3) {
    if (!this.ok('screech', 0.3)) return; const t = this.ctx.currentTime, dur = 0.6;
    for (const det of [0, 37]) {
      const o = this.osc('sawtooth', 1700 + det, t, dur), bp = this.filt('bandpass', 2400, 4), g = this.ctx.createGain();
      o.frequency.linearRampToValueAtTime(2700 + det, t + 0.15); o.frequency.linearRampToValueAtTime(2000 + det, t + dur);
      const v = this.osc('sine', 28, t, dur), vg = this.ctx.createGain(); vg.gain.value = 120; v.connect(vg); vg.connect(o.frequency);
      this.env(g, t, 0.01, vol, dur * 0.6, dur * 0.35); this.chain(o, bp, g);
    }
  }
  shockwave(vol = 0.5) {
    if (!this.ok('shock', 0.2)) return; const t = this.ctx.currentTime;
    const o = this.osc('sine', 110, t, 0.6), g = this.ctx.createGain(); o.frequency.exponentialRampToValueAtTime(32, t + 0.55);
    this.env(g, t, 0.005, vol, 0.08, 0.45); this.chain(o, g);
    const n = this.noiseSrc(t, 0.4), lp = this.filt('lowpass', 700), ng = this.ctx.createGain(); lp.frequency.exponentialRampToValueAtTime(120, t + 0.35);
    this.env(ng, t, 0.005, vol * 0.7, 0.04, 0.3); this.chain(n, lp, ng);
  }
  // Cinematic boss hiss-roar: deep breathy noise + low growl body
  roar(vol = 0.5) {
    if (!this.ok('roar', 0.8)) return; const t = this.ctx.currentTime, dur = 1.4;
    const n = this.noiseSrc(t, dur), bp = this.filt('bandpass', 1400, 0.5), g = this.ctx.createGain();
    bp.frequency.setValueAtTime(2600, t); bp.frequency.exponentialRampToValueAtTime(700, t + dur);
    this.env(g, t, 0.08, vol, dur * 0.5, dur * 0.4); this.chain(n, bp, g);
    const o = this.osc('sawtooth', 62, t, dur), lp = this.filt('lowpass', 380), og = this.ctx.createGain();
    const tr = this.osc('sine', 9, t, dur), tg = this.ctx.createGain(); tg.gain.value = 0.15; tr.connect(tg); tg.connect(og.gain);
    this.env(og, t, 0.1, vol * 0.55, dur * 0.5, dur * 0.35); this.chain(o, lp, og);
  }
  hurt(vol = 0.32) {
    if (!this.ok('hurt', 0.12)) return; const t = this.ctx.currentTime;
    const o = this.osc('square', 420, t, 0.2), g = this.ctx.createGain(), lp = this.filt('lowpass', 1800);
    o.frequency.exponentialRampToValueAtTime(140, t + 0.18); this.env(g, t, 0.003, vol, 0.02, 0.16); this.chain(o, lp, g);
  }
  splat(vol = 0.28) {
    if (!this.ok('splat', 0.06)) return; const t = this.ctx.currentTime;
    const n = this.noiseSrc(t, 0.2), lp = this.filt('lowpass', 900), g = this.ctx.createGain();
    this.env(g, t, 0.003, vol, 0.02, 0.15); this.chain(n, lp, g);
    const o = this.osc('sine', 600, t, 0.12), og = this.ctx.createGain(); o.frequency.exponentialRampToValueAtTime(180, t + 0.1);
    this.env(og, t, 0.003, vol * 0.5, 0.01, 0.09); this.chain(o, og);
  }
  spit(vol = 0.3) {
    if (!this.ok('spit', 0.08)) return; const t = this.ctx.currentTime;
    const n = this.noiseSrc(t, 0.18), bp = this.filt('bandpass', 3000, 1.2), g = this.ctx.createGain();
    bp.frequency.exponentialRampToValueAtTime(1200, t + 0.15); this.env(g, t, 0.004, vol, 0.03, 0.12); this.chain(n, bp, g);
  }
  counter(vol = 0.45) {
    if (!this.ok('counter', 0.3)) return; const t = this.ctx.currentTime;
    const o = this.osc('sine', 1320, t, 1.2), g = this.ctx.createGain(); o.frequency.exponentialRampToValueAtTime(220, t + 1.1);
    this.env(g, t, 0.01, vol * 0.6, 0.2, 0.9); this.chain(o, g);
    const n = this.noiseSrc(t, 0.9), bp = this.filt('bandpass', 3000, 1), ng = this.ctx.createGain(); bp.frequency.exponentialRampToValueAtTime(200, t + 0.8);
    this.env(ng, t, 0.01, vol * 0.5, 0.1, 0.7); this.chain(n, bp, ng);
    const c = this.osc('triangle', 2093, t, 0.5), cg = this.ctx.createGain(); this.env(cg, t, 0.002, vol * 0.35, 0.02, 0.45); this.chain(c, cg);
  }
  antidote(vol = 0.25) {
    if (!this.ok('anti', 0.3)) return; const t0 = this.ctx.currentTime;
    [523, 659, 784, 1047].forEach((f, i) => { const t = t0 + i * 0.06, o = this.osc('sine', f, t, 0.3), g = this.ctx.createGain(); this.env(g, t, 0.005, vol, 0.05, 0.25); this.chain(o, g); });
  }
  clones(vol = 0.2) {
    if (!this.ok('clones', 0.3)) return; const t0 = this.ctx.currentTime;
    for (let i = 0; i < 8; i++) { const t = t0 + i * 0.04, o = this.osc('sine', 500 + Math.random() * 900, t, 0.25), g = this.ctx.createGain(); this.env(g, t, 0.005, vol, 0.03, 0.2); this.chain(o, g); }
    this.swoosh(0.25);
  }
  rumble(dur = 0.9, vol = 0.4) {
    if (!this.ok('rumble', 0.3)) return; const t = this.ctx.currentTime;
    const n = this.noiseSrc(t, dur), lp = this.filt('lowpass', 160, 1.5), g = this.ctx.createGain();
    this.env(g, t, 0.06, vol, dur * 0.5, dur * 0.4); this.chain(n, lp, g);
  }
  celebrate(vol = 0.22) {
    if (!this.ok('celebrate', 1)) return; const t0 = this.ctx.currentTime;
    [523, 587, 659, 784, 880, 1047, 880, 1047].forEach((f, i) => { const t = t0 + i * 0.13, o = this.osc('triangle', f, t, 0.22), g = this.ctx.createGain(); this.env(g, t, 0.005, vol, 0.06, 0.15); this.chain(o, g); });
  }
  ui(vol = 0.15) { if (!this.ok('ui', 0.05)) return; const t = this.ctx.currentTime, o = this.osc('square', 880, t, 0.05), g = this.ctx.createGain(); this.env(g, t, 0.002, vol, 0.01, 0.04); this.chain(o, g); }
}
const SFX = new RetroSoundEngine();

// ======================================================================
//  InputManager - keyboard, mouse, touch and gamepads polled every frame
// ======================================================================
class InputManager {
  constructor(canvas) {
    this.down = new Set(); this.hit = new Set(); this.mouseHit = false; this.wheel = 0;
    this.touch = { x: 0, z: 0, active: false, hit: new Set() };
    this.padPrev = [{}, {}];
    addEventListener('keydown', (e) => {
      SFX.unlock();
      if (!this.down.has(e.code)) this.hit.add(e.code);
      this.down.add(e.code);
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Slash', 'Tab'].includes(e.code)) e.preventDefault();
    });
    addEventListener('keyup', (e) => this.down.delete(e.code));
    addEventListener('blur', () => this.down.clear());
    canvas.addEventListener('mousedown', (e) => { SFX.unlock(); if (e.button === 0) this.mouseHit = true; });
    canvas.addEventListener('wheel', (e) => { this.wheel += Math.sign(e.deltaY); e.preventDefault(); }, { passive: false });
    this.isTouch = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
    if (this.isTouch) this.setupTouch();
  }
  setupTouch() {
    const stick = document.getElementById('stick'), knob = document.getElementById('knob');
    let id = null, cx = 0, cy = 0;
    const move = (t) => {
      let dx = t.clientX - cx, dy = t.clientY - cy; const m = Math.hypot(dx, dy), R = 55;
      if (m > R) { dx *= R / m; dy *= R / m; }
      knob.style.transform = `translate(${dx}px, ${dy}px)`; this.touch.x = dx / R; this.touch.z = dy / R;
    };
    stick.addEventListener('touchstart', (e) => { SFX.unlock(); const t = e.changedTouches[0]; id = t.identifier; const r = stick.getBoundingClientRect(); cx = r.left + r.width / 2; cy = r.top + r.height / 2; this.touch.active = true; move(t); e.preventDefault(); }, { passive: false });
    stick.addEventListener('touchmove', (e) => { for (const t of e.changedTouches) if (t.identifier === id) move(t); e.preventDefault(); }, { passive: false });
    const end = (e) => { for (const t of e.changedTouches) if (t.identifier === id) { id = null; this.touch.active = false; this.touch.x = this.touch.z = 0; knob.style.transform = ''; } };
    stick.addEventListener('touchend', end); stick.addEventListener('touchcancel', end);
    document.querySelectorAll('#touch .tb').forEach((b) => b.addEventListener('touchstart', (e) => { SFX.unlock(); this.touch.hit.add(b.dataset.k); e.preventDefault(); }, { passive: false }));
  }
  pressed(...codes) { return codes.some((c) => this.hit.has(c)); }
  held(...codes) { return codes.some((c) => this.down.has(c)); }
  pad(i) {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const list = []; for (const p of pads) if (p && p.connected) list.push(p);
    const p = list[i]; if (!p) return null;
    const prev = this.padPrev[i], now = {}, hit = {};
    const names = ['a', 'b', 'x', 'y', 'lb', 'rb', '', '', 'back', 'start'];
    names.forEach((n, k) => { if (!n) return; now[n] = !!(p.buttons[k] && p.buttons[k].pressed); hit[n] = now[n] && !prev[n]; });
    this.padPrev[i] = now;
    let x = p.axes[0] || 0, z = p.axes[1] || 0;
    if (p.buttons[14] && p.buttons[14].pressed) x = -1; if (p.buttons[15] && p.buttons[15].pressed) x = 1;
    if (p.buttons[12] && p.buttons[12].pressed) z = -1; if (p.buttons[13] && p.buttons[13].pressed) z = 1;
    if (Math.hypot(x, z) < 0.2) x = z = 0;
    return { x, z, hit };
  }
  endFrame() { this.hit.clear(); this.mouseHit = false; this.wheel = 0; this.touch.hit.clear(); }
}

// ======================================================================
//  Procedural textures (canvas) - fur, scales, hood, dirt, bark, glow
// ======================================================================
const TEX = {};
function canvasTex(w, h, paint, repeat) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'); paint(g, w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
  t.anisotropy = 4; return t;
}
function speckle(g, w, h, n, cols, rmin, rmax, r) {
  for (let i = 0; i < n; i++) { g.fillStyle = cols[(r() * cols.length) | 0]; g.globalAlpha = 0.25 + r() * 0.6; g.beginPath(); g.arc(r() * w, r() * h, rmin + r() * (rmax - rmin), 0, TAU); g.fill(); }
  g.globalAlpha = 1;
}
function buildTextures() {
  // Grizzled mongoose fur: grey-brown with pepper-and-salt hair streaks
  TEX.fur = (base, dark, light) => canvasTex(256, 256, (g, w, h) => {
    const r = seeded(7); g.fillStyle = base; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 2600; i++) {
      const x = r() * w, y = r() * h, l = 4 + r() * 9, a = -0.5 + r() * 0.25;
      g.strokeStyle = r() < 0.5 ? dark : light; g.globalAlpha = 0.35 + r() * 0.5; g.lineWidth = 0.8 + r();
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
    }
    g.globalAlpha = 1;
  }, true);
  // Alpha map for fur shells: sparse bright hair tips
  TEX.furAlpha = canvasTex(256, 256, (g, w, h) => {
    const r = seeded(11); g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 5200; i++) { g.fillStyle = `rgba(255,255,255,${0.4 + r() * 0.6})`; g.fillRect(r() * w, r() * h, 1 + r() * 1.5, 1 + r() * 1.5); }
  }, true);
  // Cobra scales: banded body, overlapping scale lattice, pale belly (v = 0.75 is the belly)
  TEX.scales = (body, band, belly, dark) => canvasTex(1024, 128, (g, w, h) => {
    g.fillStyle = body; g.fillRect(0, 0, w, h);
    for (let x = 0; x < w; x += 64) { g.fillStyle = band; g.globalAlpha = 0.85; g.fillRect(x + 40, 0, 14, h); g.fillStyle = dark; g.globalAlpha = 0.5; g.fillRect(x + 36, 0, 4, h); g.fillRect(x + 54, 0, 4, h); }
    g.globalAlpha = 1;
    const by = h * 0.75; const grd = g.createLinearGradient(0, by - 26, 0, by + 26);
    grd.addColorStop(0, 'rgba(0,0,0,0)'); grd.addColorStop(0.35, belly); grd.addColorStop(0.65, belly); grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd; g.fillRect(0, by - 26, w, 52);
    g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 1;
    for (let y = 0; y < h; y += 8) for (let x = (y / 8) % 2 ? 4 : 0; x < w; x += 8) { g.beginPath(); g.moveTo(x, y + 4); g.lineTo(x + 4, y); g.lineTo(x + 8, y + 4); g.stroke(); }
    g.fillStyle = 'rgba(255,255,255,0.08)'; for (let y = 0; y < h; y += 8) for (let x = (y / 8) % 2 ? 4 : 0; x < w; x += 8) g.fillRect(x + 3, y + 1, 2, 1);
  }, true);
  TEX.hood = (body, band, belly) => canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = body; g.fillRect(0, 0, w, h);
    g.fillStyle = belly; g.beginPath(); g.ellipse(w / 2, h / 2, w * 0.3, h * 0.42, 0, 0, TAU); g.fill();
    g.strokeStyle = band; g.lineWidth = 9; for (let k = 0; k < 4; k++) { g.beginPath(); g.ellipse(w / 2, h * 0.55, w * (0.12 + k * 0.09), h * (0.15 + k * 0.08), 0, Math.PI * 1.1, Math.PI * 1.9); g.stroke(); }
    g.fillStyle = '#111'; g.beginPath(); g.ellipse(w * 0.38, h * 0.42, 18, 24, 0, 0, TAU); g.ellipse(w * 0.62, h * 0.42, 18, 24, 0, 0, TAU); g.fill();   // spectacle mark
    g.fillStyle = belly; g.beginPath(); g.ellipse(w * 0.38, h * 0.42, 8, 11, 0, 0, TAU); g.ellipse(w * 0.62, h * 0.42, 8, 11, 0, 0, TAU); g.fill();
  });
  // Jungle floor: dry earth, darker blotches, pebbles, cracks, fallen leaves
  TEX.ground = canvasTex(1024, 1024, (g, w, h) => {
    const r = seeded(3); g.fillStyle = '#5b4631'; g.fillRect(0, 0, w, h);
    speckle(g, w, h, 900, ['#4a3826', '#6b5238', '#3e2f20', '#735a3e'], 6, 36, r);
    speckle(g, w, h, 5000, ['#85694a', '#2f241a', '#9a8061', '#4d3b28'], 0.6, 2.4, r);
    g.strokeStyle = 'rgba(30,20,12,.55)'; g.lineWidth = 1.4;
    for (let i = 0; i < 70; i++) { let x = r() * w, y = r() * h; g.beginPath(); g.moveTo(x, y); for (let k = 0; k < 6; k++) { x += (r() - 0.5) * 40; y += (r() - 0.5) * 40; g.lineTo(x, y); } g.stroke(); }
    for (let i = 0; i < 420; i++) { g.fillStyle = ['#8a8070', '#6f675b', '#a59a86'][(r() * 3) | 0]; g.beginPath(); g.ellipse(r() * w, r() * h, 1.5 + r() * 4, 1 + r() * 3, r() * 3, 0, TAU); g.fill(); }
    for (let i = 0; i < 260; i++) {
      const x = r() * w, y = r() * h, a = r() * TAU, l = 7 + r() * 12;
      g.fillStyle = ['#7d5a22', '#8f6a2a', '#5e4a1c', '#6d7a2a', '#9b4e1f'][(r() * 5) | 0]; g.globalAlpha = 0.85;
      g.save(); g.translate(x, y); g.rotate(a); g.beginPath(); g.ellipse(0, 0, l, l * 0.38, 0, 0, TAU); g.fill();
      g.strokeStyle = 'rgba(40,25,10,.6)'; g.lineWidth = 0.7; g.beginPath(); g.moveTo(-l, 0); g.lineTo(l, 0); g.stroke(); g.restore();
    }
    g.globalAlpha = 1;
  }, true);
  TEX.bark = canvasTex(128, 256, (g, w, h) => {
    const r = seeded(5); g.fillStyle = '#3d2c1f'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 90; i++) { g.strokeStyle = ['#2a1d13', '#54402d', '#1e150d'][(r() * 3) | 0]; g.lineWidth = 1 + r() * 3; const x = r() * w; g.beginPath(); g.moveTo(x, 0); g.bezierCurveTo(x + (r() - 0.5) * 20, h * 0.3, x + (r() - 0.5) * 20, h * 0.7, x + (r() - 0.5) * 10, h); g.stroke(); }
    speckle(g, w, h, 160, ['#4f6b2a', '#3a5220'], 1, 4, r);   // moss
  }, true);
  TEX.leaf = canvasTex(256, 256, (g, w, h) => {
    const r = seeded(9); g.fillStyle = '#23401c'; g.fillRect(0, 0, w, h);
    speckle(g, w, h, 1400, ['#2f5a22', '#1a3014', '#3d6e2a', '#4c7d2f', '#16260f'], 3, 12, r);
  }, true);
  TEX.dot = canvasTex(64, 64, (g, w, h) => {
    const grd = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.4, 'rgba(255,255,255,.5)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.fillRect(0, 0, w, h);
  });
  TEX.ring = canvasTex(128, 128, (g, w, h) => {
    const grd = g.createRadialGradient(w / 2, h / 2, w * 0.3, w / 2, h / 2, w / 2);
    grd.addColorStop(0, 'rgba(255,255,255,0)'); grd.addColorStop(0.7, 'rgba(255,255,255,.9)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.fillRect(0, 0, w, h);
  });
  TEX.hole = canvasTex(128, 128, (g, w, h) => {
    const grd = g.createRadialGradient(w / 2, h / 2, 2, w / 2, h / 2, w / 2);
    grd.addColorStop(0, 'rgba(5,3,2,1)'); grd.addColorStop(0.45, 'rgba(15,10,6,.95)'); grd.addColorStop(0.7, 'rgba(70,50,30,.7)'); grd.addColorStop(1, 'rgba(70,50,30,0)');
    g.fillStyle = grd; g.fillRect(0, 0, w, h);
  });
}
