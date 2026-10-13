/* =====================================================================
   world.js - the jungle clearing: sky, lights, ground, swaying grass,
   trees, canopy, burrow holes, fireflies & glowing spores, time of day,
   GPU particle system and one-shot visual effects (rings, decals).
   ===================================================================== */
'use strict';

// Twilight palettes - each level moves the jungle through the day
const TIME_OF_DAY = [   // vivid palettes (user, 2026-10-13: colours looked faded)
  { name: 'Golden Jungle Evening', skyTop: 0x2a5bd7, skyMid: 0xff8f5a, skyLow: 0xffd36a, fog: 0xd8a070, hemiSky: 0xcfe8ff, hemiGround: 0x7a5426, hemi: 1.25, sun: 0xffd890, sunI: 2.7, sunDir: [-30, 22, -20], fire: 0.6 },
  { name: 'Moonlit Night', skyTop: 0x0a1250, skyMid: 0x1e46a8, skyLow: 0x4a86e8, fog: 0x1e3470, hemiSky: 0x8fb0ff, hemiGround: 0x3a3020, hemi: 1.05, sun: 0xcfe0ff, sunI: 2.0, sunDir: [20, 30, -25], fire: 1 },
  { name: 'Sunrise Jungle', skyTop: 0x4a8ae0, skyMid: 0xff9ab0, skyLow: 0xffe4a8, fog: 0xe0b8b0, hemiSky: 0xf0e8ff, hemiGround: 0x7a5a38, hemi: 1.3, sun: 0xffe0b0, sunI: 2.7, sunDir: [30, 18, 20], fire: 0.2 },
  { name: 'Bright Afternoon', skyTop: 0x1f78e0, skyMid: 0x7cc4ff, skyLow: 0xd8f0ff, fog: 0xb8dcf0, hemiSky: 0xe0f2ff, hemiGround: 0x8a6634, hemi: 1.35, sun: 0xfff4dc, sunI: 3.0, sunDir: [-20, 34, 14], fire: 0 },
  { name: 'Purple Dusk', skyTop: 0x30106a, skyMid: 0xd2409a, skyLow: 0xffa848, fog: 0x8a4a7a, hemiSky: 0xe0b0ff, hemiGround: 0x5a3420, hemi: 1.15, sun: 0xffb080, sunI: 2.5, sunDir: [25, 20, -10], fire: 1 },
];

// ---------------------------------------------------------------- particles
class ParticleSystem {
  constructor(scene, max, additive) {
    this.max = max; this.n = 0;
    this.pos = new Float32Array(max * 3); this.col = new Float32Array(max * 4); this.size = new Float32Array(max);
    this.vel = new Float32Array(max * 3); this.life = new Float32Array(max); this.maxLife = new Float32Array(max);
    this.grav = new Float32Array(max); this.drag = new Float32Array(max); this.grow = new Float32Array(max); this.a0 = new Float32Array(max);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('pcolor', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.uniforms = { uPx: { value: 600 } };
    const m = new THREE.ShaderMaterial({
      uniforms: this.uniforms, transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      vertexShader: `attribute float size; attribute vec4 pcolor; uniform float uPx; varying vec4 vC;
        void main(){ vC = pcolor; vec4 mv = modelViewMatrix * vec4(position,1.0); gl_PointSize = size * uPx / max(0.1, -mv.z); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `varying vec4 vC; void main(){ float d = length(gl_PointCoord - 0.5); if (d > 0.5) discard; gl_FragColor = vec4(vC.rgb, vC.a * smoothstep(0.5, 0.05, d)); }`,
    });
    this.points = new THREE.Points(g, m); this.points.frustumCulled = false; scene.add(this.points);
    this.geo = g;
  }
  emit(x, y, z, vx, vy, vz, life, size, color, alpha = 1, grav = 0, drag = 0, grow = 0) {
    if (this.n >= this.max) return;
    const i = this.n++;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    const c = new THREE.Color(color); this.col[i * 4] = c.r; this.col[i * 4 + 1] = c.g; this.col[i * 4 + 2] = c.b; this.col[i * 4 + 3] = alpha;
    this.a0[i] = alpha; this.size[i] = size; this.life[i] = this.maxLife[i] = life; this.grav[i] = grav; this.drag[i] = drag; this.grow[i] = grow;
  }
  burst(x, y, z, count, speed, life, size, color, opts = {}) {
    for (let k = 0; k < count; k++) {
      const a = rand(TAU), up = opts.up !== undefined ? opts.up : rand(0.2, 1), s = speed * rand(0.4, 1);
      this.emit(x + rand(-0.1, 0.1), y + rand(0, 0.1), z + rand(-0.1, 0.1), Math.cos(a) * s, up * s, Math.sin(a) * s,
        life * rand(0.6, 1.2), size * rand(0.6, 1.3), Array.isArray(color) ? color[(Math.random() * color.length) | 0] : color,
        opts.alpha || 0.9, opts.grav || 0, opts.drag || 1.5, opts.grow || 0);
    }
  }
  update(dt) {
    let i = 0;
    while (i < this.n) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this.copy(this.n - 1, i); this.n--; continue; }
      const d = Math.max(0, 1 - this.drag[i] * dt);
      this.vel[i * 3] *= d; this.vel[i * 3 + 2] *= d; this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * d - this.grav[i] * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt; this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt; this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      if (this.pos[i * 3 + 1] < 0.02) { this.pos[i * 3 + 1] = 0.02; this.vel[i * 3 + 1] *= -0.25; }
      this.size[i] += this.grow[i] * dt;
      const t = this.life[i] / this.maxLife[i]; this.col[i * 4 + 3] = this.a0[i] * Math.min(1, t * 2.2);
      i++;
    }
    this.geo.setDrawRange(0, this.n);
    for (const k of ['position', 'pcolor', 'size']) this.geo.attributes[k].needsUpdate = true;
  }
  copy(a, b) {
    for (let k = 0; k < 3; k++) { this.pos[b * 3 + k] = this.pos[a * 3 + k]; this.vel[b * 3 + k] = this.vel[a * 3 + k]; }
    for (let k = 0; k < 4; k++) this.col[b * 4 + k] = this.col[a * 4 + k];
    this.size[b] = this.size[a]; this.life[b] = this.life[a]; this.maxLife[b] = this.maxLife[a]; this.grav[b] = this.grav[a]; this.drag[b] = this.drag[a]; this.grow[b] = this.grow[a]; this.a0[b] = this.a0[a];
  }
  clear() { this.n = 0; }
}

// ---------------------------------------------------------------- environment
class Environment {
  constructor(scene) {
    this.scene = scene; this.t = 0; this.uniforms = { uTime: { value: 0 } };
    this.buildSky(); this.buildLights(); this.buildGround(); this.buildGrass(); this.buildFlowers(); this.buildTrees(); this.buildHoles(); this.buildFireflies();
    this.dust = new ParticleSystem(scene, 1400, false);
    this.glow = new ParticleSystem(scene, 900, true);
    this.fx = [];
    this.setTimeOfDay(0, true);
  }
  buildSky() {
    this.skyU = { top: { value: new THREE.Color() }, mid: { value: new THREE.Color() }, low: { value: new THREE.Color() } };
    const m = new THREE.ShaderMaterial({
      uniforms: this.skyU, side: THREE.BackSide, depthWrite: false, fog: false,
      vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `uniform vec3 top, mid, low; varying vec3 vP;
        void main(){ float h = vP.y; vec3 c = h > 0.18 ? mix(mid, top, smoothstep(0.18, 0.8, h)) : mix(low, mid, smoothstep(-0.05, 0.18, h)); gl_FragColor = vec4(c, 1.0); }`,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(400, 32, 16), m); this.scene.add(this.sky);
    this.moon = new THREE.Sprite(new THREE.SpriteMaterial({ map: TEX.dot, color: 0xfff2d6, fog: false, depthWrite: false }));
    this.moon.scale.set(40, 40, 1); this.scene.add(this.moon);
    this.scene.fog = new THREE.Fog(0x000000, 48, 150);
  }
  buildLights() {
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.8); this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffffff, 2);
    this.sun.castShadow = true; this.sun.shadow.mapSize.set(2048, 2048);
    const c = this.sun.shadow.camera; c.left = -26; c.right = 26; c.top = 26; c.bottom = -26; c.near = 1; c.far = 140;
    this.sun.shadow.bias = -0.0006; this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.sun); this.scene.add(this.sun.target);
    this.rim = new THREE.DirectionalLight(0x8dfcd0, 0.35); this.rim.position.set(20, 10, 30); this.scene.add(this.rim);  // neon-cool rim from behind
  }
  buildGround() {
    const g = new THREE.PlaneGeometry(CFG.GROUND_SIZE, CFG.GROUND_SIZE, 80, 80); g.rotateX(-Math.PI / 2);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {   // flat clearing, gently rolling forest floor beyond it
      const x = p.getX(i), z = p.getZ(i), r = Math.hypot(x, z);
      const e = smooth(clamp((r - CFG.ARENA_R - 4) / 20, 0, 1));
      p.setY(i, e * (Math.sin(x * 0.11) * Math.cos(z * 0.09) * 1.6 + Math.sin(x * 0.31 + z * 0.17) * 0.5));
    }
    g.computeVertexNormals();
    TEX.ground.repeat.set(16, 16);
    const m = new THREE.MeshStandardMaterial({ map: TEX.ground, bumpMap: TEX.ground, bumpScale: 0.9, roughness: 0.96, metalness: 0 });
    this.ground = new THREE.Mesh(g, m); this.ground.receiveShadow = true; this.scene.add(this.ground);
  }
  buildGrass() {
    // One blade cluster = 4 tapered blades; thousands drawn as one InstancedMesh, swaying in the wind (vertex shader)
    const blades = [];
    for (let k = 0; k < 4; k++) {
      const b = new THREE.PlaneGeometry(0.06, 0.6, 1, 3); b.translate(0, 0.3, 0);
      const pp = b.attributes.position; for (let i = 0; i < pp.count; i++) { const y = pp.getY(i); pp.setX(i, pp.getX(i) * (1 - y / 0.62)); pp.setZ(i, (y * y) * 0.25); }
      b.rotateY(k * Math.PI / 4 + 0.3); b.translate(Math.cos(k * 1.7) * 0.08, 0, Math.sin(k * 1.7) * 0.08); blades.push(b);
    }
    const geo = mergeGeos(blades);
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, side: THREE.DoubleSide, roughness: 0.9 });
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = this.uniforms.uTime;
      sh.vertexShader = 'uniform float uTime;\n' + sh.vertexShader.replace('#include <begin_vertex>',
        `#include <begin_vertex>
         float hh = position.y;
         vec4 wp0 = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
         transformed.x += sin(uTime * 1.7 + wp0.x * 0.35 + wp0.z * 0.21) * 0.32 * hh * hh;
         transformed.z += cos(uTime * 1.3 + wp0.z * 0.29) * 0.22 * hh * hh;`);
    };
    const N = 5200, mesh = new THREE.InstancedMesh(geo, mat, N), r = seeded(21), m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), col = new THREE.Color();
    for (let i = 0; i < N; i++) {
      let rr = Math.sqrt(r()) * 70, a = r() * TAU;
      if (rr < CFG.ARENA_R && r() < 0.78) rr = CFG.ARENA_R + r() * 46;     // a mostly open clearing to fight in
      const x = Math.cos(a) * rr, z = Math.sin(a) * rr, s = rr < CFG.ARENA_R ? 0.5 + r() * 0.6 : 0.8 + r() * 1.6;
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), r() * TAU);
      m4.compose(new THREE.Vector3(x, groundH(x, z), z), q, new THREE.Vector3(s, s * (0.8 + r() * 0.8), s)); mesh.setMatrixAt(i, m4);
      col.setHSL(0.2 + r() * 0.13, 0.65 + r() * 0.25, 0.26 + r() * 0.18); mesh.setColorAt(i, col);
    }
    mesh.receiveShadow = true; this.scene.add(mesh); this.grass = mesh;
  }
  buildFlowers() {   // bright wildflowers ringing the clearing: red, yellow, orange, pink, white blossoms on stems
    const r = seeded(31), N = 700, m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), col = new THREE.Color();
    const head = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.11, 0), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, emissive: 0x221100, flatShading: true }), N);
    const stem = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.012, 0.016, 1, 4).translate(0, 0.5, 0), new THREE.MeshStandardMaterial({ color: 0x3f9a2a }), N);
    const cols = [0xff2a2a, 0xffd21a, 0xff8a1a, 0xff5ab4, 0xffffff, 0xb04aff, 0xffe066];
    for (let i = 0; i < N; i++) {
      const a = r() * TAU, d = CFG.ARENA_R - 4 + Math.pow(r(), 0.7) * 34, x = Math.cos(a) * d, z = Math.sin(a) * d, h = 0.25 + r() * 0.45, y = groundH(x, z);
      m4.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(1, h, 1)); stem.setMatrixAt(i, m4);
      const s = 0.7 + r() * 0.8; m4.compose(new THREE.Vector3(x, y + h, z), q, new THREE.Vector3(s, s * 0.6, s)); head.setMatrixAt(i, m4);
      col.setHex(cols[(r() * cols.length) | 0]); head.setColorAt(i, col);
    }
    head.castShadow = false; this.scene.add(stem); this.scene.add(head);
  }
  buildTrees() {
    const r = seeded(44), bark = new THREE.MeshStandardMaterial({ map: TEX.bark, roughness: 1 });
    const leafMats = [0x4a9a2e, 0x3a8a26, 0x62b23c, 0x2f7a2a].map((c) => new THREE.MeshStandardMaterial({ color: c, map: TEX.leaf, roughness: 0.95, flatShading: true }));
    this.sway = [];
    const tree = (x, z, s) => {
      const g = new THREE.Group(); g.position.set(x, groundH(x, z) - 0.2, z);
      const h = 7 + r() * 6;
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.25 * s, 0.55 * s, h, 9), bark); trunk.position.y = h / 2; trunk.castShadow = true; g.add(trunk);
      for (let k = 0; k < 4; k++) {   // buttress roots
        const root = new THREE.Mesh(new THREE.ConeGeometry(0.35 * s, 1.6 * s, 5), bark); const a = k * TAU / 4 + r();
        root.position.set(Math.cos(a) * 0.45 * s, 0.5 * s, Math.sin(a) * 0.45 * s); root.rotation.set(Math.sin(a) * 0.6, 0, -Math.cos(a) * 0.6); g.add(root);
      }
      const crown = new THREE.Group(); crown.position.y = h; g.add(crown);
      const n = 5 + ((r() * 4) | 0);
      for (let k = 0; k < n; k++) {
        const blob = new THREE.Mesh(new THREE.IcosahedronGeometry((1.6 + r() * 1.8) * s, 1), leafMats[(r() * 4) | 0]);
        blob.position.set((r() - 0.5) * 4 * s, (r() - 0.2) * 2.4 * s, (r() - 0.5) * 4 * s); blob.scale.y = 0.7; blob.castShadow = true; crown.add(blob);
      }
      this.scene.add(g); this.sway.push({ obj: crown, ph: r() * TAU });
    };
    for (let i = 0; i < 46; i++) { const a = r() * TAU, d = CFG.ARENA_R + 7 + r() * 38; tree(Math.cos(a) * d, Math.sin(a) * d, 0.8 + r() * 0.7); }
    // Bushes, ferns and rocks ring the clearing
    const bushMat = new THREE.MeshStandardMaterial({ color: 0x4f9a34, map: TEX.leaf, roughness: 1, flatShading: true });
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x6d665c, roughness: 0.9, flatShading: true });
    for (let i = 0; i < 60; i++) {
      const a = r() * TAU, d = CFG.ARENA_R + 1 + r() * 20, x = Math.cos(a) * d, z = Math.sin(a) * d;
      const b = new THREE.Mesh(new THREE.IcosahedronGeometry(0.8 + r() * 1.2, 1), bushMat); b.position.set(x, groundH(x, z) + 0.3, z); b.scale.y = 0.65; b.castShadow = true; b.receiveShadow = true; this.scene.add(b);
      this.sway.push({ obj: b, ph: r() * TAU, small: true });
    }
    const fernMat = new THREE.MeshStandardMaterial({ color: 0x5cbc3a, side: THREE.DoubleSide, roughness: 0.9 });
    for (let i = 0; i < 40; i++) {
      const a = r() * TAU, d = CFG.ARENA_R - 1 + r() * 10, x = Math.cos(a) * d, z = Math.sin(a) * d, f = new THREE.Group();
      for (let k = 0; k < 7; k++) { const leaf = new THREE.Mesh(new THREE.PlaneGeometry(0.28, 1.4, 1, 4), fernMat); leaf.geometry.translate(0, 0.7, 0); leaf.rotation.set(-0.9 - r() * 0.3, k * TAU / 7, 0, 'YXZ'); f.add(leaf); }
      f.position.set(x, groundH(x, z), z); this.scene.add(f);
    }
    for (let i = 0; i < 24; i++) {
      const a = r() * TAU, d = CFG.ARENA_R - 2 + r() * 14, x = Math.cos(a) * d, z = Math.sin(a) * d;
      const k = new THREE.Mesh(new THREE.DodecahedronGeometry(0.3 + r() * 0.9, 0), rockMat); k.position.set(x, groundH(x, z) + 0.1, z); k.rotation.set(r() * 3, r() * 3, r() * 3); k.scale.y = 0.6; k.castShadow = true; k.receiveShadow = true; this.scene.add(k);
    }
    // Hanging vines / overhead canopy silhouettes - dappled shadows on the clearing edge
    for (let i = 0; i < 14; i++) {
      const a = r() * TAU, d = CFG.ARENA_R + 2 + r() * 8;
      const c = new THREE.Mesh(new THREE.IcosahedronGeometry(3 + r() * 3, 1), leafMats[(r() * 4) | 0]); c.position.set(Math.cos(a) * d, 13 + r() * 4, Math.sin(a) * d); c.scale.y = 0.35; c.castShadow = true; this.scene.add(c);
    }
  }
  buildHoles() {
    this.holes = [];
    const mat = new THREE.MeshBasicMaterial({ map: TEX.hole, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
    const rimMat = new THREE.MeshStandardMaterial({ color: 0x4a3825, map: TEX.ground, roughness: 1 });
    for (let i = 0; i < 8; i++) {
      const a = i * TAU / 8 + 0.3, d = CFG.ARENA_R - 3, x = Math.cos(a) * d, z = Math.sin(a) * d;
      const h = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 2.2), mat); h.rotation.x = -Math.PI / 2; h.position.set(x, 0.03, z); this.scene.add(h);
      const rim = new THREE.Mesh(new THREE.TorusGeometry(0.85, 0.22, 6, 14), rimMat); rim.rotation.x = -Math.PI / 2; rim.position.set(x, 0.02, z); rim.scale.z = 0.5; rim.receiveShadow = true; this.scene.add(rim);
      this.holes.push({ x, z });
    }
  }
  buildFireflies() {
    this.flies = new ParticleSystem(this.scene, 260, true);
    this.flyData = [];
    const r = seeded(77);
    for (let i = 0; i < 160; i++) {
      const a = r() * TAU, d = 6 + r() * 40;
      this.flyData.push({ x: Math.cos(a) * d, z: Math.sin(a) * d, y: 0.4 + r() * 3.5, ph: r() * TAU, sp: 0.3 + r() * 0.6, spore: false });
    }
    for (let i = 0; i < 90; i++) {   // drifting bioluminescent spores
      const a = r() * TAU, d = r() * 30;
      this.flyData.push({ x: Math.cos(a) * d, z: Math.sin(a) * d, y: r() * 6, ph: r() * TAU, sp: 0.15 + r() * 0.2, spore: true });
    }
  }
  setTimeOfDay(i, instant) {
    const p = TIME_OF_DAY[i % TIME_OF_DAY.length]; this.tod = p; this.todIndex = i % TIME_OF_DAY.length;
    this.skyU.top.value.set(p.skyTop); this.skyU.mid.value.set(p.skyMid); this.skyU.low.value.set(p.skyLow);
    this.scene.fog.color.set(p.fog); this.hemi.color.set(p.hemiSky); this.hemi.groundColor.set(p.hemiGround); this.hemi.intensity = p.hemi;
    this.sun.color.set(p.sun); this.sun.intensity = p.sunI; this.sunDir = new THREE.Vector3(...p.sunDir).normalize();
    this.moon.position.copy(this.sunDir).multiplyScalar(300); this.moon.material.color.set(p.sun);
    this.fireLevel = p.fire;
  }
  follow(x, z) {   // keep the shadow camera centred on the action
    this.sun.position.set(x + this.sunDir.x * 60, this.sunDir.y * 60, z + this.sunDir.z * 60);
    this.sun.target.position.set(x, 0, z);
  }
  ring(x, z, color, r0, r1, life, y = 0.06) {   // expanding flat ring (shockwaves, warnings)
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: TEX.ring, color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    m.rotation.x = -Math.PI / 2; m.position.set(x, y, z); this.scene.add(m);
    this.fx.push({ m, t: 0, life, r0, r1, kind: 'ring' });
  }
  cone(x, z, ang, range, color, life) {   // sonic screech wavefront
    const g = new THREE.RingGeometry(0.2, 1, 24, 1, -CFG.SCREECH_ARC, CFG.SCREECH_ARC * 2); g.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
    m.position.set(x, 0.5, z); m.rotation.y = -ang; this.scene.add(m);
    this.fx.push({ m, t: 0, life, r0: 0.5, r1: range, kind: 'cone' });
  }
  decal(x, z, tex, size, life, color = 0xffffff) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ map: tex, color, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3 }));
    m.rotation.x = -Math.PI / 2; m.position.set(x, 0.04, z); this.scene.add(m);
    this.fx.push({ m, t: 0, life, kind: 'decal' }); return m;
  }
  update(dt, focus) {
    this.t += dt; this.uniforms.uTime.value = this.t;
    for (const s of this.sway) { s.obj.rotation.z = Math.sin(this.t * (s.small ? 1.2 : 0.6) + s.ph) * (s.small ? 0.04 : 0.025); }
    // fireflies blink and wander; spores drift upward
    this.flies.clear();
    for (const f of this.flyData) {
      const tt = this.t * f.sp + f.ph;
      if (f.spore) {
        const y = (f.y + this.t * 0.25 * f.sp * 3) % 6.5;
        this.flies.emit(f.x + Math.sin(tt) * 1.5, y, f.z + Math.cos(tt * 0.8) * 1.5, 0, 0, 0, 1, 0.06, 0x7ff7ff, 0.35 + 0.2 * Math.sin(tt * 3), 0, 0);
      } else if (this.fireLevel > 0) {
        const blink = Math.max(0, Math.sin(tt * 2.3)) ** 3 * this.fireLevel;
        if (blink > 0.02) this.flies.emit(f.x + Math.sin(tt) * 2, f.y + Math.sin(tt * 1.7) * 0.6, f.z + Math.cos(tt * 0.9) * 2, 0, 0, 0, 1, 0.16, 0xd8ff6a, blink, 0, 0);
      }
    }
    this.flies.geo.setDrawRange(0, this.flies.n);
    for (const k of ['position', 'pcolor', 'size']) this.flies.geo.attributes[k].needsUpdate = true;
    this.dust.update(dt); this.glow.update(dt);
    for (let i = this.fx.length - 1; i >= 0; i--) {
      const f = this.fx[i]; f.t += dt; const k = f.t / f.life;
      if (k >= 1) { this.scene.remove(f.m); f.m.geometry.dispose(); f.m.material.dispose(); this.fx.splice(i, 1); continue; }
      if (f.kind === 'ring' || f.kind === 'cone') { const s = lerp(f.r0, f.r1, 1 - (1 - k) ** 3); f.m.scale.set(s * (f.kind === 'ring' ? 2 : 1), s * (f.kind === 'ring' ? 2 : 1), 1); if (f.kind === 'cone') f.m.scale.set(s, 1, s); f.m.material.opacity = (f.kind === 'cone' ? 0.55 : 1) * (1 - k); }
      else f.m.material.opacity = Math.min(1, (1 - k) * 3);
    }
    if (focus) this.follow(focus.x, focus.z);
  }
}

function groundH(x, z) {   // matches buildGround's displacement
  const r = Math.hypot(x, z), e = smooth(clamp((r - CFG.ARENA_R - 4) / 20, 0, 1));
  return e * (Math.sin(x * 0.11) * Math.cos(z * 0.09) * 1.6 + Math.sin(x * 0.31 + z * 0.17) * 0.5);
}

function mergeGeos(list) {   // tiny merge for non-indexed + indexed plane geometries
  let vCount = 0, iCount = 0; for (const g of list) { vCount += g.attributes.position.count; iCount += g.index ? g.index.count : g.attributes.position.count; }
  const pos = new Float32Array(vCount * 3), nor = new Float32Array(vCount * 3), uv = new Float32Array(vCount * 2), idx = [];
  let vo = 0;
  for (const g of list) {
    pos.set(g.attributes.position.array, vo * 3); nor.set(g.attributes.normal.array, vo * 3); uv.set(g.attributes.uv.array, vo * 2);
    if (g.index) for (let i = 0; i < g.index.count; i++) idx.push(g.index.array[i] + vo); else for (let i = 0; i < g.attributes.position.count; i++) idx.push(i + vo);
    vo += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3)); out.setAttribute('normal', new THREE.BufferAttribute(nor, 3)); out.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); out.setIndex(idx);
  out.computeVertexNormals(); return out;
}
