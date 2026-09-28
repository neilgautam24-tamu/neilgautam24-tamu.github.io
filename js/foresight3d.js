/*
 * 3D illustration of goal-conditioned egocentric motion prediction.
 * Loaded lazily by viz.js, which passes in three.js from the CDN; if WebGL or the
 * CDN is unavailable, the 2D canvas version stays in place.
 *
 * Story per episode: 1) Scene: observe the room  2) Goal: an interaction target is set
 * 3) Motion: the person walks around furniture and reaches for it, with predicted future
 * poses, stochastic trajectory samples and a live head-mounted (egocentric) camera inset.
 */
window.mountForesight3D = function (fig, THREE, fallback) {
  'use strict';

  const reduceMQ = matchMedia('(prefers-reduced-motion: reduce)');
  const darkMQ = matchMedia('(prefers-color-scheme: dark)');
  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, s) => a + (b - a) * s;
  const smooth = s => s * s * (3 - 2 * s);
  const ease = s => (s < 0.5 ? 4 * s * s * s : 1 - Math.pow(-2 * s + 2, 3) / 2);
  const lerpAngle = (a, b, s) => a + (((((b - a) % TAU) + TAU * 1.5) % TAU) - Math.PI) * s;
  const V = (x, y, z) => new THREE.Vector3(x, y, z);

  // Timing (seconds) and gait constants.
  const T_SCENE = 2.4, T_GOAL = 1.8, T_REACH = 1.2, T_HOLD = 1.4, T_FADE = 0.5;
  const VMAX = 1.15, T_ACC = 0.7, STRIDE = 1.35, HORIZON = 2.4;
  const FUTURE = [0.6, 1.2, 1.8, 2.4];

  // ── Renderer & cameras ─────────────────────────────────
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const canvas = renderer.domElement;
  canvas.className = 'f3d-canvas';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'Animated 3D illustration: in a furnished room, a goal object is highlighted, then a person walks around the furniture and reaches for it. Grey shows the observed path, blue shows predicted future poses and sampled trajectories, and an inset shows the view from a head-mounted camera.');

  const scene = new THREE.Scene();
  // Everything lives in a mirrored group so the open side of the room faces the
  // top-left corner, where the egocentric inset sits.
  const world = new THREE.Group();
  world.scale.x = -1;
  scene.add(world);
  const cam = new THREE.PerspectiveCamera(30, 2, 0.1, 60);
  cam.layers.enable(1); // layer 1 = annotations, hidden from the egocentric camera
  const ego = new THREE.PerspectiveCamera(100, 1.6, 0.02, 30);

  // ── Materials (colors set by applyTheme) ───────────────
  const std = (o = {}) => new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0, ...o });
  const M = {
    floor: std({ roughness: 0.95 }), rug: std({ roughness: 1 }), wall: std({ roughness: 0.95 }),
    furn: std(), wood: std({ roughness: 0.7 }), soft: std({ roughness: 1 }), plant: std(), pot: std(),
    target: std({ roughness: 0.45, emissiveIntensity: 0.35 }),
    human: std({ roughness: 0.5 }),
    past: std({ transparent: true, opacity: 0.22 }),
    ghosts: FUTURE.map((_, i) => std({ transparent: true, opacity: [0.5, 0.36, 0.25, 0.16][i], emissiveIntensity: 0.35 })),
    accentLine: new THREE.LineBasicMaterial({ transparent: true, opacity: 0.35 }),
    meanLine: new THREE.LineDashedMaterial({ dashSize: 0.09, gapSize: 0.06, transparent: true, opacity: 0.95 }),
    pastLine: new THREE.LineBasicMaterial({ transparent: true, opacity: 0.6 }),
    link: new THREE.LineDashedMaterial({ dashSize: 0.06, gapSize: 0.05, transparent: true, opacity: 0 }),
    ring: new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }),
    pulse: new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false }),
    halo: new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.22, depthWrite: false }),
    grid: new THREE.LineBasicMaterial({ transparent: true, opacity: 0.1 }),
  };

  function applyTheme() {
    const cs = getComputedStyle(document.documentElement);
    const accent = new THREE.Color(cs.getPropertyValue('--accent').trim() || '#1f3fb8');
    const bg = new THREE.Color(cs.getPropertyValue('--bg-alt').trim() || '#f3f1ec');
    const dark = darkMQ.matches;
    const P = dark
      ? { floor: '#34373e', rug: '#40444c', wall: '#2e3137', furn: '#50565f', wood: '#6b5c4b', soft: '#3d4a5c', plant: '#4f7d5b', pot: '#6d5446', human: '#c3cbd6', past: '#8d949e', target: '#e0874f', grid: '#ffffff' }
      : { floor: '#e8e3da', rug: '#d9d2c4', wall: '#f5f2eb', furn: '#dcd6ca', wood: '#b89f80', soft: '#9fb0c4', plant: '#77a283', pot: '#b98f73', human: '#c6ceda', past: '#8a9099', target: '#d9733f', grid: '#3b3f47' };
    scene.background = bg;
    scene.fog = new THREE.Fog(bg, 13, 24);
    ['floor', 'rug', 'wall', 'furn', 'wood', 'soft', 'plant', 'pot', 'human', 'past'].forEach(k => M[k].color.set(P[k]));
    M.target.color.set(P.target);
    M.target.emissive.set(P.target);
    M.grid.color.set(P.grid);
    M.ghosts.forEach(m => { m.color.copy(accent); m.emissive.copy(accent); });
    [M.accentLine, M.meanLine, M.link, M.ring, M.pulse, M.halo].forEach(m => m.color.copy(accent));
    M.pastLine.color.set(P.past);
  }

  // ── Room ───────────────────────────────────────────────
  function box(w, h, d, mat, x, y, z, cast = true) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    m.castShadow = cast;
    m.receiveShadow = true;
    world.add(m);
    return m;
  }
  function cyl(rt, rb, h, mat, x, y, z, seg = 20) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat);
    m.position.set(x, y, z);
    m.castShadow = m.receiveShadow = true;
    world.add(m);
    return m;
  }

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(7.2, 5.2), M.floor);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  world.add(floor);
  {
    const g = [];
    for (let x = -3.5; x <= 3.51; x += 0.5) g.push(x, 0.003, -2.6, x, 0.003, 2.6);
    for (let z = -2.5; z <= 2.51; z += 0.5) g.push(-3.6, 0.003, z, 3.6, 0.003, z);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(g, 3));
    world.add(new THREE.LineSegments(geo, M.grid));
  }
  box(7.2, 2.5, 0.08, M.wall, 0, 1.25, -2.64, false);
  box(0.08, 2.5, 5.2, M.wall, -3.64, 1.25, 0, false);
  const rug = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 1.9), M.rug);
  rug.rotation.x = -Math.PI / 2;
  rug.position.set(0.1, 0.004, -0.25);
  rug.receiveShadow = true;
  world.add(rug);

  // kitchen counter + wall cabinet + cup (goal A)
  box(2.3, 0.88, 0.6, M.furn, -1.5, 0.44, -2.3);
  box(2.36, 0.04, 0.66, M.wood, -1.5, 0.9, -2.3);
  box(2.3, 0.6, 0.34, M.furn, -1.5, 1.95, -2.43);
  box(0.26, 0.22, 0.18, M.furn, -0.75, 1.03, -2.32);
  cyl(0.045, 0.038, 0.11, M.target, -1.6, 0.975, -2.12);
  // shelf on the left wall + box (goal B)
  box(0.38, 1.7, 1.1, M.furn, -3.41, 0.85, -0.6);
  [0.45, 0.9, 1.35].forEach(y => box(0.34, 0.03, 1.02, M.wood, -3.38, y, -0.6));
  [[-0.95, 0.12], [-0.82, 0.16], [-0.3, 0.1]].forEach(([z, h]) => box(0.22, h + 0.14, 0.05, M.soft, -3.36, 0.9 + (h + 0.14) / 2 + 0.015, z));
  box(0.2, 0.14, 0.22, M.target, -3.3, 0.99, -0.45);
  // table + chairs
  box(1.2, 0.04, 0.8, M.wood, 0.1, 0.74, -0.25);
  [[-0.45, -0.58], [0.65, -0.58], [-0.45, 0.08], [0.65, 0.08]].forEach(([x, z]) => cyl(0.025, 0.025, 0.72, M.wood, x, 0.36, z, 10));
  [[-0.2, 0.35, 0], [0.4, 0.35, 0], [0.1, -0.85, Math.PI]].forEach(([x, z, r]) => {
    box(0.42, 0.04, 0.42, M.furn, x, 0.45, z);
    box(0.42, 0.42, 0.04, M.furn, x, 0.68, z + (r ? -0.19 : 0.19));
    [[-0.18, -0.18], [0.18, -0.18], [-0.18, 0.18], [0.18, 0.18]].forEach(([dx, dz]) => cyl(0.018, 0.018, 0.44, M.furn, x + dx, 0.22, z + dz, 8));
  });
  // armchair by the right edge, facing into the room
  box(0.8, 0.4, 0.8, M.soft, 3.05, 0.2, -0.95);
  box(0.2, 0.5, 0.8, M.soft, 3.35, 0.62, -0.95);
  box(0.8, 0.58, 0.16, M.soft, 3.05, 0.29, -1.41);
  box(0.8, 0.58, 0.16, M.soft, 3.05, 0.29, -0.49);
  // plant
  cyl(0.16, 0.12, 0.34, M.pot, 3.0, 0.17, -2.2);
  [[0, 0.62, 0, 0.26], [0.1, 0.8, 0.05, 0.18], [-0.1, 0.78, -0.06, 0.2]].forEach(([x, y, z, r]) => {
    const m = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), M.plant);
    m.position.set(3.0 + x, y, -2.2 + z);
    m.castShadow = true;
    world.add(m);
  });

  // lights
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8174, 1.55));
  const sun = new THREE.DirectionalLight(0xfff4e6, 2.3);
  sun.position.set(-3.5, 7, 3);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -5, right: 5, top: 5, bottom: -5, near: 1, far: 20 });
  sun.shadow.bias = -0.0004;
  sun.shadow.radius = 4;
  scene.add(sun);

  // ── Articulated body (SMPL-like mannequin) ─────────────
  function makeBody(mat, cast) {
    const J = {};
    const root = new THREE.Group();
    const add = (parent, mesh) => { mesh.castShadow = cast; mesh.receiveShadow = !mat.transparent; parent.add(mesh); return mesh; };
    const cap = (r, len) => new THREE.CapsuleGeometry(r, len, 6, 14);
    const joint = (parent, name, x, y, z) => { const j = new THREE.Group(); j.position.set(x, y, z); parent.add(j); J[name] = j; return j; };
    const limb = (j, r, len) => { const m = add(j, new THREE.Mesh(cap(r, len), mat)); m.position.y = -len / 2 - r * 0.2; return m; };

    const pelvis = joint(root, 'pelvis', 0, 0.93, 0);
    const pm = add(pelvis, new THREE.Mesh(cap(0.125, 0.1), mat));
    pm.rotation.z = Math.PI / 2;
    pm.scale.set(1, 1, 0.85);
    const chest = joint(pelvis, 'chest', 0, 0.08, 0);
    const tm = add(chest, new THREE.Mesh(cap(0.145, 0.24), mat));
    tm.position.y = 0.24;
    tm.scale.set(1.12, 1, 0.72);
    const neck = joint(chest, 'neck', 0, 0.47, 0);
    add(neck, new THREE.Mesh(cap(0.045, 0.05), mat)).position.y = 0.03;
    const head = joint(neck, 'head', 0, 0.09, 0);
    const hm = add(head, new THREE.Mesh(new THREE.SphereGeometry(0.105, 24, 18), mat));
    hm.position.set(0, 0.09, 0.01);
    hm.scale.set(0.9, 1.08, 1);
    // head-mounted camera (e.g. Project Aria glasses)
    const cam3 = add(head, new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.025, 0.03), mat));
    cam3.position.set(0, 0.1, 0.1);

    [['L', 1], ['R', -1]].forEach(([s, sx]) => {
      const sh = joint(chest, 'sh' + s, 0.19 * sx, 0.39, 0);
      limb(sh, 0.047, 0.24);
      const el = joint(sh, 'el' + s, 0, -0.29, 0);
      limb(el, 0.04, 0.22);
      const hand = add(el, new THREE.Mesh(new THREE.SphereGeometry(0.046, 14, 10), mat));
      hand.position.y = -0.3;
      hand.scale.set(0.8, 1.2, 0.6);
      const hip = joint(pelvis, 'hip' + s, 0.095 * sx, -0.04, 0);
      limb(hip, 0.075, 0.33);
      const kn = joint(hip, 'kn' + s, 0, -0.42, 0);
      limb(kn, 0.056, 0.34);
      const an = joint(kn, 'an' + s, 0, -0.42, 0);
      const ft = add(an, new THREE.Mesh(cap(0.042, 0.14), mat));
      ft.rotation.x = Math.PI / 2;
      ft.position.set(0, -0.03, 0.06);
    });
    world.add(root);
    return { root, J };
  }

  const tmpV = new THREE.Vector3();
  // Pose from gait phase, gait amplitude, reach blend. Local +z is forward, right side is -x.
  function pose(B, st) {
    const { J } = B;
    const a = st.a, w = st.reach;
    const legs = { L: st.phi, R: st.phi + Math.PI };
    for (const s of ['L', 'R']) {
      const p = legs[s];
      const hip = -0.44 * Math.cos(p) * a;
      const knee = 0.06 + (0.12 * Math.max(0, Math.sin(p)) + 1.0 * Math.pow(Math.max(0, -Math.sin(p)), 1.4)) * a;
      J['hip' + s].rotation.set(hip, 0, 0);
      J['kn' + s].rotation.set(knee, 0, 0);
      J['an' + s].rotation.set(-(hip + knee) * 0.85, 0, 0);
      const opp = s === 'L' ? legs.R : legs.L;
      J['sh' + s].rotation.set(-0.34 * Math.cos(opp) * a + 0.04, 0, (s === 'L' ? 1 : -1) * 0.07);
      J['el' + s].rotation.set(-(0.22 + 0.2 * a), 0, 0);
    }
    // right arm reaches toward the goal object
    J.shR.rotation.x = lerp(J.shR.rotation.x, -st.reachPitch, w);
    J.shR.rotation.z = lerp(J.shR.rotation.z, -0.02, w);
    J.elR.rotation.x = lerp(J.elR.rotation.x, -0.18, w);
    J.pelvis.rotation.set(0, 0.09 * Math.cos(st.phi) * a, 0);
    J.chest.rotation.set(0.05 * a + 0.1 * w, -0.14 * Math.cos(st.phi) * a, 0);
    J.neck.rotation.set(0.1 + 0.08 * w - 0.05 * a, 0, 0);
    J.head.rotation.set(0.06, 0.12 * Math.cos(st.phi) * a * 0.3, 0);

    B.root.position.set(st.x, 0, st.z);
    B.root.rotation.set(0, st.yaw, 0);
    // keep the lower foot on the floor
    J.pelvis.position.y = 0.93;
    B.root.updateMatrixWorld(true);
    const yl = J.anL.getWorldPosition(tmpV).y, yr = J.anR.getWorldPosition(tmpV).y;
    J.pelvis.position.y += 0.075 - Math.min(yl, yr);
  }

  const body = makeBody(M.human, true);
  const pastBody = makeBody(M.past, false);
  const ghosts = M.ghosts.map(m => makeBody(m, false));
  [pastBody, ...ghosts].forEach(g => g.root.traverse(o => o.layers.set(1)));

  // ── Episodes ───────────────────────────────────────────
  const EPISODES = [
    { goal: 'pick up the cup', target: V(-1.6, 0.99, -2.12), reachPitch: 1.05,
      pts: [[2.3, 1.9], [1.3, 1.1], [-1.0, 0.9], [-1.3, -0.5], [-1.6, -1.55]] },
    { goal: 'take the box from the shelf', target: V(-3.3, 1.02, -0.45), reachPitch: 1.3,
      pts: [[2.6, 0.9], [1.4, 0.95], [0.1, 1.0], [-1.6, 0.65], [-2.7, -0.45]] },
  ].map(ep => {
    ep.curve = new THREE.CatmullRomCurve3(ep.pts.map(([x, z]) => V(x, 0, z)), false, 'centripetal');
    ep.L = ep.curve.getLength();
    ep.dMove = ep.L / VMAX + T_ACC;
    ep.stand = ep.curve.getPointAt(1);
    ep.faceYaw = Math.atan2(ep.target.x - ep.stand.x, ep.target.z - ep.stand.z);
    ep.tWalk = T_SCENE + T_GOAL;
    ep.T = ep.tWalk + ep.dMove + T_REACH + T_HOLD + T_FADE;
    return ep;
  });
  const CYCLE = EPISODES.reduce((s, e) => s + e.T, 0);

  function locate(t) {
    let u = ((t % CYCLE) + CYCLE) % CYCLE;
    for (const ep of EPISODES) { if (u < ep.T) return [ep, u]; u -= ep.T; }
    return [EPISODES[0], 0];
  }
  function travel(ep, tau) {
    const acc = VMAX / T_ACC;
    tau = clamp(tau, 0, ep.dMove);
    if (tau < T_ACC) return [0.5 * acc * tau * tau, acc * tau];
    if (tau < ep.dMove - T_ACC) return [0.5 * VMAX * T_ACC + VMAX * (tau - T_ACC), VMAX];
    const r = ep.dMove - tau;
    return [ep.L - 0.5 * acc * r * r, acc * r];
  }
  const tan = new THREE.Vector3(), pt = new THREE.Vector3();
  function stateAt(ep, u) {
    const [s, v] = travel(ep, u - ep.tWalk);
    ep.curve.getPointAt(clamp(s / ep.L, 0, 1), pt);
    ep.curve.getTangentAt(clamp(s / ep.L, 0, 0.999), tan);
    let yaw = Math.atan2(tan.x, tan.z);
    const rem = ep.L - s;
    if (rem < 0.8) yaw = lerpAngle(yaw, ep.faceYaw, smooth(1 - rem / 0.8));
    const reachT = u - ep.tWalk - ep.dMove;
    const reach = smooth(clamp(reachT / T_REACH, 0, 1)) * (1 - smooth(clamp((reachT - T_REACH - T_HOLD + 0.3) / 0.6, 0, 1)));
    return { x: pt.x, z: pt.z, yaw, phi: (TAU * s) / STRIDE, a: v / VMAX, s, reach, reachPitch: ep.reachPitch };
  }

  // ── Annotations ────────────────────────────────────────
  function lineObj(n, mat) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    const l = new THREE.Line(geo, mat);
    l.frustumCulled = false;
    l.layers.set(1);
    world.add(l);
    return l;
  }
  function setLine(l, pts) {
    const arr = l.geometry.attributes.position.array;
    pts.forEach((p, i) => { arr[i * 3] = p.x; arr[i * 3 + 1] = p.y; arr[i * 3 + 2] = p.z; });
    l.geometry.attributes.position.needsUpdate = true;
    l.geometry.setDrawRange(0, pts.length);
    if (l.material.isLineDashedMaterial) l.computeLineDistances();
  }
  const SAMPLES = 10, SP = 26;
  const samples = Array.from({ length: SAMPLES }, () => lineObj(SP, M.accentLine));
  const meanLine = lineObj(SP, M.meanLine);
  const pastLine = lineObj(80, M.pastLine);
  const linkLine = lineObj(2, M.link);

  const goalRing = new THREE.Mesh(new THREE.RingGeometry(0.2, 0.245, 56), M.ring);
  const pulseRing = new THREE.Mesh(new THREE.RingGeometry(0.2, 0.22, 56), M.pulse);
  [goalRing, pulseRing].forEach(r => { r.rotation.x = -Math.PI / 2; world.add(r); });
  const halo = new THREE.Mesh(new THREE.SphereGeometry(0.13, 24, 16), M.halo);
  world.add(halo);
  const stem = lineObj(2, M.meanLine);

  // ── DOM overlay ────────────────────────────────────────
  const ui = document.createElement('div');
  ui.className = 'f3d-ui';
  ui.innerHTML = `
    <div class="f3d-ego"><span class="f3d-rec"></span>head-mounted camera</div>
    <div class="f3d-story">
      <ol class="f3d-steps"><li>Scene</li><li>Goal</li><li>Motion</li></ol>
      <p class="f3d-caption"></p>
    </div>
    <div class="f3d-goal"></div>
    <div class="f3d-legend"><span class="lg-obs">observed</span><span class="lg-pred">predicted</span><span class="lg-samp">samples</span></div>`;
  const $ = s => ui.querySelector(s);
  const steps = [...ui.querySelectorAll('.f3d-steps li')];
  const egoFrame = $('.f3d-ego'), caption = $('.f3d-caption'), goalTag = $('.f3d-goal');

  // ── Frame ──────────────────────────────────────────────
  let W = 1, H = 1, inset = { x: 12, y: 12, w: 200, h: 124 };
  const head = new THREE.Vector3(), fwd = new THREE.Vector3(), proj = new THREE.Vector3();
  const LOOK = V(-0.05, 0.55, -0.35);
  let lastPhase = -1;

  function render(t) {
    const [ep, u] = locate(t);
    const st = stateAt(ep, u);
    const phase = u < T_SCENE ? 0 : u < ep.tWalk ? 1 : 2;
    const walking = u >= ep.tWalk && u < ep.tWalk + ep.dMove;

    // main camera: slow reveal orbit during the scene phase, then a gentle drift
    const orbit = u < T_SCENE ? lerp(-0.5, 0, ease(u / T_SCENE)) : 0;
    const th = -(0.6 + orbit + 0.03 * Math.sin(t * 0.2));
    const R = W / H < 1.8 ? 9.2 : 8.4;
    cam.position.set(LOOK.x + R * Math.sin(th), 4.9, LOOK.z + R * Math.cos(th));
    cam.lookAt(LOOK);

    pose(body, st);
    // predicted future poses (blue) and one observed past pose (grey)
    FUTURE.forEach((dt, i) => {
      const g = ghosts[i];
      const fs = stateAt(ep, Math.min(u + dt, ep.T - T_FADE));
      g.root.visible = phase === 2 && fs.s - st.s > 0.3;
      if (g.root.visible) pose(g, fs);
    });
    const ps = stateAt(ep, u - 1.1);
    pastBody.root.visible = walking && st.s - ps.s > 0.4;
    if (pastBody.root.visible) pose(pastBody, ps);

    // observed trail
    const trail = [];
    if (u > ep.tWalk) {
      for (let k = 0; k <= 79; k++) {
        const s2 = stateAt(ep, lerp(ep.tWalk, u, k / 79));
        trail.push(V(s2.x, 0.012, s2.z));
      }
    }
    setLine(pastLine, trail);

    // stochastic samples + mean prediction over the horizon
    const fut = stateAt(ep, u + HORIZON);
    const span = fut.s - st.s;
    const unc = clamp((ep.L - st.s) / 4.5, 0.12, 1);
    const show = phase === 2 && span > 0.2;
    samples.forEach((l, k) => {
      l.visible = show;
      if (!show) return;
      const amp = 0.55 * unc * Math.sin(t * (0.6 + 0.13 * k) + k * 2.1);
      const pts = [];
      for (let j = 0; j < SP; j++) {
        const f = j / (SP - 1);
        const d = clamp((st.s + span * f) / ep.L, 0, 1);
        ep.curve.getPointAt(d, pt);
        ep.curve.getTangentAt(Math.min(d, 0.999), tan);
        const off = amp * (Math.sin(Math.PI * f) * 0.7 + f * 0.5);
        pts.push(V(pt.x - tan.z * off, 0.015, pt.z + tan.x * off));
      }
      setLine(l, pts);
    });
    meanLine.visible = show;
    if (show) {
      const pts = [];
      for (let j = 0; j < SP; j++) {
        ep.curve.getPointAt(clamp((st.s + span * (j / (SP - 1))) / ep.L, 0, 1), pt);
        pts.push(V(pt.x, 0.02, pt.z));
      }
      setLine(meanLine, pts);
    }
    M.accentLine.opacity = 0.18 + 0.25 * unc;

    // goal marker
    const gIn = smooth(clamp((u - T_SCENE) / 0.6, 0, 1));
    const pulse = ((t * 0.8) % 1);
    goalRing.position.set(ep.stand.x, 0.008, ep.stand.z);
    goalRing.scale.setScalar(0.001 + gIn);
    pulseRing.position.copy(goalRing.position);
    pulseRing.scale.setScalar((1 + pulse * 1.6) * gIn + 0.001);
    M.pulse.opacity = 0.5 * (1 - pulse) * gIn;
    halo.position.copy(ep.target);
    halo.scale.setScalar((1 + 0.15 * Math.sin(t * 4)) * gIn + 0.001);
    M.halo.opacity = 0.25 * gIn;
    stem.visible = gIn > 0.01;
    setLine(stem, [V(ep.stand.x, 0.01, ep.stand.z), V(ep.target.x, ep.target.y - 0.05, ep.target.z)]);
    M.target.emissiveIntensity = 0.15 + 0.35 * gIn * (0.6 + 0.4 * Math.sin(t * 4));

    // goal-conditioning link from the head to the target during the goal phase
    body.J.head.getWorldPosition(head);
    const headLocal = world.worldToLocal(head.clone());
    const linkA = phase === 1 ? smooth(clamp((u - T_SCENE - 0.3) / 0.5, 0, 1)) : phase === 2 ? 1 - clamp((u - ep.tWalk) / 0.6, 0, 1) : 0;
    M.link.opacity = 0.9 * linkA;
    linkLine.visible = linkA > 0.01;
    setLine(linkLine, [V(headLocal.x, headLocal.y + 0.1, headLocal.z), ep.target]);

    // egocentric camera on the head, pitched down like head-worn glasses
    body.J.head.localToWorld(fwd.set(0, 0, 1)).sub(head).normalize();
    ego.position.copy(head).addScaledVector(fwd, 0.13).add(V(0, 0.1, 0));
    ego.lookAt(ego.position.x + fwd.x, ego.position.y - 0.62, ego.position.z + fwd.z);

    // draw: main view, then the egocentric inset
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, W, H);
    renderer.render(scene, cam);
    if (inset.w > 0) {
      renderer.setScissorTest(true);
      renderer.setViewport(inset.x, H - inset.y - inset.h, inset.w, inset.h);
      renderer.setScissor(inset.x, H - inset.y - inset.h, inset.w, inset.h);
      ego.aspect = inset.w / inset.h;
      ego.updateProjectionMatrix();
      renderer.render(scene, ego);
      renderer.setScissorTest(false);
    }

    // overlay text
    if (phase !== lastPhase) {
      steps.forEach((li, i) => li.classList.toggle('on', i === phase));
      caption.textContent = [
        'Observe the scene from a head-mounted camera',
        `Condition on an interaction goal: ${ep.goal}`,
        'Predict full-body motion autoregressively',
      ][phase];
      lastPhase = phase;
    }
    world.localToWorld(proj.copy(ep.target).add(V(0, 0.55, 0))).project(cam);
    goalTag.textContent = `goal · ${ep.goal}`;
    const half = goalTag.offsetWidth / 2 + 8;
    goalTag.style.left = `${clamp(((proj.x + 1) / 2) * W, half, W - half)}px`;
    goalTag.style.top = `${((1 - proj.y) / 2) * 100}%`;
    goalTag.style.opacity = gIn;
    const fade = Math.min(1, u / 0.35, (ep.T - u) / T_FADE);
    canvas.style.opacity = ui.style.opacity = clamp(fade, 0, 1);
  }

  function resize() {
    W = Math.max(1, fig.clientWidth);
    H = Math.round(W * (W < 640 ? 0.66 : 0.46));
    renderer.setSize(W, H, false);
    canvas.style.width = '100%';
    canvas.style.height = H + 'px';
    cam.aspect = W / H;
    cam.fov = W / H < 1.8 ? 34 : 30;
    cam.updateProjectionMatrix();
    const iw = W < 480 ? 0 : Math.round(clamp(W * 0.27, 150, 270));
    inset = { x: 12, y: 12, w: iw, h: Math.round(iw * 0.62) };
    Object.assign(egoFrame.style, { width: iw + 'px', height: inset.h + 'px', display: iw ? '' : 'none' });
    draw();
  }

  // ── Loop, visibility, pause ────────────────────────────
  const st = { t: 11.3, last: null, running: false, visible: false, paused: false };
  const draw = () => render(st.t);
  function frame(now) {
    if (!st.running) return;
    if (st.last !== null) st.t += Math.min((now - st.last) / 1000, 0.05);
    st.last = now;
    draw();
    requestAnimationFrame(frame);
  }
  function update() {
    const go = st.visible && !st.paused && !reduceMQ.matches;
    if (go && !st.running) { st.running = true; st.last = null; requestAnimationFrame(frame); }
    if (!go) st.running = false;
  }

  applyTheme();
  fig.insertBefore(canvas, fallback);
  fig.insertBefore(ui, fallback);
  fallback.style.display = 'none';
  fig.classList.add('is-3d');
  resize();
  new ResizeObserver(resize).observe(fig);
  new IntersectionObserver(([e]) => { st.visible = e.isIntersecting; update(); }, { rootMargin: '80px' }).observe(canvas);
  darkMQ.addEventListener('change', () => { applyTheme(); draw(); });
  reduceMQ.addEventListener('change', update);

  const oldBtn = fig.querySelector('.viz-toggle');
  if (oldBtn) {
    const btn = oldBtn.cloneNode(true);
    oldBtn.replaceWith(btn);
    btn.addEventListener('click', () => {
      st.paused = !st.paused;
      btn.setAttribute('aria-pressed', st.paused);
      btn.setAttribute('aria-label', st.paused ? 'Play animation' : 'Pause animation');
      btn.innerHTML = `<i class="bi bi-${st.paused ? 'play' : 'pause'}-fill" aria-hidden="true"></i>`;
      update();
    });
  }
};
