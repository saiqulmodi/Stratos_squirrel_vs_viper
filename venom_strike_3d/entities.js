/* =====================================================================
   entities.js - gameplay actors.
   Mongoose  : player / shadow clone. Run, bite-leap, dodge-roll, agility,
               counter-strike reflex, screech, tail-whip, antidote, clones.
   Cobra     : AI or human-steered (duel). State machine:
               prowl -> coil (alert) -> windup -> strike -> recover,
               spit (venom arc), gaze (hypnosis), burrow -> under -> erupt,
               stunned, dead.
   VenomBlob : spat venom projectile; leaves a venom puddle where it lands.
   All gameplay happens on the XZ plane; G is the running Game (game.js).
   ===================================================================== */
'use strict';

// ---------------------------------------------------------------- mongoose
class Mongoose {
  constructor(x, z, opts = {}) {
    this.x = x; this.z = z; this.vx = 0; this.vz = 0; this.heading = opts.heading || 0;
    this.isClone = !!opts.clone; this.pid = opts.pid || 1;
    this.model = new MongooseModel(this.isClone ? 'clone' : (this.pid === 2 ? 'p2' : 'p1'), { scale: this.isClone ? 0.85 : 1.1 });
    G.scene.add(this.model.group);
    this.maxHp = opts.hp || CFG.M_HP; this.hp = this.maxHp; this.agility = 100;
    this.state = 'free'; this.stateT = 0; this.alive = true;
    this.biteCd = 0; this.biteHitDone = false; this.aim = 0; this.lunge = 0;
    this.invuln = 0; this.lastDodge = -99; this.counterBuff = 0;
    this.venomT = 0; this.hypno = 0; this.hypnoT = 0; this.haste = 0; this.hurtT = 0;
    this.cd = { screech: 0, whip: 0, antidote: 0, clones: 0 };
    this.unlocked = opts.unlocked || { screech: false, whip: false, antidote: false, clones: false };
    this.life = opts.life || 0; this.atkMult = opts.atkMult || 1; this.danceT = 0; this.roll = 0;
    this.fluff = 0;
    this.hidden = false; this.hideT = 0; this.hideCd = 0; this.ambushT = 0;   // burrow hiding (user, 2026-10-13: 'mongoose can hide in holes')
  }
  get speedNow() { return CFG.M_SPEED * (this.isClone ? 0.85 : 1) * (this.hypnoT > 0 ? 0.3 : 1) * (this.haste > 0 ? 1.35 : 1); }
  nearestSnake(maxD = 999) {
    let best = null, bd = maxD;
    for (const s of G.snakes) { if (!s.targetable()) continue; const d = dist2(this.x, this.z, s.x, s.z); if (d < bd) { bd = d; best = s; } }
    return best;
  }
  // cmd = {mx, mz, bite, dodge, screech, whip, antidote, clones}
  update(dt, cmd) {
    if (!this.alive) return;
    this.stateT += dt; this.biteCd -= dt; this.invuln -= dt; this.hurtT -= dt; this.haste -= dt; this.counterBuff -= G.realDt;
    for (const k in this.cd) this.cd[k] -= dt;
    this.hideCd -= dt; this.ambushT -= G.realDt;
    this.agility = Math.min(100, this.agility + CFG.AGI_REGEN * dt);
    if (this.venomT > 0) { this.venomT -= dt; this.hurt(CFG.VENOM_DPS * dt, null, true); if (Math.random() < dt * 8) G.env.glow.emit(this.x + rand(-0.3, 0.3), 0.6, this.z + rand(-0.3, 0.3), 0, 0.8, 0, 0.6, 0.12, 0x7dff3a, 0.8); }
    if (this.hypnoT > 0) this.hypnoT -= dt; else this.hypno = Math.max(0, this.hypno - dt * 0.35);
    if (this.isClone) { this.life -= dt; if (this.life <= 0) { this.vanish(); return; } }

    if (this.state === 'hidden') { this.updateHidden(dt, cmd); return; }
    // --- movement intent
    let mx = cmd.mx || 0, mz = cmd.mz || 0; const ml = Math.hypot(mx, mz); if (ml > 1) { mx /= ml; mz /= ml; }
    if (this.state === 'free' || this.state === 'dance') {
      const tvx = mx * this.speedNow, tvz = mz * this.speedNow, k = Math.min(1, CFG.M_ACCEL * dt / Math.max(1, this.speedNow));
      this.vx = lerp(this.vx, tvx, k); this.vz = lerp(this.vz, tvz, k);
      if (ml > 0.1) this.heading += angDiff(this.heading, Math.atan2(mz, mx)) * Math.min(1, dt * 14);
      else { const s = this.nearestSnake(7); if (s) this.heading += angDiff(this.heading, Math.atan2(s.z - this.z, s.x - this.x)) * Math.min(1, dt * 6); }
    }
    // --- actions
    if (this.state === 'free') {
      if (cmd.hide && !this.isClone) { this.tryHide(); if (this.state === 'hidden') return; }
      if (cmd.dodge) this.tryDodge(mx, mz);
      else if (cmd.bite) this.tryBite();
      if (!this.isClone && this.state === 'free') {
        if (cmd.screech) this.screech(); if (cmd.whip) this.tailWhip(); if (cmd.antidote) this.antidote(); if (cmd.clones) this.summonClones();
      }
    } else if (this.state === 'bite') {
      const k = this.stateT / CFG.BITE_TIME;
      const sp = CFG.BITE_LUNGE / CFG.BITE_TIME;
      this.vx = Math.cos(this.aim) * sp; this.vz = Math.sin(this.aim) * sp;
      this.lunge = clamp(k, 0, 1);
      if (!this.biteHitDone && k >= 0.55) { this.biteHitDone = true; this.resolveBite(); }
      if (k >= 1) { this.state = 'free'; this.vx *= 0.25; this.vz *= 0.25; this.lunge = 0; }
    } else if (this.state === 'dodge') {
      const k = this.stateT / CFG.DODGE_TIME, sp = CFG.DODGE_DIST / CFG.DODGE_TIME * (1.4 - k * 0.8);
      this.vx = Math.cos(this.dodgeAng) * sp; this.vz = Math.sin(this.dodgeAng) * sp;
      this.roll = k * TAU * (this.rollDir || 1);
      if (Math.random() < 0.6) G.env.dust.emit(this.x, 0.1, this.z, rand(-1, 1), rand(0.5, 1.5), rand(-1, 1), 0.6, 0.35, 0x9a8466, 0.5, 0, 2, 0.6);
      if (k >= 1) { this.state = 'free'; this.roll = 0; }
    } else if (this.state === 'hurt') {
      this.vx *= 1 - Math.min(1, dt * 6); this.vz *= 1 - Math.min(1, dt * 6);
      if (this.stateT > 0.25) this.state = 'free';
    } else if (this.state === 'dance') {
      this.danceT += dt;
      if (this.whipSpin > 0) { this.whipSpin -= dt; if (this.whipSpin <= 0) this.state = 'free'; }
    }
    // --- integrate & keep inside the clearing
    this.x += this.vx * dt; this.z += this.vz * dt;
    const r = Math.hypot(this.x, this.z), lim = CFG.ARENA_R + 2;
    if (r > lim) { this.x *= lim / r; this.z *= lim / r; }
    if (Math.hypot(this.vx, this.vz) > 6 && this.state === 'free' && Math.random() < 0.5) G.env.dust.emit(this.x - this.vx * 0.04, 0.08, this.z - this.vz * 0.04, rand(-0.4, 0.4), rand(0.3, 0.9), rand(-0.4, 0.4), 0.5, 0.28, 0x8a7558, 0.45, 0, 2, 0.8);
    // --- fluff up when a cobra is close or rearing
    const near = this.nearestSnake(6.5); this.fluff = near ? (near.rise > 0.5 ? 1 : 0.6) : 0;
    this.render(dt);
  }
  render(dt) {
    const m = this.model;
    // hidden in a burrow: only the head peeks out of the hole (the ground hides the rest)
    m.group.position.set(this.x, this.hidden ? -0.8 + 0.05 * Math.sin(G.time * 2.5) : 0, this.z); m.group.rotation.y = yawFor(this.heading);
    const spd = Math.min(1, Math.hypot(this.vx, this.vz) / CFG.M_SPEED);
    const lift = this.state === 'bite' ? Math.sin(this.lunge * Math.PI) * 0.45 : 0;
    const glow = this.isClone ? 0.8 : Math.max(this.counterBuff > 0 ? 1 : 0, this.agility >= 99 ? 0.25 : 0.08, this.state === 'dodge' ? 0.8 : 0);
    m.animate(dt, { speed: this.state === 'dance' ? 0.4 : spd, lift, roll: this.roll, bite: this.state === 'bite' ? this.lunge : 0, fluff: this.state === 'dance' ? 1 : this.fluff, glow, dance: this.state === 'dance', t: G.time });
    if (this.state === 'dance') { m.group.rotation.y += this.danceT * 6; m.root.position.y += Math.abs(Math.sin(this.danceT * 7)) * 0.6; }
    if (this.hidden) { m.root.rotation.x = -1.2; m.root.position.y = 0; m.neck.rotation.x = 0.95; m.blob.visible = false; }   // stands upright in the burrow: head and neck poke out
    else m.blob.visible = true;
    m.root.visible = !(this.hurtT > 0 && Math.floor(this.hurtT * 30) % 2 === 0);
  }
  nearHole(maxD = 2.2) {
    let best = null, bd = maxD;
    for (const h of G.env.holes) { const d = dist2(this.x, this.z, h.x, h.z); if (d < bd) { bd = d; best = h; } }
    return best;
  }
  tryHide() {
    const h = this.nearHole();
    if (!h) { G.flash('NO BURROW HERE - run to a hole', '#ffd98a', 0.8); return; }
    if (this.hideCd > 0) { G.flash('CATCHING BREATH ' + Math.ceil(this.hideCd) + 's', '#ffd98a', 0.6); return; }
    this.state = 'hidden'; this.stateT = 0; this.hidden = true; this.hideT = 0; this.hole = h;
    this.x = h.x; this.z = h.z; this.vx = this.vz = 0; this.roll = 0; this.hypno = 0; this.hypnoT = 0;
    G.env.dust.burst(h.x, 0.15, h.z, 26, 3.5, 0.7, 0.35, [0x8a6a44, 0x6b5034, 0xa88660], { up: 0.8, grav: 6 });
    SFX.swoosh(0.25); SFX.chatter(0.14);
    G.flash('HIDDEN IN THE BURROW', '#ffd98a', 0.9);
  }
  updateHidden(dt, cmd) {
    this.hideT += dt;
    this.agility = Math.min(100, this.agility + 60 * dt);          // gets its breath back fast underground
    if (this.venomT > 0) this.venomT -= dt;                         // venom wears off twice as fast in the cool earth
    const s = this.nearestSnake(30);
    if (s) this.heading += angDiff(this.heading, Math.atan2(s.z - this.z, s.x - this.x)) * Math.min(1, dt * 5);   // peeks out, watching the cobra
    const out = this.hideT > 0.3 && (cmd.hide || cmd.bite || cmd.dodge || Math.hypot(cmd.mx || 0, cmd.mz || 0) > 0.5);
    if (out || this.hideT > 4) {
      this.hidden = false; this.state = 'free'; this.stateT = 0; this.hideCd = 5; this.ambushT = 1.6; this.invuln = 0.25;
      G.env.dust.burst(this.x, 0.2, this.z, 30, 4.5, 0.7, 0.35, [0x8a6a44, 0x6b5034, 0xa88660], { up: 1, grav: 7 });
      SFX.swoosh(0.3);
      if (cmd.bite) this.tryBite();                                  // burst out straight into an ambush bite
    }
    this.render(dt);
  }
  tryBite() {
    if (this.biteCd > 0) return;
    // auto-aim at the nearest head (or body) within a generous cone so 3D feels fair
    const s = this.nearestSnake(this.counterBuff > 0 ? 7 : 4.2);
    if (s) { const p = s.closestPart(this.x, this.z, true); this.aim = Math.atan2(p.z - this.z, p.x - this.x); }
    else this.aim = this.heading;
    this.heading = this.aim; this.state = 'bite'; this.stateT = 0; this.biteHitDone = false; this.biteCd = CFG.BITE_CD;
    SFX.swoosh(0.18);
  }
  resolveBite() {
    const jx = this.x + Math.cos(this.aim) * CFG.BITE_RANGE * 0.7, jz = this.z + Math.sin(this.aim) * CFG.BITE_RANGE * 0.7;
    let best = null, bestD = 99, head = false;
    for (const s of G.snakes) {
      if (!s.targetable()) continue;
      const hd = dist2(jx, jz, s.spine(0).x, s.spine(0).z);
      // a reared-up head is out of reach: head bites land when it is low, striking, recovering, stunned, or on a counter
      const headOpen = s.spine(0).y < 0.75 * s.size || ['strike', 'recover', 'stunned', 'prowl', 'under', 'dead'].includes(s.state) || (this.counterBuff > 0 && !this.isClone) || this.ambushT > 0;
      if (headOpen && hd < 0.95 * s.size && hd < bestD) { best = s; bestD = hd; head = true; continue; }
      const p = s.closestPart(jx, jz, false);
      if (p.d < 0.75 * s.size && p.d < bestD) { best = s; bestD = p.d; head = false; }
    }
    if (!best) return;
    let dmg = CFG.BITE_DMG * this.atkMult * (head ? 1 : 0.5);
    let crit = false;
    if (this.counterBuff > 0 && !this.isClone) { dmg *= CFG.COUNTER_MULT; crit = true; this.counterBuff = 0; }
    else if (this.ambushT > 0 && !this.isClone) { dmg *= 1.6; this.ambushT = 0; G.flash('AMBUSH BITE!', '#ffd27a', 0.8); }
    best.takeHit(dmg, head, this, crit);
    SFX.bite(); if (!this.isClone && Math.random() < 0.35) SFX.chatter();
  }
  tryDodge(mx, mz) {
    if (this.hypnoT > 0) {   // shaking off hypnosis
      this.hypnoBreak = (this.hypnoBreak || 0) + 1; G.env.glow.burst(this.x, 0.8, this.z, 8, 2, 0.4, 0.15, 0xc78cff);
      if (this.hypnoBreak >= 2) { this.hypnoT = 0; this.hypno = 0; this.hypnoBreak = 0; G.flash('BROKE FREE!', '#e3b8ff'); }
      return;
    }
    if (this.agility < CFG.DODGE_COST) { if (!this.isClone) G.flash('NO AGILITY', '#ff8a6a', 0.5); return; }
    this.agility -= CFG.DODGE_COST;
    let ang;
    if (Math.hypot(mx, mz) > 0.2) ang = Math.atan2(mz, mx);
    else { const s = this.nearestSnake(10); ang = s ? Math.atan2(this.z - s.z, this.x - s.x) + 0.6 : this.heading + Math.PI; }
    this.dodgeAng = ang; this.rollDir = angDiff(this.heading, ang) > 0 ? -1 : 1;
    this.state = 'dodge'; this.stateT = 0; this.invuln = CFG.DODGE_TIME + 0.05; this.lastDodge = G.realTime;
    SFX.swoosh();
  }
  screech() {
    if (!this.unlocked.screech || this.cd.screech > 0) return; this.cd.screech = CFG.SCREECH_CD;
    G.env.cone(this.x, this.z, this.heading, CFG.SCREECH_RANGE, 0x8dfcd0, 0.55);
    G.env.cone(this.x, this.z, this.heading, CFG.SCREECH_RANGE * 0.7, 0xffffff, 0.4);
    SFX.screech(); G.shake(0.25);
    for (const s of G.snakes) {
      if (!s.targetable()) continue;
      const d = dist2(this.x, this.z, s.x, s.z), a = Math.abs(angDiff(this.heading, Math.atan2(s.z - this.z, s.x - this.x)));
      if (d < CFG.SCREECH_RANGE && a < CFG.SCREECH_ARC + 0.25) { s.stun(CFG.SCREECH_STUN); s.takeHit(5 * this.atkMult, false, this, false); }
    }
  }
  tailWhip() {
    if (!this.unlocked.whip || this.cd.whip > 0) return; this.cd.whip = CFG.WHIP_CD;
    this.state = 'dance'; this.stateT = 0; this.danceT = 0; this.whipSpin = 0.28;
    G.env.ring(this.x, this.z, 0xffd27a, 0.3, CFG.WHIP_RANGE, 0.5); G.env.ring(this.x, this.z, 0x8dfcd0, 0.2, CFG.WHIP_RANGE * 0.7, 0.4);
    G.env.dust.burst(this.x, 0.15, this.z, 40, 7, 0.8, 0.45, [0x8a7558, 0x6b5a44, 0xa89070], { up: 0.25, drag: 3 });
    SFX.shockwave(); G.shake(0.45);
    for (const s of G.snakes) {
      if (!s.targetable()) continue;
      const p = s.closestPart(this.x, this.z, false);
      if (p.d < CFG.WHIP_RANGE) { const a = Math.atan2(s.z - this.z, s.x - this.x); s.knock(Math.cos(a) * CFG.WHIP_PUSH, Math.sin(a) * CFG.WHIP_PUSH); s.stun(CFG.WHIP_STUN); s.takeHit(CFG.BITE_DMG * 0.8 * this.atkMult, false, this, false); }
    }
    for (const b of G.blobs) if (dist2(b.x, b.z, this.x, this.z) < CFG.WHIP_RANGE) b.dead = true;   // swats venom out of the air
  }
  antidote() {
    if (!this.unlocked.antidote || this.cd.antidote > 0) return; this.cd.antidote = CFG.ANTIDOTE_CD;
    this.venomT = 0; this.hp = Math.min(this.maxHp, this.hp + CFG.ANTIDOTE_HEAL); this.haste = CFG.ANTIDOTE_HASTE; this.hypnoT = 0; this.hypno = 0;
    this.agility = 100; G.env.glow.burst(this.x, 0.6, this.z, 40, 3, 0.9, 0.22, [0x9dffb0, 0xffffff, 0x8dfcd0], { up: 1 });
    SFX.antidote(); G.flash('ANTIDOTE BOOST', '#9dffb0', 0.8);
  }
  summonClones() {
    if (!this.unlocked.clones || this.cd.clones > 0) return; this.cd.clones = CFG.CLONE_CD;
    for (let i = 0; i < CFG.CLONE_COUNT; i++) {
      const a = this.heading + (i - 1) * 1.2 + Math.PI, c = new Mongoose(this.x + Math.cos(a) * 1.5, this.z + Math.sin(a) * 1.5, { clone: true, life: CFG.CLONE_TIME, atkMult: this.atkMult * 0.45, heading: this.heading });
      G.clones.push(c); G.env.glow.burst(c.x, 0.5, c.z, 20, 2.5, 0.6, 0.25, [0xb48cff, 0x5a3a9a]);
    }
    SFX.clones(); G.flash('SHADOW PACK!', '#c9a8ff', 0.8);
  }
  // returns true if the hit landed
  hurt(amount, from, silent) {
    if (!this.alive) return false;
    if (!silent && this.invuln > 0) return false;
    this.hp -= amount;
    if (!silent) {
      this.hurtT = 0.4; SFX.hurt(); G.shake(0.35);
      if (from) { const a = Math.atan2(this.z - from.z, this.x - from.x); this.vx = Math.cos(a) * 9; this.vz = Math.sin(a) * 9; this.state = 'hurt'; this.stateT = 0; this.roll = 0; }
      G.env.dust.burst(this.x, 0.5, this.z, 14, 3, 0.5, 0.18, [0x9a1c1c, 0x6a0f0f], { grav: 9 });
      if (this.isClone) { this.vanish(); return true; }
    }
    if (this.hp <= 0) { this.hp = 0; this.die(); }
    return true;
  }
  poison(t) { if (this.isClone) return; this.venomT = Math.max(this.venomT, t); }
  die() {
    this.alive = false;
    if (this.isClone) { this.vanish(); return; }
    this.model.root.rotation.z = Math.PI / 2; this.model.root.position.y = 0.2;
    G.env.dust.burst(this.x, 0.3, this.z, 50, 4, 1.2, 0.5, [0x8a7558, 0x6b5a44], { up: 0.5 });
  }
  vanish() {
    this.alive = false; this.gone = true;
    G.env.glow.burst(this.x, 0.5, this.z, 26, 3, 0.7, 0.28, [0xb48cff, 0x3a2a6a]);
    G.scene.remove(this.model.group); this.model.dispose();
  }
  remove() { if (!this.gone) { G.scene.remove(this.model.group); this.model.dispose(); this.gone = true; } }
}

// Clone brain: hunt the nearest snake, bite when close
function cloneCmd(c, dt) {
  const s = c.nearestSnake(60); if (!s) return { mx: 0, mz: 0 };
  const p = s.closestPart(c.x, c.z, true), dx = p.x - c.x, dz = p.z - c.z, d = Math.hypot(dx, dz);
  c.thinkT = (c.thinkT || 0) - dt;
  if (d < 1.6 && c.thinkT <= 0) { c.thinkT = rand(0.6, 1.1); return { mx: 0, mz: 0, bite: true }; }
  const side = Math.sin(G.time * 2 + c.x) * 0.6;
  return { mx: dx / d + (-dz / d) * side * (d < 4 ? 1 : 0), mz: dz / d + (dx / d) * side * (d < 4 ? 1 : 0) };
}

// ---------------------------------------------------------------- cobra
class Cobra {
  constructor(x, z, opts = {}) {
    this.level = opts.level || 1; this.isBoss = !!opts.boss; this.human = !!opts.human;
    this.size = opts.size || (this.isBoss ? 1.55 : 1.0);
    const look = opts.look || (this.isBoss ? 'boss' : this.human ? 'p2' : ['ai', 'viper', 'p2'][(Math.random() * 3) | 0]);   // green, yellow and red snakes
    this.model = new CobraModel(look, this.size); G.scene.add(this.model.group);
    this.name = COBRA_LOOKS[look].name;
    const L = this.level;
    this.maxHp = opts.hp || Math.round((55 + L * 14) * (this.isBoss ? 3.4 : 1)); this.hp = this.maxHp;
    this.dmg = opts.dmg || (9 + L * 1.15) * (this.isBoss ? 1.35 : 1);
    this.speed = opts.speed || Math.min(5.6, 3.0 + L * 0.13) * (this.isBoss ? 1.1 : 1);
    this.windup = opts.windup || Math.max(this.isBoss ? 0.3 : 0.34, 0.62 - L * 0.022);
    this.reach = 2.6 * this.size;
    this.x = x; this.z = z; this.heading = opts.heading !== undefined ? opts.heading : Math.atan2(-z, -x);
    this.trail = []; this.resetTrail();
    this.state = opts.emerge ? 'erupt' : 'prowl'; this.stateT = 0; this.alive = true;
    this.rise = 0; this.coil = 0; this.hood = 0; this.jaw = 0; this.ext = 0; this.sink = opts.emerge ? 1 : 0; this.eye = 0;
    this.aim = this.heading; this.coilBase = this.heading; this.kx = 0; this.kz = 0; this.flashT = 0;
    this.cd = { strike: rand(0.5, 1.2), spit: rand(2, 4), gaze: rand(4, 7), burrow: rand(5, 9) };
    this.can = opts.can || { spit: this.isBoss || L >= 2, gaze: this.isBoss || L >= 3, burrow: this.isBoss || L >= 4 };
    this.pts = this.model.spine; this.mound = null; this.hitThisStrike = false; this.wob = rand(TAU);
    this.cmd = {}; this.spawnOnly = !!opts.spawnOnly;
    if (opts.emerge) { this.coil = 1; this.coilBase = this.heading; }
    this.buildSpine(0);
  }
  resetTrail() {
    this.trail.length = 0;
    const back = this.heading + Math.PI;
    for (let i = 1; i <= CFG.SNAKE_SEGS * 2 + 12; i++) { const w = Math.sin(i * 0.18) * 0.35; this.trail.push({ x: this.x + Math.cos(back) * i * CFG.SNAKE_SPACING * 0.5 * this.size + Math.cos(back + Math.PI / 2) * w, z: this.z + Math.sin(back) * i * CFG.SNAKE_SPACING * 0.5 * this.size + Math.sin(back + Math.PI / 2) * w }); }
  }
  spine(i) { return this.pts[i]; }
  targetable() { return this.alive && this.sink < 0.5; }
  closestPart(x, z, preferHead) {
    const h = this.pts[0]; let best = { x: h.x, z: h.z, d: dist2(x, z, h.x, h.z), i: 0 };
    if (preferHead && best.d < 4) return best;
    for (let i = 2; i < this.pts.length; i += 2) { const p = this.pts[i], d = dist2(x, z, p.x, p.z); if (d < best.d) best = { x: p.x, z: p.z, d, i }; }
    return best;
  }
  pickTarget() {
    let best = null, bd = 1e9;
    for (const m of G.mongooses()) { if (!m.alive || m.hidden) continue; const d = dist2(this.x, this.z, m.x, m.z) + (m.isClone ? 1.5 : 0); if (d < bd) { bd = d; best = m; } }
    return best;
  }
  setState(s) { this.state = s; this.stateT = 0; }
  stun(t) { if (!this.alive || this.state === 'under' || this.state === 'burrow') return; this.setState('stunned'); this.stunT = this.isBoss ? t * 0.5 : t; this.ext = 0; }
  knock(vx, vz) { this.kx = vx; this.kz = vz; }
  takeHit(dmg, head, from, crit) {
    if (!this.targetable()) return;
    if (this.state === 'recover' || this.state === 'stunned') dmg *= 1.5;
    this.hp -= dmg; this.flashT = 0.15;
    const p = head ? this.pts[0] : this.closestPart(from.x, from.z, false);
    G.env.dust.burst(p.x, 0.4, p.z, crit ? 30 : 12, crit ? 5 : 3, 0.6, 0.16, [0x8a1414, 0xb02020, 0x5a0a0a], { grav: 9 });
    if (crit) { G.env.glow.burst(p.x, 0.6, p.z, 30, 5, 0.5, 0.2, [0x8dfcd0, 0xffffff]); G.flash('CRITICAL x' + CFG.COUNTER_MULT, '#8dfcd0', 0.7); }
    G.onSnakeHit(this, dmg, head, from);
    if (head && this.state === 'windup' && !this.isBoss) { this.setState('recover'); this.ext = 0; }   // a bite to the face cancels the strike
    if (this.hp <= 0) this.die(from);
  }
  die(from) {
    this.alive = false; this.setState('dead'); this.hp = 0;
    SFX.rattle(0.5, 0.25);
    G.onSnakeDead(this, from);
  }
  // ---------------- main update
  update(dt) {
    this.stateT += dt; this.flashT -= dt;
    for (const k in this.cd) this.cd[k] -= dt;
    const tgt = this.pickTarget();
    const dT = tgt ? dist2(this.x, this.z, tgt.x, tgt.z) : 99;
    const angT = tgt ? Math.atan2(tgt.z - this.z, tgt.x - this.x) : this.heading;
    let moving = false, want = 0, tCoil = 0, tRise = 0, tHood = 0, tJaw = 0, tEye = 0;
    // knockback slides the whole snake
    if (Math.abs(this.kx) + Math.abs(this.kz) > 0.05) { this.x += this.kx * dt; this.z += this.kz * dt; this.kx *= 1 - Math.min(1, dt * 5); this.kz *= 1 - Math.min(1, dt * 5); this.shiftTrail(this.kx * dt, this.kz * dt); }
    const c = this.human ? this.cmd : {};
    switch (this.state) {
      case 'prowl': {
        if (this.human) {
          const ml = Math.hypot(c.mx || 0, c.mz || 0);
          if (ml > 0.15) { want = Math.atan2(c.mz, c.mx); moving = true; this.still = 0; } else this.still = (this.still || 0) + dt;
          if (this.still > 0.25 && tgt && dT < 7) { tCoil = 1; tRise = 0.85; tHood = 1; }
          this.humanActions(c, tgt, dT, angT);
        } else if (tgt) {
          want = angT;
          if (dT > this.reach * 0.95) moving = true;
          if (dT < CFG.STRIKE_RANGE * this.size + 0.4) { this.setState('coil'); this.coilBase = this.heading; this.coilWait = rand(0.25, 0.9) * (this.isBoss ? 0.6 : 1); break; }
          if (this.can.gaze && this.cd.gaze <= 0 && dT < CFG.HYPNO_RANGE && dT > 4 && tgt === G.player) { this.setState('gaze'); this.coilBase = this.heading; this.cd.gaze = rand(9, 13); break; }
          if (this.can.spit && this.cd.spit <= 0 && dT > 5.5 && dT < 16) { this.setState('spit'); this.coilBase = this.heading; this.cd.spit = rand(3.5, 6) * (this.isBoss ? 0.6 : 1); break; }
          if (this.can.burrow && this.cd.burrow <= 0 && dT > 6) { this.setState('burrow'); this.cd.burrow = rand(9, 14); SFX.rumble(0.8, 0.3); break; }
          // flank instead of beelining - weave in from the side
          want += Math.sin(G.time * 0.7 + this.wob) * 0.5;
        } else if (G.player && G.player.alive && G.player.hidden) {   // lost it down a hole: slither over and wait, hood half up
          const d = dist2(this.x, this.z, G.player.x, G.player.z); want = Math.atan2(G.player.z - this.z, G.player.x - this.x) + 0.9;
          moving = d > 3.4; tRise = 0.6; tHood = 0.6; tEye = 0.4;
        }
        break;
      }
      case 'coil': {   // alert stance: coiled, reared up, hood spread, swaying, waiting for the moment
        tCoil = 1; tRise = 1; tHood = 1; tJaw = 0.15; tEye = 0.3;
        if (this.stateT < 0.05) SFX.hiss(0.5, 0.2);
        if (!this.human) {
          if (dT > CFG.STRIKE_RANGE * this.size + 2.2) { this.setState('prowl'); break; }
          if (this.stateT > this.coilWait && this.cd.strike <= 0 && dT < CFG.STRIKE_RANGE * this.size + 0.6) this.beginWindup(tgt);
        }
        break;
      }
      case 'windup': {   // head pulls back, mouth opens - the tell for a perfect dodge
        tCoil = 1; tRise = 1.1; tHood = 1; tJaw = 0.7; tEye = 0.8;
        this.ext = lerp(this.ext, -0.25, Math.min(1, dt * 10));
        if (tgt && this.stateT < this.windup - 0.05) { const lead = this.windup - this.stateT + 0.12, px = tgt.x + tgt.vx * lead, pz = tgt.z + tgt.vz * lead; this.aim += angDiff(this.aim, Math.atan2(pz - this.z, px - this.x)) * Math.min(1, dt * 18); }
        if (this.stateT >= this.windup) { this.lockStrike(tgt); this.setState('strike'); this.hitThisStrike = false; SFX.hiss(0.35, 0.4); }
        break;
      }
      case 'strike': {
        tCoil = 1; tRise = 1; tHood = 1; tJaw = 1; tEye = 1;
        const k = this.stateT / 0.17; this.ext = Math.sin(Math.min(1, k) * Math.PI / 2);
        if (!this.hitThisStrike && k >= 0.75) { this.hitThisStrike = true; this.resolveStrike(); }
        if (k >= 1) { this.setState('recover'); }
        break;
      }
      case 'recover': {   // vulnerable: punish window (x1.5 damage)
        tCoil = 1; tRise = 0.55; tHood = 0.5; tJaw = 0.3;
        this.ext = lerp(this.ext, 0, Math.min(1, dt * 5));
        if (this.stateT > (this.isBoss ? 0.45 : 0.7)) { this.cd.strike = rand(0.5, 1.3) * (this.isBoss ? 0.6 : 1); this.setState(this.human ? 'prowl' : 'coil'); this.coilWait = rand(0.2, 0.7); }
        break;
      }
      case 'spit': {
        tCoil = 1; tRise = 1; tHood = 1; tJaw = this.stateT > 0.35 ? 1 : 0.3; tEye = 0.6;
        if (tgt) this.aim += angDiff(this.aim, angT) * Math.min(1, dt * 8);
        if (this.stateT > 0.38 && !this.spat) {
          this.spat = true; const shots = this.isBoss ? 3 : 1;
          for (let i = 0; i < shots; i++) this.spitAt(tgt, (i - (shots - 1) / 2) * 0.22);
        }
        if (this.stateT > 0.8) { this.spat = false; this.setState('prowl'); }
        break;
      }
      case 'gaze': {   // hypnotic sway, eyes blazing
        tCoil = 1; tRise = 1; tHood = 1; tJaw = 0; tEye = 1;
        if (tgt) this.aim += angDiff(this.aim, angT) * Math.min(1, dt * 4);
        if (this.stateT < 0.05) SFX.hiss(1.2, 0.15);
        const P = G.player;
        if (P && P.alive && !P.hidden && dist2(this.x, this.z, P.x, P.z) < CFG.HYPNO_RANGE && P.hypnoT <= 0) {
          P.hypno += dt * (this.isBoss ? 0.6 : 0.45);
          if (Math.random() < dt * 20) G.env.glow.emit(P.x + rand(-0.4, 0.4), 1.2 + rand(0.4), P.z + rand(-0.4, 0.4), 0, 0.6, 0, 0.8, 0.14, 0xc78cff, 0.8);
          if (P.hypno >= 1) { P.hypnoT = 2.4; P.hypno = 1; P.hypnoBreak = 0; G.flash('HYPNOTISED!', '#e061ff', 0.9); }
        }
        if (this.stateT > (this.human ? 2.4 : 2.8) || (this.human && c.gazeStop)) { this.setState(this.human ? 'prowl' : 'coil'); this.coilWait = 0.2; }
        break;
      }
      case 'burrow': {   // sinks into the earth
        tCoil = 0.6; tRise = 0; tHood = 0;
        this.sink = Math.min(1, this.stateT / 0.7);
        if (Math.random() < 0.8) G.env.dust.emit(this.x + rand(-0.6, 0.6), 0.1, this.z + rand(-0.6, 0.6), rand(-1, 1), rand(1, 2.5), rand(-1, 1), 0.8, 0.4, 0x7a6448, 0.6, 3, 1.5, 0.5);
        if (this.sink >= 1) { this.setState('under'); this.makeMound(); }
        break;
      }
      case 'under': {   // a moving mound of earth hunts the mongoose
        this.sink = 1; let ang = angT;
        if (this.human) { const ml = Math.hypot(c.mx || 0, c.mz || 0); ang = ml > 0.15 ? Math.atan2(c.mz, c.mx) : this.heading; if (ml > 0.15) moving = true; }
        else moving = true;
        if (moving) { this.heading += angDiff(this.heading, ang) * Math.min(1, dt * 4); this.x += Math.cos(this.heading) * this.speed * 1.5 * dt; this.z += Math.sin(this.heading) * this.speed * 1.5 * dt; }
        this.clampArena();
        if (this.mound) { this.mound.position.set(this.x, 0.0, this.z); this.mound.scale.setScalar(0.9 + Math.sin(G.time * 18) * 0.06); }
        if (Math.random() < 0.7) G.env.dust.emit(this.x + rand(-0.5, 0.5), 0.15, this.z + rand(-0.5, 0.5), rand(-1, 1), rand(0.8, 2), rand(-1, 1), 0.7, 0.35, 0x7a6448, 0.6, 3, 1.5, 0.4);
        if (this.stateT % 0.5 < dt) SFX.rumble(0.5, 0.15);
        const ready = this.human ? (c.burrow && this.stateT > 0.4) || this.stateT > 3.5 : (dT < 2.2 || this.stateT > 3);
        if (ready) { this.setState('warn'); G.env.ring(this.x, this.z, 0xff5030, 0.3, 1.8, 0.55); }
        break;
      }
      case 'warn': {   // the ground cracks: a half-second tell before the ambush
        this.sink = 1;
        if (Math.random() < 0.9) G.env.dust.emit(this.x + rand(-0.8, 0.8), 0.1, this.z + rand(-0.8, 0.8), 0, rand(1, 3), 0, 0.5, 0.3, 0x5a4630, 0.7, 4, 1, 0.4);
        if (this.stateT > 0.5) { this.removeMound(); if (tgt) this.heading = angT; this.coilBase = this.heading; this.aim = this.heading; this.resetTrail(); this.coil = 1; this.setState('erupt'); G.env.decal(this.x, this.z, TEX.hole, 2.4, 6); G.shake(0.4); SFX.roar(this.isBoss ? 0.5 : 0.3); }
        break;
      }
      case 'erupt': {   // bursts out of the ground already coiled and strikes at once
        tCoil = 1; tRise = 1.1; tHood = 1; tJaw = 0.8; tEye = 1; this.coil = 1;
        this.sink = Math.max(0, 1 - this.stateT / 0.22);
        if (this.stateT < 0.05) G.env.dust.burst(this.x, 0.2, this.z, 45, 6, 0.9, 0.45, [0x7a6448, 0x5a4630, 0x9a8466], { up: 1.2, grav: 8 });
        if (tgt) this.aim = angT;
        if (this.stateT > 0.28) {
          if (tgt && dT < this.reach + 1.5 && !this.spawnOnly) { this.strikeTarget = tgt; this.lockStrike(tgt); this.setState('strike'); this.hitThisStrike = false; this.ext = 0; }
          else { this.spawnOnly = false; this.setState(this.human ? 'prowl' : 'coil'); this.coilWait = 0.4; }
        }
        break;
      }
      case 'stunned': {   // dazed: hood folds, head wobbles drunkenly
        tCoil = 0.5; tRise = 0.25; tHood = 0.1; tJaw = 0.4;
        this.ext = lerp(this.ext, 0, Math.min(1, dt * 6));
        this.aim += Math.sin(G.time * 9) * dt * 3;
        if (Math.random() < dt * 10) G.env.glow.emit(this.pts[0].x + rand(-0.3, 0.3), this.pts[0].y + 0.4, this.pts[0].z + rand(-0.3, 0.3), 0, 0.8, 0, 0.6, 0.15, 0xffe27a, 0.9);
        if (this.stateT > this.stunT) { this.setState(this.human ? 'prowl' : 'coil'); this.coilWait = 0.3; }
        break;
      }
      case 'dead': {
        tCoil = 0; tRise = 0; tHood = 0; tJaw = 0.6;
        if (this.stateT < 0.9) this.wob += dt * 25;   // death writhe
        const fade = clamp(1 - (this.stateT - 2.6) / 1.6, 0, 1);
        if (fade < 1) this.model.setOpacity(fade);
        if (this.stateT > 4.2) this.done = true;
        break;
      }
    }
    // steering
    if (moving) {
      this.heading += angDiff(this.heading, want) * Math.min(1, dt * (this.human ? 6 : 3.2));
      const slither = Math.sin(G.time * 7 + this.wob) * 0.55;    // serpentine wiggle drawn into the trail
      const sp = this.speed * (this.human ? 1.05 : 1);
      this.x += Math.cos(this.heading + slither) * sp * dt; this.z += Math.sin(this.heading + slither) * sp * dt;
      this.clampArena();
      tCoil = Math.min(tCoil, 0); if (!this.human) { tRise = Math.max(tRise, dT < 9 ? 0.35 : 0.15); tHood = dT < 8 ? 0.4 : 0; }
      else { tRise = Math.max(tRise, 0.3); }
    }
    // keep apart from other snakes
    for (const o of G.snakes) { if (o === this || !o.alive || o.sink > 0.5) continue; const d = dist2(this.x, this.z, o.x, o.z); if (d < 2.2 && d > 0.01) { const p = (2.2 - d) * 0.5; this.x += (this.x - o.x) / d * p * dt * 4; this.z += (this.z - o.z) / d * p * dt * 4; } }
    // posture easing
    const ease = (cur, tgtV, sp) => lerp(cur, tgtV, Math.min(1, dt * sp));
    this.coil = this.state === 'erupt' ? 1 : ease(this.coil, tCoil, 4);
    this.rise = ease(this.rise, tRise, 6); this.hood = ease(this.hood, tHood, 7); this.jaw = ease(this.jaw, tJaw, 14); this.eye = ease(this.eye, tEye, 6);
    if (this.state !== 'windup' && this.state !== 'strike' && this.state !== 'recover' && this.state !== 'stunned') { this.ext = ease(this.ext, 0, 8); if (tgt && this.state !== 'dead') this.aim += angDiff(this.aim, angT) * Math.min(1, dt * 5); }
    if (this.state === 'prowl' && this.coil < 0.3) this.coilBase = this.heading;
    this.recordTrail();
    this.buildSpine(dt);
    const flash = this.flashT > 0;
    this.model.mat.emissive.setHex(flash ? 0x661010 : 0x000000);
    this.model.update(this.hood, this.jaw, this.eye, G.time, this.sink);
    this.model.group.visible = this.sink < 0.99;
  }
  humanActions(c, tgt, dT, angT) {
    const autoAim = tgt && Math.abs(angDiff(this.heading, angT)) < 1.0;
    if (c.strike && this.cd.strike <= 0) { this.coilBase = this.heading; this.coil = Math.max(this.coil, 0.6); this.beginWindup(autoAim && dT < this.reach + 2 ? tgt : null); }
    else if (c.spit && this.cd.spit <= 0) { this.setState('spit'); this.coilBase = this.heading; this.aim = autoAim ? angT : this.heading; this.cd.spit = 2.6; }
    else if (c.burrow && this.cd.burrow <= 0) { this.setState('burrow'); this.cd.burrow = 9; SFX.rumble(0.8, 0.3); }
    else if (c.gaze && this.cd.gaze <= 0) { this.setState('gaze'); this.coilBase = this.heading; this.cd.gaze = 11; }
  }
  beginWindup(tgt) {
    this.setState('windup'); this.cd.strike = 1.0; this.strikeTarget = tgt;
    this.aim = tgt ? Math.atan2(tgt.z - this.z, tgt.x - this.x) : this.heading;
    if (this.isBoss && Math.random() < 0.4) SFX.roar(0.35);
  }
  lockStrike(tgt) {   // the strike stops at the target instead of always shooting full length past it
    this.strikeLen = this.reach;
    if (!tgt) return;
    const px = tgt.x + tgt.vx * 0.12, pz = tgt.z + tgt.vz * 0.12, a = Math.atan2(pz - this.z, px - this.x);
    if (Math.abs(angDiff(this.aim, a)) < 0.5) this.aim = a;   // last-instant correction
    if (Math.abs(angDiff(this.aim, a)) < 0.9) this.strikeLen = clamp(dist2(this.x, this.z, px, pz) - 0.2 * this.size, 0.5, this.reach);
  }
  resolveStrike() {
    for (const m of G.mongooses()) {
      if (!m.alive || m.hidden) continue;
      let d = 99; for (let i = 0; i < 6; i++) { const q = this.pts[i]; if (q.y < 1.4 * this.size) d = Math.min(d, dist2(q.x, q.z, m.x, m.z)); }
      const hitR = 0.75 + 0.2 * this.size;
      const nearMiss = d < hitR + 2.0;
      if (d < hitR) {
        if (!m.isClone && m.invuln > 0 && m.state === 'dodge') { G.counter(m, this); continue; }
        if (m.hurt(this.dmg, this)) { m.poison(this.isBoss ? 4 : 2.5); G.env.glow.burst(m.x, 0.6, m.z, 12, 2, 0.6, 0.15, 0x7dff3a); }
      } else if (!m.isClone && (nearMiss || m === this.strikeTarget) && G.realTime - m.lastDodge < CFG.COUNTER_WINDOW) {
        G.counter(m, this);   // dodged out of the strike at the last instant
      }
    }
    G.shake(0.15 * this.size);
  }
  spitAt(tgt, spread) {
    const h = this.pts[0];
    let tx, tz;
    if (tgt) { const lead = 0.35; tx = tgt.x + tgt.vx * lead; tz = tgt.z + tgt.vz * lead; }
    else { tx = this.x + Math.cos(this.aim) * 9; tz = this.z + Math.sin(this.aim) * 9; }
    const a = Math.atan2(tz - h.z, tx - h.x) + spread, d = Math.min(16, Math.hypot(tx - h.x, tz - h.z));
    tx = h.x + Math.cos(a) * d; tz = h.z + Math.sin(a) * d;
    G.blobs.push(new VenomBlob(h.x, h.y + 0.05, h.z, tx, tz, this.dmg * 0.55, this));
    SFX.spit();
  }
  makeMound() {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.8 * this.size, 12, 8, 0, TAU, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x5a4630, map: TEX.ground, roughness: 1 }));
    m.scale.y = 0.45; m.castShadow = true; m.position.set(this.x, 0, this.z); G.scene.add(m); this.mound = m;
  }
  removeMound() { if (this.mound) { G.scene.remove(this.mound); this.mound.geometry.dispose(); this.mound = null; } }
  clampArena() { const r = Math.hypot(this.x, this.z), lim = CFG.ARENA_R + 1; if (r > lim) { this.x *= lim / r; this.z *= lim / r; } }
  shiftTrail(dx, dz) { for (const p of this.trail) { p.x += dx; p.z += dz; } }
  recordTrail() {
    const t0 = this.trail[0], sp = CFG.SNAKE_SPACING * 0.5 * this.size;
    if (dist2(this.x, this.z, t0.x, t0.z) >= sp) {
      this.trail.unshift({ x: this.x, z: this.z });
      if (this.trail.length > CFG.SNAKE_SEGS * 2 + 14) this.trail.pop();
    }
  }
  // Compose the 3D spine: ground path (trail) blended with the coiled, reared-up pose
  buildSpine(dt) {
    const N = CFG.SNAKE_SEGS, P = this.pts, SP = CFG.SNAKE_SPACING * this.size, S = this.size;
    const neckN = 13, riseH = (0.95 + 0.25 * (this.state === 'gaze' ? Math.sin(G.time * 2) : 0)) * S * this.rise;
    // 1) ground path by arc length along [head, trail...]
    let segIdx = -1, ax = this.x, az = this.z, bx = this.trail[0].x, bz = this.trail[0].z, segLen = Math.hypot(bx - ax, bz - az), acc = 0;
    const tpx = [], tpz = [];
    for (let i = 0; i < N; i++) {
      const target = i * SP;
      while (acc + segLen < target && segIdx < this.trail.length - 2) { acc += segLen; segIdx++; ax = this.trail[segIdx].x; az = this.trail[segIdx].z; bx = this.trail[segIdx + 1].x; bz = this.trail[segIdx + 1].z; segLen = Math.hypot(bx - ax, bz - az); }
      const f = segLen > 1e-6 ? clamp((target - acc) / segLen, 0, 1.5) : 0;
      tpx.push(ax + (bx - ax) * f); tpz.push(az + (bz - az) * f);
    }
    // 2) coiled pose: spiral behind the head, neck rising out of its centre toward the raised head
    const cb = this.coilBase, R0 = 0.95 * S, turns = 1.25;
    const cx = this.x - Math.cos(cb) * R0 * 0.95, cz = this.z - Math.sin(cb) * R0 * 0.95;
    const sx = cx + Math.cos(cb) * R0, sz = cz + Math.sin(cb) * R0;   // where the neck leaves the coil
    const aim = this.aim, sway = (this.state === 'coil' || this.state === 'gaze') ? Math.sin(G.time * (this.state === 'gaze' ? 1.6 : 2.4) + this.wob) * 0.28 * S : 0;
    const hx0 = sx + Math.cos(aim) * 0.35 * S - Math.sin(aim) * sway, hz0 = sz + Math.sin(aim) * 0.35 * S + Math.cos(aim) * sway;
    const writhe = this.state === 'dead' && this.stateT < 0.9 ? 1 - this.stateT / 0.9 : 0;
    for (let i = 0; i < N; i++) {
      const r = this.model.radius[i] * 0.82;
      let gx = tpx[i], gz = tpz[i], gy = r;
      if (writhe > 0) { const w = Math.sin(i * 0.5 + this.wob) * 0.25 * writhe; gx += -Math.sin(this.heading) * w; gz += Math.cos(this.heading) * w; }
      if (i < neckN) gy += riseH * Math.pow(1 - i / neckN, 2) * (1 - this.coil);
      let x = gx, y = gy, z = gz;
      if (this.coil > 0.001) {
        let qx, qy, qz;
        if (i >= neckN) {
          const u = (i - neckN) / (N - 1 - neckN), th = cb + u * turns * TAU, rr = R0 * (1 - 0.55 * u);
          qx = cx + Math.cos(th) * rr; qz = cz + Math.sin(th) * rr; qy = r + u * 0.2 * S;
        } else {
          const u = i / neckN;   // quadratic bezier: raised head -> control above coil -> coil start
          const hy = r + riseH + 0.05;
          const kx = lerp(sx, hx0, 0.25), kz = lerp(sz, hz0, 0.25), ky = r + riseH * 0.75;
          const a = (1 - u) * (1 - u), b = 2 * (1 - u) * u, c2 = u * u;
          qx = a * hx0 + b * kx + c2 * sx; qz = a * hz0 + b * kz + c2 * sz; qy = a * hy + b * ky + c2 * (r + 0.02);
        }
        x = lerp(x, qx, this.coil); y = lerp(y, qy, this.coil); z = lerp(z, qz, this.coil);
      }
      // strike: neck shoots forward along the aim, head drops toward the target
      if (i < neckN && Math.abs(this.ext) > 0.001) {
        const w = Math.pow(1 - i / neckN, 1.3), e = this.ext * (this.strikeLen || this.reach) * w;
        x += Math.cos(aim) * e; z += Math.sin(aim) * e;
        if (this.ext > 0) y = lerp(y, r + 0.35 * S * (1 - i / neckN) + 0.12, this.ext * w);
      }
      y -= this.sink * 1.4 * S;
      P[i].set(x, y, z);
    }
  }
  remove() { this.removeMound(); G.scene.remove(this.model.group); this.model.dispose(); }
}

// ---------------------------------------------------------------- venom
class VenomBlob {
  constructor(x, y, z, tx, tz, dmg, owner) {
    this.x = x; this.y = y; this.z = z; this.dmg = dmg; this.owner = owner;
    const d = Math.hypot(tx - x, tz - z), T = Math.max(0.35, d / 13), g = 14;
    this.vx = (tx - x) / T; this.vz = (tz - z) / T; this.vy = (0.15 - y + 0.5 * g * T * T) / T; this.g = g;
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 8), new THREE.MeshStandardMaterial({ color: 0x5dff2a, emissive: 0x39c214, emissiveIntensity: 1.6, roughness: 0.1, transparent: true, opacity: 0.9 }));
    G.scene.add(this.mesh); this.dead = false;
  }
  update(dt) {
    this.vy -= this.g * dt; this.x += this.vx * dt; this.y += this.vy * dt; this.z += this.vz * dt;
    this.mesh.position.set(this.x, this.y, this.z); this.mesh.scale.set(1, 1 + Math.min(1.2, Math.abs(this.vy) * 0.05), 1);
    if (Math.random() < 0.7) G.env.glow.emit(this.x, this.y, this.z, 0, 0, 0, 0.35, 0.12, 0x6aff3a, 0.7);
    for (const m of G.mongooses()) {
      if (!m.alive || m.hidden) continue;
      if (dist2(this.x, this.z, m.x, m.z) < 0.6 && this.y < 1.1) {
        if (m.hurt(this.dmg, this)) { m.poison(CFG.VENOM_TIME); SFX.splat(); }
        this.dead = true; break;
      }
    }
    if (this.y <= 0.08 && !this.dead) {
      this.dead = true; SFX.splat(0.18);
      G.env.glow.burst(this.x, 0.1, this.z, 12, 2.5, 0.5, 0.12, [0x6aff3a, 0x2f9a14], { up: 0.8, grav: 6 });
      G.puddles.push({ x: this.x, z: this.z, t: 4, r: 0.75, m: G.env.decal(this.x, this.z, TEX.dot, 1.8, 4, 0x4dff1a) });
    }
  }
  remove() { G.scene.remove(this.mesh); this.mesh.geometry.dispose(); this.mesh.material.dispose(); }
}
