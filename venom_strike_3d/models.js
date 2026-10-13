/* =====================================================================
   models.js - procedural 3D animals.
   MongooseModel: grizzled fur body with fur shells, articulated legs,
     jaw, a BIG bushy tail (as long as the body, thick brush) that glows.
   CobraModel: a smooth scaled body rebuilt every frame from a spine
     (custom tube geometry), hood that spreads, hinged jaw, fangs,
     flickering tongue and hypnotic glowing eyes.
   Models face +Z; heading angle a points along (cos a, sin a) in XZ.
   ===================================================================== */
'use strict';

const yawFor = (a) => Math.PI / 2 - a;

// ---------------------------------------------------------------- mongoose
const MONGOOSE_LOOKS = {
  p1: { base: '#8a7a66', dark: '#3b3126', light: '#cfc2a8', tip: 0x2a221a, belly: 0xb8a68a, glow: 0x8dfcd0, eye: 0xff9a2a },
  p2: { base: '#9a5a32', dark: '#40220f', light: '#e0a874', tip: 0x2b160a, belly: 0xd09a6a, glow: 0xffb347, eye: 0xff5a2a },
  clone: { base: '#2a1f40', dark: '#0d0818', light: '#6c58a8', tip: 0x120c20, belly: 0x3a2d58, glow: 0xb48cff, eye: 0xd8b8ff },
};

class MongooseModel {
  constructor(look = 'p1', opts = {}) {
    const L = MONGOOSE_LOOKS[look]; this.look = L;
    const ghost = look === 'clone';
    const furTex = TEX.fur(L.base, L.dark, L.light);
    const furMat = new THREE.MeshStandardMaterial({ map: furTex, roughness: 0.95, transparent: ghost, opacity: ghost ? 0.55 : 1, emissive: ghost ? 0x2a1450 : 0x000000 });
    const bellyMat = new THREE.MeshStandardMaterial({ color: L.belly, map: furTex, roughness: 1, transparent: ghost, opacity: ghost ? 0.55 : 1 });
    const darkMat = new THREE.MeshStandardMaterial({ color: L.tip, roughness: 0.9, transparent: ghost, opacity: ghost ? 0.6 : 1 });
    const shellMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(L.light), alphaMap: TEX.furAlpha, transparent: true, depthWrite: false, roughness: 1, opacity: ghost ? 0.4 : 0.85 });
    this.mats = [furMat, bellyMat, darkMat, shellMat];
    const g = this.group = new THREE.Group();
    const root = this.root = new THREE.Group(); g.add(root);          // root bobs / rolls / leaps
    const sph = (r = 1, w = 14, h = 10) => new THREE.SphereGeometry(r, w, h);
    const add = (parent, geo, mat, x, y, z, sx = 1, sy = 1, sz = 1, shells = 0) => {
      const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.scale.set(sx, sy, sz); m.castShadow = !ghost; parent.add(m);
      for (let k = 1; k <= shells; k++) { const s = new THREE.Mesh(geo, shellMat); s.scale.setScalar(1 + k * 0.07); m.add(s); }
      return m;
    };
    // Body: long, low, muscular
    this.body = new THREE.Group(); root.add(this.body);
    add(this.body, sph(), furMat, 0, 0.48, 0, 0.3, 0.27, 0.62, 2);
    add(this.body, sph(), furMat, 0, 0.5, -0.36, 0.29, 0.28, 0.32, 2);       // haunch
    add(this.body, sph(), furMat, 0, 0.52, 0.34, 0.27, 0.27, 0.3, 2);         // chest
    add(this.body, sph(), bellyMat, 0, 0.36, 0.05, 0.22, 0.14, 0.5);           // belly
    // Neck + head
    this.neck = new THREE.Group(); this.neck.position.set(0, 0.6, 0.52); this.body.add(this.neck);
    add(this.neck, sph(), furMat, 0, 0.02, 0.06, 0.18, 0.19, 0.22, 1);
    this.head = new THREE.Group(); this.head.position.set(0, 0.1, 0.24); this.neck.add(this.head);
    add(this.head, sph(), furMat, 0, 0, 0, 0.19, 0.17, 0.22, 1);
    const snout = add(this.head, new THREE.ConeGeometry(0.1, 0.3, 10), furMat, 0, -0.03, 0.27); snout.rotation.x = Math.PI / 2;
    add(this.head, sph(0.03), new THREE.MeshStandardMaterial({ color: 0x9a4a5a, roughness: 0.4 }), 0, -0.02, 0.42);   // pink nose
    const eyeMat = new THREE.MeshStandardMaterial({ color: 0x120a04, emissive: L.eye, emissiveIntensity: 0.55, roughness: 0.2, metalness: 0.2 });
    this.eyeMat = eyeMat;
    add(this.head, sph(0.04), eyeMat, 0.1, 0.05, 0.13); add(this.head, sph(0.04), eyeMat, -0.1, 0.05, 0.13);
    const earGeo = new THREE.SphereGeometry(0.06, 8, 6, 0, TAU, 0, Math.PI / 2);
    add(this.head, earGeo, darkMat, 0.13, 0.11, -0.04, 1, 0.7, 0.6); add(this.head, earGeo, darkMat, -0.13, 0.11, -0.04, 1, 0.7, 0.6);
    this.jaw = new THREE.Group(); this.jaw.position.set(0, -0.08, 0.05); this.head.add(this.jaw);
    const jawM = add(this.jaw, new THREE.ConeGeometry(0.07, 0.26, 8), bellyMat, 0, -0.01, 0.15); jawM.rotation.x = Math.PI / 2;
    const fangMat = new THREE.MeshStandardMaterial({ color: 0xf6efe0, roughness: 0.3 });
    for (const sx of [-0.04, 0.04]) { const f = add(this.head, new THREE.ConeGeometry(0.013, 0.07, 5), fangMat, sx, -0.09, 0.33); f.rotation.x = Math.PI; }
    // Legs: hip -> knee -> paw, all animated
    this.legs = [];
    const legMat = furMat;
    for (const [lx, lz, front] of [[0.17, 0.33, 1], [-0.17, 0.33, 1], [0.17, -0.36, 0], [-0.17, -0.36, 0]]) {
      const hip = new THREE.Group(); hip.position.set(lx, 0.46, lz); this.body.add(hip);
      add(hip, new THREE.CylinderGeometry(0.075, 0.06, 0.24, 8), legMat, 0, -0.12, 0);
      const knee = new THREE.Group(); knee.position.set(0, -0.24, 0); hip.add(knee);
      add(knee, new THREE.CylinderGeometry(0.055, 0.045, 0.2, 8), darkMat, 0, -0.1, 0);
      add(knee, sph(0.06, 8, 6), darkMat, 0, -0.2, 0.03, 1, 0.6, 1.4);
      this.legs.push({ hip, knee, front, side: Math.sign(lx) });
    }
    // BIG BUSHY TAIL: 14 fur puffs along a curve - root as thick as the haunch, brush swelling
    // to ~85% of the body's depth, dark tip; about as long as the body. Glow shell around it.
    this.tail = new THREE.Group(); this.tail.position.set(0, 0.52, -0.6); this.body.add(this.tail);
    this.tailSegs = []; this.tailGlow = [];
    const glowMat = new THREE.MeshBasicMaterial({ color: L.glow, transparent: true, opacity: 0.0, blending: THREE.AdditiveBlending, depthWrite: false });
    this.glowMat = glowMat;
    const N = 14;
    for (let i = 0; i < N; i++) {
      const t = i / (N - 1);
      const r = (0.17 + 0.05 * Math.sin(Math.min(1, t * 1.6) * Math.PI)) * (1 - 0.7 * Math.pow(t, 2.2));   // thick root, bushy middle, tapering tip
      const seg = new THREE.Group(); this.tail.add(seg);
      const m = add(seg, sph(1, 12, 9), t > 0.82 ? darkMat : furMat, 0, 0, 0, r * 1.05, r, r * 1.25, 2);
      const gm = new THREE.Mesh(sph(1, 10, 8), glowMat); gm.scale.set(r * 1.18, r * 1.15, r * 1.3); seg.add(gm);
      this.tailSegs.push({ seg, t, r, m }); this.tailGlow.push(gm);
    }
    this.tailLight = new THREE.PointLight(L.glow, 0, 4.5); this.tail.add(this.tailLight);
    // Contact shadow blob (soft, always under the animal even when shadows are off)
    this.blob = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 2.4), new THREE.MeshBasicMaterial({ map: TEX.dot, color: 0x000000, transparent: true, opacity: 0.45, depthWrite: false }));
    this.blob.rotation.x = -Math.PI / 2; this.blob.position.y = 0.03; g.add(this.blob);
    this.phase = 0; this.fluff = 0; this.glow = 0;
    if (opts.scale) g.scale.setScalar(opts.scale);
  }
  // pose: {speed (0..1), lift, roll, bite (0..1), fluff (0..1), glow (0..1), dance, t}
  animate(dt, pose) {
    const t = pose.t;
    this.phase += dt * (4 + pose.speed * 16);
    const s = Math.sin(this.phase), c = Math.cos(this.phase);
    const run = pose.speed;
    // gallop: front and hind pairs alternate, body bounds
    for (const L of this.legs) {
      const ph = this.phase + (L.front ? 0 : Math.PI) + (L.side > 0 ? 0.35 : 0);
      let sw = Math.sin(ph) * 0.9 * run, kn = Math.max(0, -Math.cos(ph)) * 1.1 * run;
      if (pose.lift > 0.05 || pose.bite > 0) { sw = L.front ? -1.1 : 1.0; kn = L.front ? 0.2 : 0.6; }   // pounce: front legs reach, hind legs kick back
      L.hip.rotation.x = sw; L.knee.rotation.x = -kn * (L.front ? -1 : 1) * 0.6 - kn * 0.4;
    }
    this.root.position.y = Math.abs(s) * 0.07 * run + pose.lift;
    this.root.rotation.x = s * 0.06 * run - (pose.bite > 0 ? 0.25 * pose.bite : 0) + (pose.lift > 0.05 ? -0.15 : 0);
    this.root.rotation.z = pose.roll || 0;
    if (pose.roll) { this.root.position.y += 0.35 * Math.abs(Math.sin(pose.roll / 2)); }
    // head: scans, lunges when biting; jaw gapes
    this.neck.rotation.x = -0.15 + (pose.bite > 0 ? 0.35 * pose.bite : Math.sin(t * 1.3) * 0.06) + (pose.dance ? Math.sin(t * 8) * 0.25 : 0);
    this.neck.rotation.y = pose.dance ? Math.sin(t * 5) * 0.5 : Math.sin(t * 0.9) * 0.12;
    this.jaw.rotation.x = 0.1 + (pose.bite > 0 ? 0.6 * Math.sin(pose.bite * Math.PI) : 0) + (pose.fluff > 0.6 ? 0.25 : 0);
    // fur bristles up against a snake: shells puff out, tail brush swells
    this.fluff = lerp(this.fluff, pose.fluff, Math.min(1, dt * 6));
    const puff = 1 + this.fluff * 0.2;
    // tail: rises in an arc, swishes, flags straight back while running, whirls when dancing
    const wave = pose.dance ? 1.8 : 0.4 + run * 0.2;
    let px = 0, py = 0, pz = 0, ang = -0.35 + this.fluff * 0.9 - run * 0.25 + (pose.dance ? 0.9 : 0);
    for (let i = 0; i < this.tailSegs.length; i++) {
      const T = this.tailSegs[i], k = T.t;
      const yaw = Math.sin(t * (pose.dance ? 9 : 3.2) - k * 3.2) * wave * k * 0.55;
      const len = 0.105;
      ang += (pose.dance ? 0.08 : 0.035) * (1 - this.fluff * 0.5);
      px += Math.sin(yaw) * len; py += Math.sin(ang) * len; pz -= Math.cos(ang) * Math.cos(yaw) * len;
      T.seg.position.set(px, py, pz);
      T.seg.scale.setScalar(puff * (1 + (k > 0.2 && k < 0.85 ? this.fluff * 0.08 : 0)));
    }
    // glow - agility / counter-strike energy shimmering through the brush
    this.glow = lerp(this.glow, pose.glow, Math.min(1, dt * 5));
    const flick = 0.85 + 0.15 * Math.sin(t * 13);
    this.glowMat.opacity = this.glow * 0.16 * flick;
    this.tailLight.intensity = this.glow * 3.2 * flick;
    this.tailLight.position.copy(this.tailSegs[7].seg.position);
    this.eyeMat.emissiveIntensity = 0.5 + this.glow * 1.6;
    this.blob.scale.setScalar(Math.max(0.4, 1 - pose.lift * 0.35));
    this.blob.position.y = 0.03 - (this.root.position.y);   // stays on the ground
  }
  setOpacity(o) { for (const m of this.mats) { m.transparent = true; m.opacity = Math.min(m.opacity, o); } }
  dispose() { this.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); }); }
}

// ---------------------------------------------------------------- cobra
const COBRA_LOOKS = {
  ai:   { body: '#6b5a33', band: '#e6d7a6', belly: '#e8dcb0', dark: '#2a2214', head: 0x5d4d2a, eye: 0xff3b1f, hood: ['#5e4f2c', '#d9c896', '#efe3bd'], name: 'Spectacled Cobra' },
  viper:{ body: '#9a7a4a', band: '#3b2614', belly: '#e6d4a6', dark: '#2a1a0c', head: 0x7d6038, eye: 0xffb020, hood: ['#8a6b40', '#3b2614', '#e6d4a6'], name: "Russell's Viper" },
  p2:   { body: '#18181a', band: '#e8c83a', belly: '#f2e08a', dark: '#000000', head: 0x141414, eye: 0x6aff3a, hood: ['#141414', '#e8c83a', '#f2e08a'], name: 'Black King Cobra' },
  boss: { body: '#3a2a12', band: '#ff9a2a', belly: '#f0c070', dark: '#120a04', head: 0x2e2010, eye: 0xff2a6a, hood: ['#2e200e', '#ff8a1a', '#f6cf86'], name: 'KING COBRA' },
};

class CobraModel {
  constructor(lookKey = 'ai', size = 1) {
    const L = COBRA_LOOKS[lookKey]; this.look = L; this.size = size;
    const N = this.N = CFG.SNAKE_SEGS, R = this.R = 12;
    this.spine = []; for (let i = 0; i < N; i++) this.spine.push(new THREE.Vector3());
    this.group = new THREE.Group();
    // Tube body (one smooth skin) - vertices rewritten every frame from the spine
    const geo = this.geo = new THREE.BufferGeometry();
    this.posArr = new Float32Array(N * (R + 1) * 3);
    const uv = new Float32Array(N * (R + 1) * 2), idx = [];
    for (let i = 0; i < N; i++) for (let j = 0; j <= R; j++) { const k = i * (R + 1) + j; uv[k * 2] = (i / (N - 1)) * 6; uv[k * 2 + 1] = j / R; }
    for (let i = 0; i < N - 1; i++) for (let j = 0; j < R; j++) { const a = i * (R + 1) + j, b = a + R + 1; idx.push(a, b, a + 1, b, b + 1, a + 1); }
    geo.setAttribute('position', new THREE.BufferAttribute(this.posArr, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); geo.setIndex(idx); geo.computeVertexNormals();
    const scaleTex = TEX.scales(L.body, L.band, L.belly, L.dark);
    this.mat = new THREE.MeshStandardMaterial({ map: scaleTex, bumpMap: scaleTex, bumpScale: 0.6, roughness: 0.42, metalness: 0.08, transparent: false });
    this.mesh = new THREE.Mesh(geo, this.mat); this.mesh.castShadow = true; this.mesh.receiveShadow = true; this.mesh.frustumCulled = false; this.group.add(this.mesh);
    // radius profile: thin neck behind the head, thick body, long tapering tail
    this.radius = []; for (let i = 0; i < N; i++) { const t = i / (N - 1); this.radius.push(size * (t < 0.05 ? 0.1 + t * 1.2 : t < 0.22 ? lerp(0.13, 0.2, (t - 0.05) / 0.17) : t < 0.6 ? 0.2 : lerp(0.2, 0.012, Math.pow((t - 0.6) / 0.4, 0.9)))); }
    // Head
    const hm = new THREE.MeshStandardMaterial({ color: L.head, map: scaleTex, roughness: 0.35, metalness: 0.1 });
    this.head = new THREE.Group(); this.group.add(this.head);
    const skull = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), hm); skull.scale.set(0.17 * size, 0.1 * size, 0.24 * size); skull.position.z = 0.06 * size; skull.castShadow = true; this.head.add(skull);
    const crown = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), hm); crown.scale.set(0.15 * size, 0.07 * size, 0.15 * size); crown.position.set(0, 0.04 * size, 0.02 * size); this.head.add(crown);
    this.eyeMat = new THREE.MeshStandardMaterial({ color: 0x110000, emissive: L.eye, emissiveIntensity: 0.6, roughness: 0.1, metalness: 0.4 });
    for (const sx of [-1, 1]) { const e = new THREE.Mesh(new THREE.SphereGeometry(0.035 * size, 10, 8), this.eyeMat); e.position.set(sx * 0.12 * size, 0.035 * size, 0.12 * size); this.head.add(e); }
    this.jaw = new THREE.Group(); this.jaw.position.set(0, -0.03 * size, -0.05 * size); this.head.add(this.jaw);
    const jm = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshStandardMaterial({ color: new THREE.Color(L.belly), roughness: 0.5 }));
    jm.scale.set(0.14 * size, 0.04 * size, 0.22 * size); jm.position.z = 0.12 * size; this.jaw.add(jm);
    const mouth = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 6), new THREE.MeshStandardMaterial({ color: 0xc23a4a, roughness: 0.6 })); mouth.scale.set(0.12 * size, 0.02 * size, 0.18 * size); mouth.position.set(0, 0.02 * size, 0.12 * size); this.jaw.add(mouth);
    const fangMat = new THREE.MeshStandardMaterial({ color: 0xfaf6ea, roughness: 0.2, emissive: 0x335522, emissiveIntensity: 0.4 });
    this.fangs = [];
    for (const sx of [-1, 1]) { const f = new THREE.Mesh(new THREE.ConeGeometry(0.014 * size, 0.09 * size, 6), fangMat); f.position.set(sx * 0.07 * size, -0.07 * size, 0.24 * size); f.rotation.x = Math.PI * 0.92; this.head.add(f); this.fangs.push(f); }
    // forked tongue
    this.tongue = new THREE.Group(); this.tongue.position.set(0, -0.02 * size, 0.3 * size); this.head.add(this.tongue);
    const tm = new THREE.MeshBasicMaterial({ color: 0xb01830 });
    const tb = new THREE.Mesh(new THREE.CylinderGeometry(0.008 * size, 0.008 * size, 0.18 * size, 4), tm); tb.rotation.x = Math.PI / 2; tb.position.z = 0.09 * size; this.tongue.add(tb);
    for (const sx of [-1, 1]) { const fk = new THREE.Mesh(new THREE.CylinderGeometry(0.005 * size, 0.005 * size, 0.07 * size, 4), tm); fk.rotation.set(Math.PI / 2, 0, sx * 0.5); fk.position.set(sx * 0.015 * size, 0, 0.2 * size); this.tongue.add(fk); }
    // Hood: flattened disc of skin with the spectacle mark on the back, ribs spread it sideways
    const hoodTex = TEX.hood(...L.hood);
    this.hoodMat = new THREE.MeshStandardMaterial({ map: hoodTex, roughness: 0.5, side: THREE.DoubleSide });
    this.hood = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), this.hoodMat); this.hood.castShadow = true; this.group.add(this.hood);
    // contact shadow
    this.blob = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: TEX.dot, color: 0x000000, transparent: true, opacity: 0.4, depthWrite: false }));
    this.blob.rotation.x = -Math.PI / 2; this.blob.position.y = 0.025; this.group.add(this.blob);
    this._s = new THREE.Vector3(); this._n = new THREE.Vector3(); this._tg = new THREE.Vector3(); this._up = new THREE.Vector3(0, 1, 0);
  }
  // Rebuild the skin around the spine (spine[0] = head end)
  update(hoodAmt, jawOpen, eyeGlow, t, sink = 0) {
    const N = this.N, R = this.R, P = this.spine, pos = this.posArr, s = this._s, n = this._n, tg = this._tg;
    let prevSide = null;
    for (let i = 0; i < N; i++) {
      const a = P[Math.max(0, i - 1)], b = P[Math.min(N - 1, i + 1)];
      tg.subVectors(a, b); if (tg.lengthSq() < 1e-8) tg.set(0, 0, 1); tg.normalize();
      s.crossVectors(tg, this._up); if (s.lengthSq() < 1e-4) { if (prevSide) s.copy(prevSide); else s.set(1, 0, 0); } s.normalize();
      prevSide = prevSide || new THREE.Vector3(); prevSide.copy(s);
      n.crossVectors(s, tg).normalize();
      // the hood region flattens the neck sideways a little
      const r = this.radius[i], rw = r * (i > 1 && i < 9 ? 1 + hoodAmt * 0.25 : 1), rh = r * 0.82;
      for (let j = 0; j <= R; j++) {
        const ang = (j / R) * TAU, cx = Math.cos(ang) * rw, cy = Math.sin(ang) * rh, k = (i * (R + 1) + j) * 3;
        pos[k] = P[i].x + s.x * cx + n.x * cy; pos[k + 1] = P[i].y + s.y * cx + n.y * cy; pos[k + 2] = P[i].z + s.z * cx + n.z * cy;
      }
    }
    this.geo.attributes.position.needsUpdate = true; this.geo.computeVertexNormals(); this.geo.computeBoundingSphere();
    // head looks along the neck direction
    const h = P[0], d = tg.subVectors(P[0], P[2]).normalize();
    this.head.position.copy(h);
    this.head.lookAt(h.x + d.x, h.y + d.y, h.z + d.z);
    this.jaw.rotation.x = jawOpen * 0.9;
    for (const f of this.fangs) f.visible = jawOpen > 0.15;
    this.tongue.visible = jawOpen < 0.2 && Math.sin(t * 7) > 0.55;
    this.tongue.scale.z = 0.6 + 0.4 * Math.abs(Math.sin(t * 22));
    // hood sits behind the head on the raised neck, spread by hoodAmt
    const hp = P[6], hd = tg.subVectors(P[3], P[9]).normalize();
    this.hood.visible = hoodAmt > 0.04;
    if (this.hood.visible) {
      this.hood.position.copy(hp).addScaledVector(hd, -0.02);
      this.hood.lookAt(hp.x + hd.x, hp.y + hd.y, hp.z + hd.z);   // local Z runs up the neck, X across it, Y = thin facing axis
      this.hood.scale.set(this.size * (0.12 + 0.2 * hoodAmt), this.size * 0.03, this.size * (0.2 + 0.14 * hoodAmt));
    }
    this.eyeMat.emissiveIntensity = 0.6 + eyeGlow * 3.5;
    const mid = P[(N * 0.35) | 0]; this.blob.position.set(mid.x, 0.025, mid.z); this.blob.scale.set(this.size * 3.2, this.size * 3.2, 1);
    this.blob.visible = sink < 0.5;
  }
  setOpacity(o) {
    for (const m of [this.mat, this.hoodMat]) { m.transparent = o < 1; m.opacity = o; }
    this.head.traverse((x) => { if (x.material) { x.material.transparent = o < 1; x.material.opacity = o; } });
  }
  dispose() { this.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }); }
}
