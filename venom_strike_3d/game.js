/* =====================================================================
   game.js - the Game: renderer, camera, state machine
   (menu -> 3D campaign / 1v1 arena duel -> milestone dance breaks ->
   game over), spawning, scoring, bullet time, HUD and the main loop.
   ===================================================================== */
'use strict';

let G = null;

class Game {
  constructor() {
    G = this;
    this.canvas = document.getElementById('game');
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1.45;
    this.quality = store.get('quality', 'high');
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 900);
    buildTextures();
    this.env = new Environment(this.scene);
    this.input = new InputManager(this.canvas);
    this.snakes = []; this.clones = []; this.blobs = []; this.puddles = [];
    this.player = null; this.time = 0; this.realTime = 0; this.realDt = 0; this.timeScale = 1; this.slowT = 0;
    this.shakeAmt = 0; this.zoom = 1; this.userZoom = 1; this.camPos = new THREE.Vector3(0, 9, 14); this.camLook = new THREE.Vector3();
    this.state = 'menu'; this.mode = null; this.best = store.get('best', 0);
    this.fpsAcc = 0; this.fpsN = 0; this.fpsT = 0;
    this.hud = {}; for (const id of ['hud', 'hpFill', 'hpTxt', 'agiFill', 'agiTxt', 'hypFill', 'hypBar', 'hypLbl', 'venomTag', 'hypTag', 'levelTxt', 'todTxt', 'scoreTxt', 'comboTxt', 'hiTxt', 'snakesTxt', 'bossPanel', 'bossName', 'bossFill', 'abilities', 'banner', 'bannerBig', 'bannerSmall', 'flash', 'vignette', 'pName', 'menu', 'controls', 'pause', 'over', 'overTitle', 'overSub', 'touch', 'menuBest']) this.hud[id] = document.getElementById(id);
    this.buildAbilityBar();
    this.applyQuality();
    addEventListener('resize', () => this.resize()); this.resize();
    document.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => { SFX.unlock(); SFX.ui(); this.act(b.dataset.act); }));
    addEventListener('blur', () => { if (this.state === 'play') this.pauseGame(); });
    this.showMenu();
    this.last = performance.now();
    requestAnimationFrame((t) => this.loop(t));
  }
  // ------------------------------------------------------------ setup helpers
  resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h, false); this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    const px = this.renderer.domElement.height / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
    for (const p of [this.env.dust, this.env.glow, this.env.flies]) p.uniforms.uPx.value = px;
  }
  applyQuality() {
    const hi = this.quality === 'high';
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, hi ? 1.5 : 1));
    this.env.sun.castShadow = hi; this.env.grass.visible = true; this.env.grass.count = hi ? 5200 : 2200;
    store.set('quality', this.quality); this.resize && this.hud.hud && this.resize();
  }
  buildAbilityBar() {
    const list = [['bite', 'F', '\u{1F9B7}', 'BITE'], ['dodge', 'SPC', '\u{1F4A8}', 'DODGE'], ['screech', 'Q', '\u{1F4E2}', 'SCREECH'], ['whip', 'E', '\u{1F300}', 'TAIL WHIP'], ['antidote', 'R', '\u{1F9EA}', 'ANTIDOTE'], ['clones', 'C', '\u{1F465}', 'CLONES']];
    this.abEls = {};
    for (const [k, key, ic, name] of list) {
      const d = document.createElement('div'); d.className = 'ab';
      d.innerHTML = `<span class="key">${key}</span><span class="ic">${ic}</span><span>${name}</span><div class="cd" style="height:0%"></div>`;
      this.hud.abilities.appendChild(d); this.abEls[k] = { el: d, cd: d.querySelector('.cd') };
    }
  }
  act(a) {
    if (a === 'campaign') this.startCampaign();
    else if (a === 'duel2p') this.startDuel(false);
    else if (a === 'duelai') this.startDuel(true);
    else if (a === 'controls') { this.prevOverlay = this.state; this.hud.controls.classList.remove('hidden'); this.hud.menu.classList.add('hidden'); this.hud.pause.classList.add('hidden'); }
    else if (a === 'back') { this.hud.controls.classList.add('hidden'); if (this.state === 'paused') this.hud.pause.classList.remove('hidden'); else this.hud.menu.classList.remove('hidden'); }
    else if (a === 'resume') this.resumeGame();
    else if (a === 'quit') this.showMenu();
    else if (a === 'retry') { if (this.mode === 'campaign') this.startCampaign(); else this.startDuel(this.mode === 'duelai'); }
  }
  // ------------------------------------------------------------ world reset
  clearWorld() {
    for (const s of this.snakes) s.remove(); for (const c of this.clones) c.remove(); for (const b of this.blobs) b.remove();
    if (this.player) this.player.remove();
    this.snakes = []; this.clones = []; this.blobs = []; this.puddles = []; this.player = null;
    this.env.dust.clear(); this.env.glow.clear();
    this.slowT = 0; this.timeScale = 1; this.celebrating = false; this.queue = []; this.timers = []; this.overPending = false;
  }
  mongooses() { const l = []; if (this.player && this.player.alive) l.push(this.player); for (const c of this.clones) if (c.alive) l.push(c); return l; }
  showMenu() {
    this.clearWorld(); this.state = 'menu'; this.mode = null;
    for (const id of ['hud', 'pause', 'over', 'controls', 'touch']) this.hud[id].classList.add('hidden');
    this.hud.menu.classList.remove('hidden'); this.hud.menuBest.textContent = 'Best score ' + this.best;
    // showcase: a mongoose circles a coiled, hooded cobra under the jungle twilight
    this.env.setTimeOfDay(0);
    this.player = new Mongoose(4, 0, { heading: Math.PI });
    const c = new Cobra(0, -1, { human: true, level: 5, heading: Math.PI / 2, look: 'ai' }); c.cmd = {}; this.snakes.push(c);
    this.menuT = 0;
  }
  // ------------------------------------------------------------ campaign
  startCampaign() {
    this.clearWorld(); this.mode = 'campaign'; this.score = 0; this.combo = 0; this.comboT = 0; this.level = 0;
    this.player = new Mongoose(0, 6, { heading: -Math.PI / 2 });
    this.enterPlay(); this.startLevel(1);
  }
  startLevel(n) {
    this.level = n; this.env.setTimeOfDay(n - 1);
    const p = this.player, boss = n % 5 === 0;
    p.atkMult = 1 + (n - 1) * 0.07; const oldMax = p.maxHp; p.maxHp = CFG.M_HP + (n - 1) * 5; p.hp = Math.min(p.maxHp, p.hp + (p.maxHp - oldMax) + p.maxHp * 0.35);
    p.venomT = 0; p.hypnoT = 0; p.hypno = 0; p.agility = 100;
    const newly = [];
    for (const k in CFG.UNLOCK) if (n >= CFG.UNLOCK[k] && !p.unlocked[k]) { p.unlocked[k] = true; newly.push(k); }
    this.queue = [];
    if (boss) { this.queue.push({ boss: true }); for (let i = 0; i < Math.floor(n / 5); i++) this.queue.push({}); }
    else for (let i = 0; i < 2 + Math.floor(n * 0.6); i++) this.queue.push({});
    this.levelTotal = this.queue.length; this.spawnCd = 1.2; this.levelDone = false;
    const names = { screech: 'SONIC SCREECH (Q)', whip: 'TAIL-WHIP SHOCKWAVE (E)', antidote: 'ANTIDOTE BOOST (R)', clones: 'SHADOW-CLONE PACK (C)' };
    const sub = boss ? 'BOSS: THE KING COBRA RISES' : this.env.tod.name + ' - ' + this.levelTotal + ' snakes';
    this.banner('LEVEL ' + n, newly.length ? 'NEW POWER: ' + newly.map((k) => names[k]).join(' + ') : sub, 2.8);
    if (boss) setTimeout(() => SFX.roar(0.45), 900);
  }
  maxOnField() { return Math.min(CFG.MAX_ON_FIELD, 1 + Math.floor(this.level / 3)); }
  spawnSnake(spec) {
    const p = this.player; let best = null, bd = -1;
    for (const h of this.env.holes) { const d = dist2(h.x, h.z, p.x, p.z) + rand(4); if (d > bd) { bd = d; best = h; } }
    const s = new Cobra(best.x, best.z, { level: this.level, boss: spec.boss, emerge: true, spawnOnly: true, heading: Math.atan2(-best.z, -best.x) });
    this.snakes.push(s); G.env.decal(best.x, best.z, TEX.hole, 2.6, 3);
    if (spec.boss) { this.flash('THE KING COBRA', '#ff6b4a', 1.4); this.shake(0.6); }
    else SFX.hiss(0.6, 0.2);
  }
  campaignTick(dt) {
    const alive = this.snakes.filter((s) => s.alive).length;
    this.spawnCd -= dt;
    if (this.queue.length && alive < this.maxOnField() && this.spawnCd <= 0) { this.spawnSnake(this.queue.shift()); this.spawnCd = rand(1.8, 3.2); }
    if (!this.levelDone && !this.queue.length && alive === 0) {
      this.levelDone = true;
      if (this.level % 5 === 0) this.later(1.2, () => this.celebrate());
      else { this.banner('LEVEL ' + this.level + ' CLEARED', '+' + (250 * this.level) + ' jungle bonus', 2); this.score += 250 * this.level; this.later(2.4, () => { if (this.player && this.player.alive) this.startLevel(this.level + 1); }); }
    }
    if (this.comboT > 0) { this.comboT -= this.realDt; if (this.comboT <= 0) this.combo = 0; }
  }
  celebrate() {   // Milestone Dance: victory jig, fireflies swirl, camera orbits
    this.celebrating = true; this.celebrateT = 0;
    const p = this.player; p.state = 'dance'; p.danceT = 0; p.vx = p.vz = 0;
    for (const c of this.clones) c.vanish(); this.clones = [];
    this.banner('MILESTONE!', 'Level ' + this.level + ' conquered - victory dance', 4.5);
    this.score += 1000 * this.level; SFX.celebrate(); SFX.chatter(0.22);
    this.orbitA = 0;
  }
  celebrateTick(dt) {
    this.celebrateT += this.realDt; const p = this.player;
    if (Math.random() < 0.9) for (let k = 0; k < 3; k++) { const a = rand(TAU), r = rand(1.5, 4); this.env.glow.emit(p.x + Math.cos(a) * r, rand(0.2, 2.5), p.z + Math.sin(a) * r, -Math.sin(a) * 2, rand(0.5, 1.5), Math.cos(a) * 2, 1.4, rand(0.12, 0.28), [0xd8ff6a, 0xffd27a, 0x8dfcd0, 0xff9a5a][(Math.random() * 4) | 0], 0.95, -0.3, 0.3); }
    if (this.celebrateT > 5) { this.celebrating = false; p.state = 'free'; this.startLevel(this.level + 1); }
  }
  // ------------------------------------------------------------ duel
  startDuel(ai) {
    this.clearWorld(); this.mode = ai ? 'duelai' : 'duel2p'; this.round = 0; this.wins = [0, 0]; this.score = 0; this.combo = 0; this.comboT = 0; this.level = ai ? 10 : 8;
    this.enterPlay(); this.startRound();
  }
  startRound() {
    for (const s of this.snakes) s.remove(); for (const c of this.clones) c.remove(); for (const b of this.blobs) b.remove();
    if (this.player) this.player.remove();
    this.snakes = []; this.clones = []; this.blobs = []; this.puddles = []; this.slowT = 0; this.timeScale = 1;
    this.round++; this.roundOver = false;
    this.env.setTimeOfDay([0, 1, 4][(this.round - 1) % 3]);
    const all = { screech: true, whip: true, antidote: true, clones: true };
    this.player = new Mongoose(0, 7, { heading: -Math.PI / 2, unlocked: all, hp: 130 });
    this.player.atkMult = 1.35;
    const ai = this.mode === 'duelai';
    const c = new Cobra(0, -7, ai ? { boss: true, level: 10, hp: 760, heading: Math.PI / 2 } : { human: true, level: 8, hp: 340, dmg: 16, speed: 5.4, look: 'p2', heading: Math.PI / 2, can: { spit: true, gaze: true, burrow: true } });
    this.snakes.push(c); this.duelCobra = c;
    this.banner('ROUND ' + this.round, ai ? 'Mongoose vs the King Cobra' : 'Mongoose (WASD) vs Cobra (Arrows)', 2.4);
    SFX.hiss(0.8, 0.3);
  }
  duelTick() {
    if (this.roundOver) return;
    const c = this.duelCobra, p = this.player;
    let winner = null;
    if (!p.alive) winner = 1; else if (!c.alive) winner = 0;
    if (winner === null) return;
    this.roundOver = true; this.wins[winner]++;
    const who = winner === 0 ? 'MONGOOSE' : (this.mode === 'duelai' ? 'KING COBRA' : 'COBRA');
    if (this.wins[winner] >= 2) this.later(2.2, () => this.gameOver(who + ' WINS THE DUEL', 'Rounds ' + this.wins[0] + ' - ' + this.wins[1]));
    else { this.banner(who + ' TAKES ROUND ' + this.round, 'Mongoose ' + this.wins[0] + ' - ' + this.wins[1] + ' Cobra', 2.6); this.later(3, () => this.startRound()); }
    if (winner === 0) { this.player.state = 'dance'; this.player.danceT = 0; SFX.celebrate(); }
  }
  // ------------------------------------------------------------ flow
  enterPlay() {
    this.state = 'play';
    for (const id of ['menu', 'pause', 'over', 'controls']) this.hud[id].classList.add('hidden');
    this.hud.hud.classList.remove('hidden');
    if (this.input.isTouch) this.hud.touch.classList.remove('hidden');
    this.hud.pName.textContent = this.mode === 'campaign' ? 'MONGOOSE' : 'MONGOOSE  (P1)';
  }
  pauseGame() { this.state = 'paused'; this.hud.pause.classList.remove('hidden'); }
  resumeGame() { this.state = 'play'; this.hud.pause.classList.add('hidden'); this.hud.controls.classList.add('hidden'); this.last = performance.now(); }
  gameOver(title, sub) {
    this.state = 'over';
    if (this.mode === 'campaign' && this.score > this.best) { this.best = this.score; store.set('best', this.best); sub += '  -  NEW BEST!'; }
    this.hud.overTitle.textContent = title; this.hud.overSub.textContent = sub; this.hud.over.classList.remove('hidden'); this.hud.touch.classList.add('hidden');
  }
  // ------------------------------------------------------------ events from entities
  onSnakeHit(s, dmg, head, from) {
    if (from && from.isClone === false && this.mode) { this.combo++; this.comboT = 2.6; }
    if (this.mode === 'campaign') this.score += Math.round(dmg * (head ? 2 : 1) * (1 + this.combo * 0.1));
    this.shake(head ? 0.22 : 0.1);
  }
  onSnakeDead(s) {
    if (this.mode === 'campaign') { const pts = Math.round(100 * this.level * (s.isBoss ? 6 : 1) * (1 + this.combo * 0.1)); this.score += pts; this.flash((s.isBoss ? 'KING COBRA DEFEATED  +' : 'SNAKE DOWN  +') + pts, '#ffd27a', 1); }
    if (s.isBoss) { this.shake(0.8); SFX.roar(0.4); }
    this.env.dust.burst(s.pts[0].x, 0.3, s.pts[0].z, 30, 3, 1, 0.4, [0x8a7558, 0x6b5a44], { up: 0.5 });
  }
  counter(m, cobra) {
    if (this.slowT > 0.2) return;
    this.slowT = CFG.COUNTER_TIME; m.counterBuff = 2.4; m.agility = Math.min(100, m.agility + 35);
    cobra.stun(1.4);
    this.flash('COUNTER-STRIKE REFLEX!', '#8dfcd0', 1.4); SFX.counter(); SFX.chatter(0.2);
    this.env.glow.burst(m.x, 0.6, m.z, 40, 4, 0.9, 0.22, [0x8dfcd0, 0xffffff, 0x5affc8], { up: 0.8 });
    this.env.ring(m.x, m.z, 0x8dfcd0, 0.3, 3, 0.7);
    if (this.mode === 'campaign') this.score += 75 * this.level;
  }
  later(sec, fn) { this.timers.push({ t: sec, fn }); }   // game-clock timer: frozen while paused
  shake(a) { this.shakeAmt = Math.min(1.2, this.shakeAmt + a); }
  flash(text, color = '#8dfcd0', dur = 1) {
    const f = this.hud.flash; f.textContent = text; f.style.color = color; f.style.opacity = 1;
    clearTimeout(this.flashTO); this.flashTO = setTimeout(() => { f.style.opacity = 0; }, dur * 1000);
  }
  banner(big, small, dur = 2.5) {
    this.hud.bannerBig.textContent = big; this.hud.bannerSmall.textContent = small || ''; this.hud.banner.style.opacity = 1;
    clearTimeout(this.bannerTO); this.bannerTO = setTimeout(() => { this.hud.banner.style.opacity = 0; }, dur * 1000);
  }
  // ------------------------------------------------------------ input -> commands
  p1Cmd() {
    const I = this.input, duel = this.mode !== 'campaign';
    let mx = 0, mz = 0;
    if (I.held('KeyA') || (!duel && I.held('ArrowLeft'))) mx -= 1; if (I.held('KeyD') || (!duel && I.held('ArrowRight'))) mx += 1;
    if (I.held('KeyW') || (!duel && I.held('ArrowUp'))) mz -= 1; if (I.held('KeyS') || (!duel && I.held('ArrowDown'))) mz += 1;
    if (I.touch.active) { mx = I.touch.x; mz = I.touch.z; }
    const cmd = {
      mx, mz,
      bite: I.pressed('KeyF', 'KeyJ') || I.mouseHit || I.touch.hit.has('bite'),
      dodge: I.pressed('Space', 'KeyK') || I.touch.hit.has('dodge'),
      screech: I.pressed('KeyQ') || I.touch.hit.has('screech'),
      whip: I.pressed('KeyE') || I.touch.hit.has('whip'),
      antidote: I.pressed('KeyR') || I.touch.hit.has('antidote'),
      clones: I.pressed('KeyC') || I.touch.hit.has('clones'),
    };
    const pad = I.pad(0);
    if (pad) { if (pad.x || pad.z) { cmd.mx = pad.x; cmd.mz = pad.z; } cmd.bite ||= pad.hit.a; cmd.dodge ||= pad.hit.b; cmd.screech ||= pad.hit.x; cmd.whip ||= pad.hit.y; cmd.antidote ||= pad.hit.lb; cmd.clones ||= pad.hit.rb; if (pad.hit.start) this.pauseGame(); }
    return cmd;
  }
  p2Cmd() {
    const I = this.input; let mx = 0, mz = 0;
    if (I.held('ArrowLeft')) mx -= 1; if (I.held('ArrowRight')) mx += 1; if (I.held('ArrowUp')) mz -= 1; if (I.held('ArrowDown')) mz += 1;
    const cmd = { mx, mz, strike: I.pressed('Enter', 'NumpadEnter', 'Numpad0'), spit: I.pressed('ShiftRight', 'Numpad1'), burrow: I.pressed('ControlRight', 'Numpad2'), gaze: I.pressed('Slash', 'Numpad3') };
    const pad = I.pad(1);
    if (pad) { if (pad.x || pad.z) { cmd.mx = pad.x; cmd.mz = pad.z; } cmd.strike ||= pad.hit.a; cmd.spit ||= pad.hit.b; cmd.burrow ||= pad.hit.x; cmd.gaze ||= pad.hit.y; }
    return cmd;
  }
  // ------------------------------------------------------------ main loop
  loop(now) {
    requestAnimationFrame((t) => this.loop(t));
    const realDt = Math.min(0.05, (now - this.last) / 1000); this.last = now;
    this.realDt = realDt; this.realTime += realDt;
    const I = this.input;
    // global keys
    if (I.pressed('KeyM')) this.flash(SFX.toggleMute() ? 'SOUND OFF' : 'SOUND ON', '#ffd98a', 0.8);
    if (I.pressed('KeyG')) { this.quality = this.quality === 'high' ? 'low' : 'high'; this.applyQuality(); this.flash('GRAPHICS: ' + this.quality.toUpperCase(), '#ffd98a', 0.8); }
    if (this.state === 'menu') {
      if (I.pressed('Digit1', 'Numpad1', 'Enter')) { SFX.ui(); this.startCampaign(); }
      else if (I.pressed('Digit2', 'Numpad2')) { SFX.ui(); this.startDuel(false); }
      else if (I.pressed('Digit3', 'Numpad3')) { SFX.ui(); this.startDuel(true); }
      else if (I.pressed('KeyH')) this.act('controls');
      else if (I.pressed('Escape') && !this.hud.controls.classList.contains('hidden')) this.act('back');
    } else if (this.state === 'play') {
      if (I.pressed('KeyP', 'Escape') || I.touch.hit.has('pause')) this.pauseGame();
    } else if (this.state === 'paused') {
      if (I.pressed('KeyP', 'Escape')) { if (!this.hud.controls.classList.contains('hidden')) this.act('back'); else this.resumeGame(); }
    } else if (this.state === 'over') {
      if (I.pressed('Enter', 'Space')) this.act('retry'); else if (I.pressed('Escape')) this.showMenu();
    }
    if (I.wheel) this.userZoom = clamp(this.userZoom + I.wheel * 0.08, 0.55, 1.7);

    if (this.state === 'play' || this.state === 'menu' || this.state === 'over') this.step(realDt);
    this.updateCamera(realDt);
    if (this.state !== 'menu') this.updateHud();
    this.renderer.render(this.scene, this.camera);
    I.endFrame();
    this.autoQuality(realDt);
  }
  step(realDt) {
    // bullet time after a counter-strike reflex
    if (this.slowT > 0) { this.slowT -= realDt; this.timeScale = this.slowT > 0.35 ? CFG.COUNTER_SLOWMO : lerp(1, CFG.COUNTER_SLOWMO, this.slowT / 0.35); } else this.timeScale = 1;
    const dt = realDt * this.timeScale, pdt = realDt * Math.max(this.timeScale, 0.7);
    this.time += dt;
    const p = this.player;
    if (this.state === 'menu') { this.menuStep(realDt); this.env.update(realDt, { x: 0, z: 0 }); return; }
    const playing = this.state === 'play';
    if (playing) { for (const t of this.timers) t.t -= realDt; const due = this.timers.filter((t) => t.t <= 0); this.timers = this.timers.filter((t) => t.t > 0); for (const t of due) t.fn(); }
    if (p) p.update(pdt, playing && !this.celebrating && p.alive ? this.p1Cmd() : { mx: 0, mz: 0 });
    for (const c of this.clones) c.update(dt, cloneCmd(c, dt));
    this.clones = this.clones.filter((c) => !c.gone);
    if (this.mode === 'duel2p' && this.duelCobra) this.duelCobra.cmd = playing ? this.p2Cmd() : {};
    for (const s of this.snakes) s.update(dt);
    for (const s of this.snakes) if (s.done) s.remove();
    this.snakes = this.snakes.filter((s) => !s.done);
    for (const b of this.blobs) { b.update(dt); if (b.dead) b.remove(); }
    this.blobs = this.blobs.filter((b) => !b.dead);
    for (const pd of this.puddles) {
      pd.t -= dt;
      for (const m of this.mongooses()) if (dist2(m.x, m.z, pd.x, pd.z) < pd.r && m.state !== 'dodge') { m.hurt(5 * dt, null, true); m.poison(2); }
    }
    this.puddles = this.puddles.filter((pd) => pd.t > 0);
    if (playing) {
      if (this.mode === 'campaign') {
        if (this.celebrating) this.celebrateTick(dt); else this.campaignTick(dt);
        if (p && !p.alive && !this.overPending) { this.overPending = true; this.later(2.2, () => { this.overPending = false; this.gameOver('FALLEN IN THE JUNGLE', 'Level ' + this.level + '   Score ' + this.score); }); }
      } else this.duelTick();
    }
    this.env.update(dt, p || { x: 0, z: 0 });
  }
  menuStep(dt) {
    this.menuT += dt; const p = this.player, c = this.snakes[0];
    if (!p || !c) return;
    const a = this.menuT * 0.5, tx = c.x + Math.cos(a) * 4.2, tz = c.z + Math.sin(a) * 4.2;
    const dx = tx - p.x, dz = tz - p.z, d = Math.hypot(dx, dz);
    p.update(dt, { mx: d > 0.3 ? dx / d * Math.min(1, d) * 0.45 : 0, mz: d > 0.3 ? dz / d * Math.min(1, d) * 0.45 : 0 });
    p.fluff = 1;
    c.cmd = {}; c.update(dt);
  }
  updateCamera(dt) {
    let tx = 0, tz = 0, off = new THREE.Vector3(0, 7.6, 9.2), look = new THREE.Vector3();
    const p = this.player;
    if (this.state === 'menu') {
      const a = this.menuT * 0.12; off.set(Math.sin(a) * 9, 3.6, Math.cos(a) * 9); tx = 0; tz = -0.5;
    } else if (p) {
      tx = p.x; tz = p.z; let z = this.userZoom;
      if (this.mode !== 'campaign' && this.duelCobra && this.duelCobra.alive) {   // keep both duellists in frame
        const c = this.duelCobra, sep = dist2(p.x, p.z, c.x, c.z); tx = (p.x + c.x) / 2; tz = (p.z + c.z) / 2; z *= clamp(0.75 + sep / 18, 0.8, 1.6);
      } else {
        let far = 0; for (const s of this.snakes) if (s.alive) far = Math.max(far, dist2(p.x, p.z, s.x, s.z));
        z *= clamp(0.85 + far / 40, 0.85, 1.25);
      }
      if (this.slowT > 0) z *= 0.62;
      this.zoom = lerp(this.zoom, z, Math.min(1, dt * 3));
      off.multiplyScalar(this.zoom);
      if (this.celebrating || (p.state === 'dance' && this.mode !== 'campaign' && this.roundOver)) { this.orbitA = (this.orbitA || 0) + dt * 0.9; off.set(Math.sin(this.orbitA) * 6, 3.2, Math.cos(this.orbitA) * 6); }
    }
    const want = new THREE.Vector3(tx, 0, tz).add(off);
    this.camPos.lerp(want, Math.min(1, dt * 5));
    look.set(tx, 0.6, tz); this.camLook.lerp(look, Math.min(1, dt * 7));
    this.camera.position.copy(this.camPos);
    if (this.shakeAmt > 0.001) { const s = this.shakeAmt * 0.35; this.camera.position.x += rand(-s, s); this.camera.position.y += rand(-s, s); this.camera.position.z += rand(-s, s); this.shakeAmt *= Math.pow(0.02, dt); }
    this.camera.lookAt(this.camLook);
    this.camera.fov = lerp(this.camera.fov, this.slowT > 0 ? 44 : 50, Math.min(1, dt * 4)); this.camera.updateProjectionMatrix();
  }
  updateHud() {
    const h = this.hud, p = this.player; if (!p) return;
    h.hpFill.style.width = (100 * p.hp / p.maxHp).toFixed(1) + '%'; h.hpTxt.textContent = Math.ceil(p.hp) + ' / ' + p.maxHp;
    h.agiFill.style.width = p.agility.toFixed(0) + '%'; h.agiTxt.textContent = Math.floor(p.agility);
    h.hypFill.style.width = (p.hypno * 100).toFixed(0) + '%';
    const showHyp = p.hypno > 0.01 || p.hypnoT > 0; h.hypBar.style.display = h.hypLbl.style.display = showHyp ? '' : 'none';
    h.venomTag.classList.toggle('hidden', !(p.venomT > 0)); h.hypTag.classList.toggle('hidden', !(p.hypnoT > 0));
    // screen tint: green venom pulse, purple hypnosis swirl, cyan bullet time
    let vig = '', vo = 0;
    if (this.slowT > 0) { vig = 'radial-gradient(ellipse at center, rgba(0,0,0,0) 45%, rgba(40,255,200,.35))'; vo = 1; }
    else if (p.hypnoT > 0 || p.hypno > 0.3) { vig = 'radial-gradient(ellipse at center, rgba(0,0,0,0) 35%, rgba(170,60,255,.55))'; vo = Math.max(p.hypno, p.hypnoT > 0 ? 1 : 0); }
    else if (p.venomT > 0) { vig = 'radial-gradient(ellipse at center, rgba(0,0,0,0) 50%, rgba(60,220,30,.4))'; vo = 0.6 + 0.4 * Math.sin(this.realTime * 6); }
    else if (p.hurtT > 0) { vig = 'radial-gradient(ellipse at center, rgba(0,0,0,0) 50%, rgba(220,20,20,.5))'; vo = p.hurtT / 0.4; }
    if (vig) h.vignette.style.background = vig; h.vignette.style.opacity = vo;
    if (this.mode === 'campaign') {
      h.levelTxt.textContent = 'LEVEL ' + this.level; h.todTxt.textContent = this.env.tod.name;
      h.scoreTxt.textContent = 'Score ' + this.score; h.hiTxt.textContent = 'Best ' + Math.max(this.best, this.score);
      const left = this.queue.length + this.snakes.filter((s) => s.alive).length; h.snakesTxt.textContent = left + ' snake' + (left === 1 ? '' : 's') + ' left';
    } else {
      h.levelTxt.textContent = 'ROUND ' + this.round; h.todTxt.textContent = this.env.tod.name;
      h.scoreTxt.textContent = 'Mongoose ' + this.wins[0] + '  -  ' + this.wins[1] + ' Cobra'; h.hiTxt.textContent = 'Best of 3';
      const c = this.duelCobra;
      if (c && this.mode === 'duel2p') { const r = (k) => (c.cd[k] > 0 ? Math.ceil(c.cd[k]) + 's' : 'ready'); h.snakesTxt.textContent = `Strike ${r('strike')} | Spit ${r('spit')} | Burrow ${r('burrow')} | Gaze ${r('gaze')}`; }
      else h.snakesTxt.textContent = '';
    }
    h.comboTxt.textContent = this.combo > 1 ? 'COMBO x' + this.combo : '';
    // boss / duel cobra bar
    const boss = this.mode === 'campaign' ? this.snakes.find((s) => s.isBoss && s.alive) : (this.duelCobra && this.duelCobra.alive ? this.duelCobra : null);
    h.bossPanel.classList.toggle('hidden', !boss);
    if (boss) { h.bossName.textContent = (this.mode === 'duel2p' ? 'P2  ' : '') + boss.name.toUpperCase(); h.bossFill.style.width = (100 * boss.hp / boss.maxHp).toFixed(1) + '%'; }
    // ability bar
    const cdInfo = { bite: [p.biteCd, CFG.BITE_CD, true], dodge: [p.agility < CFG.DODGE_COST ? (CFG.DODGE_COST - p.agility) / CFG.AGI_REGEN : 0, CFG.DODGE_COST / CFG.AGI_REGEN, true], screech: [p.cd.screech, CFG.SCREECH_CD, p.unlocked.screech], whip: [p.cd.whip, CFG.WHIP_CD, p.unlocked.whip], antidote: [p.cd.antidote, CFG.ANTIDOTE_CD, p.unlocked.antidote], clones: [p.cd.clones, CFG.CLONE_CD, p.unlocked.clones] };
    for (const k in cdInfo) {
      const [cd, max, un] = cdInfo[k], e = this.abEls[k];
      e.el.classList.toggle('locked', !un); e.el.classList.toggle('ready', un && cd <= 0);
      e.cd.style.height = (un ? clamp(cd / max, 0, 1) * 100 : 100) + '%';
    }
  }
  autoQuality(dt) {   // drop to low graphics automatically if the laptop struggles
    if (this.quality !== 'high' || this.autoDropped) return;
    this.fpsT += dt; this.fpsN++;
    if (this.fpsT > 4) { const fps = this.fpsN / this.fpsT; this.fpsT = 0; this.fpsN = 0; if (fps < 32) { this.autoDropped = true; this.quality = 'low'; this.applyQuality(); this.flash('GRAPHICS: LOW (auto)', '#ffd98a', 1.2); } }
  }
}

addEventListener('load', () => { new Game(); });
