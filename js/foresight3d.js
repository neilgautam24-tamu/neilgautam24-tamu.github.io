/*
 * 3D illustration of goal-conditioned egocentric motion prediction.
 * Loaded lazily by viz.js, which passes in three.js from the CDN; if WebGL or the
 * CDN is unavailable, the 2D canvas version stays in place.
 *
 * Story per episode: 1) Scene: observe the room  2) Goal: an interaction target is set
 * 3) Motion: the agent walks around furniture and reaches for it, with predicted future
 * poses, stochastic trajectory samples and a live head-mounted (egocentric) camera inset.
 * Episodes alternate between an SMPL-X-style human and a Unitree G1-style humanoid that
 * replays retargeted motion; both share one skeleton and one pose function.
 */
window.mountForesight3D = function (fig, THREE, fallback, addons) {
  'use strict';
  addons = addons || {};

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
  const T_ACC = 1.0, HORIZON = 2.4;
  const HISTORY = [0.35, 0.7, 1.05, 1.4]; // seconds into the past for the fading history poses

  // Agents share the skeleton; gait differs (the robot walks crouched, with shorter, slower strides).
  const AGENTS = {
    human: { label: 'SMPL-X human', cam: 'head-mounted camera', scale: 1, stride: 1.35, vmax: 1.15,
      hipBias: 0, kneeBias: 0.06, hipAmp: 0.44, kneeAmp: 1.0, swing: 0.34, elbow: 0.22, abd: 0.07, lean: 0.05, twist: 1,
      lift: 0.075, reachFrac: 0.975,
      caption: 'Predict full-body SMPL-X motion autoregressively', observe: 'Observe the scene from a head-mounted camera' },
    g1: { label: 'Unitree G1 humanoid', cam: 'G1 head camera', scale: 0.8, stride: 0.9, vmax: 0.75,
      hipBias: -0.26, kneeBias: 0.5, hipAmp: 0.34, kneeAmp: 0.7, swing: 0.2, elbow: 0.55, abd: 0.17, lean: 0.07, twist: 0.4,
      lift: 0.055, reachFrac: 0.9,
      caption: 'Retarget the predicted motion to a Unitree G1 (ProtoMotions3)', observe: "Observe the scene from the robot's head camera" },
  };

  // ── Renderer & cameras ─────────────────────────────────
  const shared = window.vizShared(THREE), renderer = shared.renderer; // one WebGL context for all scenes
  const canvas = document.createElement('canvas');
  const ctx2d = canvas.getContext('2d', { alpha: false });
  canvas.className = 'f3d-canvas';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'Animated 3D illustration: in a furnished room, a goal object is highlighted, then an agent walks around the furniture and reaches for it, alternating between a human body model and a Unitree G1 humanoid robot. Fading grey poses show the observed history, blue shows the predicted path and sampled trajectories, and an inset shows the view from the head camera.');

  const scene = new THREE.Scene();
  // Everything lives in a mirrored group so the open side of the room faces the
  // top-left corner, where the egocentric inset sits.
  const world = new THREE.Group();
  world.scale.x = -1;
  scene.add(world);
  if (addons.RoomEnvironment) { // soft reflections for skin sheen and robot metal
    scene.environment = shared.env(addons.RoomEnvironment);
    scene.environmentIntensity = 0.35;
  }
  const cam = new THREE.PerspectiveCamera(30, 2, 0.1, 60);
  cam.layers.enable(1); // layer 1 = annotations, hidden from the egocentric camera
  const ego = new THREE.PerspectiveCamera(100, 1.6, 0.02, 30);

  // ── Materials (colors set by applyTheme) ───────────────
  const std = (o = {}) => new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0, ...o });
  const M = {
    floor: std({ roughness: 0.95 }), rug: std({ roughness: 1 }), wall: std({ roughness: 0.95 }),
    furn: std(), wood: std({ roughness: 0.7 }), soft: std({ roughness: 1 }), plant: std(), pot: std(),
    target: std({ roughness: 0.45, emissiveIntensity: 0.35 }),
    skin: new THREE.MeshPhysicalMaterial({ roughness: 0.55, sheen: 0.7, sheenRoughness: 0.55, sheenColor: 0xffd9c8, clearcoat: 0.08 }),
    glass: std({ color: 0x15171a, roughness: 0.3, metalness: 0.5 }),
    shell: new THREE.MeshPhysicalMaterial({ roughness: 0.3, metalness: 0.55, clearcoat: 0.6, clearcoatRoughness: 0.2 }),
    joint: std({ roughness: 0.42, metalness: 0.55 }),
    visor: new THREE.MeshPhysicalMaterial({ color: 0x07090c, roughness: 0.06, metalness: 0.3, clearcoat: 1, clearcoatRoughness: 0.05 }),
    led: new THREE.MeshBasicMaterial(),
    past: std({ transparent: true, opacity: 0.22 }),
    ghosts: HISTORY.map((_, i) => std({ transparent: true, opacity: [0.46, 0.32, 0.2, 0.11][i] })),
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
      ? { floor: '#34373e', rug: '#40444c', wall: '#2e3137', furn: '#50565f', wood: '#6b5c4b', soft: '#3d4a5c', plant: '#4f7d5b', pot: '#6d5446', skin: '#d2b4a2', shell: '#c9ced6', joint: '#17191d', past: '#8d949e', target: '#e0874f', grid: '#ffffff' }
      : { floor: '#e8e3da', rug: '#d9d2c4', wall: '#f5f2eb', furn: '#dcd6ca', wood: '#b89f80', soft: '#9fb0c4', plant: '#77a283', pot: '#b98f73', skin: '#d9bba9', shell: '#dde1e6', joint: '#1e2126', past: '#8a9099', target: '#d9733f', grid: '#3b3f47' };
    scene.background = bg;
    scene.fog = new THREE.Fog(bg, 13, 24);
    ['floor', 'rug', 'wall', 'furn', 'wood', 'soft', 'plant', 'pot', 'skin', 'shell', 'joint', 'past'].forEach(k => M[k].color.set(P[k]));
    M.led.color.copy(accent);
    M.target.color.set(P.target);
    M.target.emissive.set(P.target);
    M.grid.color.set(P.grid);
    M.ghosts.forEach(m => m.color.set(P.past)); // history fades out in neutral grey
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
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8174, addons.RoomEnvironment ? 1.25 : 1.55));
  const sun = new THREE.DirectionalLight(0xfff4e6, 2.3);
  sun.position.set(-3.5, 7, 3);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -5, right: 5, top: 5, bottom: -5, near: 1, far: 20 });
  sun.shadow.bias = -0.0004;
  sun.shadow.radius = 4;
  scene.add(sun);

  // ── Bodies ─────────────────────────────────────────────
  // Shared skeleton (metres, human scale; the robot is the same rig scaled to 0.8):
  // pelvis → chest → neck → head, shoulders → elbows (hand rides on the forearm), hips → knees → ankles.
  // Each joint's parts are merged into one mesh per material, so a body is ~15 draw calls.
  const Tm = (x, y, z) => new THREE.Matrix4().makeTranslation(x, y, z);
  const Rm = (x, y, z) => new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(x, y, z));
  const Sm = (x, y, z) => new THREE.Matrix4().makeScale(x, y, z);
  const TRS = (x, y, z, sx, sy, sz) => Tm(x, y, z).multiply(Sm(sx, sy, sz));
  const SPH = new THREE.SphereGeometry(1, 22, 16);
  const capG = (r, len) => new THREE.CapsuleGeometry(r, len, 5, 14);
  const cylX = (r, len) => new THREE.CylinderGeometry(r, r, len, 22).rotateZ(Math.PI / 2);
  const cylY = (rt, rb, len) => new THREE.CylinderGeometry(rt, rb, len, 22);
  const lathe = pts => new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), 28); // pts bottom → top
  const rbox = (w, h, d, r) => addons.RoundedBoxGeometry ? new addons.RoundedBoxGeometry(w, h, d, 3, r) : new THREE.BoxGeometry(w, h, d);
  function merge(list) {
    const geos = list.map(([g, m]) => { const n = g.index ? g.toNonIndexed() : g.clone(); n.applyMatrix4(m); return n; });
    const count = geos.reduce((a, g) => a + g.attributes.position.count, 0);
    const pos = new Float32Array(count * 3), nor = new Float32Array(count * 3);
    let o = 0;
    geos.forEach(g => { pos.set(g.attributes.position.array, o); nor.set(g.attributes.normal.array, o); o += g.attributes.position.array.length; g.dispose(); });
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    out.computeBoundingSphere();
    return out;
  }
  // chain of capsule segments (fingers): each segment hangs along −y, then bends about z (curl) and x
  function digit(add, j, mat, start, segs, curl, bendX = 0) {
    let m = start;
    segs.forEach(([len, r]) => {
      add(j, mat, capG(r, len), m.clone().multiply(Tm(0, -len / 2, 0)));
      m = m.multiply(Tm(0, -len, 0)).multiply(Rm(bendX, 0, curl));
    });
  }

  // SMPL-X-style body: smooth anatomical surfaces, articulated five-finger hands, Aria-style glasses
  function humanSpec() {
    const P = {}, add = (j, mat, g, m) => (P[j] ||= []).push([mat, g, m]);
    add('pelvis', 'skin', SPH, TRS(0, -0.015, -0.005, 0.165, 0.12, 0.118));
    [1, -1].forEach(sx => add('pelvis', 'skin', SPH, TRS(0.068 * sx, -0.06, -0.045, 0.085, 0.09, 0.08)));
    add('chest', 'skin', lathe([[0, -0.03], [0.128, -0.01], [0.122, 0.1], [0.135, 0.2], [0.155, 0.3], [0.158, 0.36], [0.135, 0.42], [0.08, 0.46], [0, 0.475]]), Sm(1.13, 1, 0.7));
    [1, -1].forEach(sx => {
      add('chest', 'skin', SPH, TRS(0.062 * sx, 0.315, 0.058, 0.072, 0.055, 0.04));   // pectorals
      add('chest', 'skin', SPH, TRS(0.175 * sx, 0.385, 0, 0.062, 0.058, 0.06));       // deltoids
      add('chest', 'skin', SPH, TRS(0.075 * sx, 0.3, -0.06, 0.07, 0.09, 0.04));       // scapulae
    });
    add('neck', 'skin', lathe([[0, -0.02], [0.05, -0.01], [0.046, 0.05], [0.05, 0.1], [0, 0.11]]), Sm(1, 1, 1));
    add('head', 'skin', SPH, TRS(0, 0.1, -0.005, 0.088, 0.108, 0.1));                // cranium
    add('head', 'skin', SPH, TRS(0, 0.045, 0.035, 0.066, 0.06, 0.066));              // jaw
    add('head', 'skin', SPH, TRS(0, 0.085, 0.1, 0.013, 0.022, 0.02));                // nose
    [1, -1].forEach(sx => add('head', 'skin', SPH, TRS(0.088 * sx, 0.085, -0.005, 0.012, 0.026, 0.018))); // ears
    add('head', 'glass', rbox(0.152, 0.026, 0.012, 0.005), Tm(0, 0.1, 0.1));
    [1, -1].forEach(sx => add('head', 'glass', rbox(0.006, 0.012, 0.11, 0.002), Tm(0.079 * sx, 0.102, 0.048)));
    [['L', 1], ['R', -1]].forEach(([s, sx]) => {
      add('sh' + s, 'skin', lathe([[0, -0.3], [0.038, -0.28], [0.043, -0.22], [0.052, -0.1], [0.054, -0.03], [0.05, 0.02], [0, 0.035]]), Sm(1, 1, 0.92));
      add('el' + s, 'skin', lathe([[0, -0.28], [0.025, -0.27], [0.027, -0.25], [0.036, -0.16], [0.043, -0.05], [0.039, 0.01], [0, 0.025]]), Sm(0.92, 1, 1));
      // hand: palm faces the body (−sx), fingers curl toward it
      add('el' + s, 'skin', SPH, TRS(0, -0.318, 0.004, 0.017, 0.046, 0.041));
      [[0.026, 0.88], [0.009, 1], [-0.009, 0.96], [-0.025, 0.78]].forEach(([z, k]) =>
        digit(add, 'el' + s, 'skin', Tm(0, -0.358, z).multiply(Rm(0, 0, -sx * 0.14)), [[0.028 * k, 0.0085], [0.019 * k, 0.0078], [0.016 * k, 0.0072]], -sx * 0.24));
      digit(add, 'el' + s, 'skin', Tm(-sx * 0.01, -0.3, 0.036).multiply(Rm(-0.55, 0, -sx * 0.35)), [[0.026, 0.0098], [0.024, 0.009]], -sx * 0.2, -0.15);
      add('hip' + s, 'skin', lathe([[0, -0.44], [0.05, -0.42], [0.055, -0.38], [0.068, -0.28], [0.083, -0.12], [0.088, -0.03], [0.075, 0.03], [0, 0.045]]), Sm(1, 1, 1.05));
      add('kn' + s, 'skin', lathe([[0, -0.42], [0.031, -0.4], [0.034, -0.34], [0.046, -0.22], [0.056, -0.12], [0.052, -0.04], [0.05, 0.02], [0, 0.035]]), Tm(0, 0, -0.006));
      add('kn' + s, 'skin', SPH, TRS(0, -0.005, 0.03, 0.036, 0.042, 0.026));          // kneecap
      add('an' + s, 'skin', SPH, TRS(0, 0, 0, 0.032, 0.032, 0.032));
      add('an' + s, 'skin', SPH, TRS(0, -0.045, 0.06, 0.043, 0.03, 0.115));           // foot
      add('an' + s, 'skin', SPH, TRS(0, -0.04, -0.022, 0.036, 0.034, 0.042));         // heel
    });
    return P;
  }

  // Unitree G1-style humanoid: silver shells, black actuators at every joint, visor head, Dex3-style hands
  function g1Spec() {
    const P = {}, add = (j, mat, g, m) => (P[j] ||= []).push([mat, g, m]);
    add('pelvis', 'shell', rbox(0.25, 0.11, 0.16, 0.035), Tm(0, -0.02, 0));
    add('pelvis', 'joint', cylY(0.06, 0.06, 0.05), Tm(0, 0.05, 0));                   // waist yaw
    [1, -1].forEach(sx => add('pelvis', 'joint', cylX(0.048, 0.07), Tm(0.1 * sx, -0.045, 0)));
    add('chest', 'shell', rbox(0.21, 0.13, 0.15, 0.04), Tm(0, 0.1, 0));
    add('chest', 'shell', rbox(0.28, 0.27, 0.17, 0.06), Tm(0, 0.29, 0));
    add('chest', 'joint', rbox(0.17, 0.11, 0.012, 0.004), Tm(0, 0.29, 0.087));       // chest panel
    add('chest', 'led', rbox(0.1, 0.006, 0.004, 0.002), Tm(0, 0.245, 0.094));
    add('chest', 'shell', rbox(0.2, 0.2, 0.06, 0.025), Tm(0, 0.29, -0.1));           // battery pack
    [1, -1].forEach(sx => add('chest', 'joint', cylX(0.046, 0.06), Tm(0.165 * sx, 0.39, 0)));
    add('chest', 'joint', cylY(0.034, 0.04, 0.07), Tm(0, 0.45, 0));
    add('head', 'shell', SPH, TRS(0, 0.07, -0.01, 0.088, 0.095, 0.095));
    add('head', 'visor', SPH, TRS(0, 0.068, 0.034, 0.079, 0.062, 0.066));
    add('head', 'joint', cylY(0.013, 0.013, 0.012).rotateX(Math.PI / 2), Tm(0, 0.118, 0.082)); // depth camera
    add('head', 'led', rbox(0.05, 0.005, 0.004, 0.002), Tm(0, 0.03, 0.097));
    [['L', 1], ['R', -1]].forEach(([s, sx]) => {
      add('sh' + s, 'joint', cylX(0.04, 0.05), Tm(0.01 * sx, 0, 0));
      add('sh' + s, 'shell', capG(0.04, 0.17), Tm(0, -0.14, 0));
      add('el' + s, 'joint', cylX(0.036, 0.07), Tm(0, 0, 0));
      add('el' + s, 'shell', capG(0.033, 0.15), Tm(0, -0.13, 0));
      add('el' + s, 'joint', cylY(0.027, 0.027, 0.03), Tm(0, -0.245, 0));
      add('el' + s, 'joint', rbox(0.03, 0.065, 0.058, 0.012), Tm(0, -0.295, 0));    // palm
      [0.016, -0.016].forEach(z => digit(add, 'el' + s, 'joint', Tm(0, -0.33, z).multiply(Rm(0, 0, -sx * 0.2)), [[0.034, 0.0115], [0.028, 0.0105]], -sx * 0.35));
      digit(add, 'el' + s, 'joint', Tm(-sx * 0.008, -0.29, 0.034).multiply(Rm(-0.6, 0, -sx * 0.3)), [[0.03, 0.011], [0.025, 0.01]], -sx * 0.25);
      add('hip' + s, 'joint', cylX(0.055, 0.085), Tm(0, 0, 0));
      add('hip' + s, 'shell', rbox(0.1, 0.3, 0.11, 0.04), Tm(0, -0.2, 0.005));
      add('hip' + s, 'joint', rbox(0.05, 0.14, 0.012, 0.004), Tm(0, -0.2, 0.062));
      add('kn' + s, 'joint', cylX(0.05, 0.095), Tm(0, 0, 0));
      add('kn' + s, 'shell', rbox(0.075, 0.3, 0.085, 0.03), Tm(0, -0.2, 0.01));
      add('kn' + s, 'joint', capG(0.03, 0.12), Tm(0, -0.13, -0.045));                // calf actuator
      add('an' + s, 'joint', cylX(0.03, 0.065), Tm(0, 0, 0));
      add('an' + s, 'shell', rbox(0.09, 0.035, 0.22, 0.012), Tm(0, -0.048, 0.04));
      add('an' + s, 'joint', rbox(0.094, 0.012, 0.224, 0.004), Tm(0, -0.068, 0.04)); // sole
    });
    return P;
  }

  const MERGED = {};
  [['human', humanSpec()], ['g1', g1Spec()]].forEach(([k, spec]) => {
    MERGED[k] = Object.entries(spec).map(([j, parts]) => {
      const byMat = {};
      parts.forEach(([mat, g, m]) => (byMat[mat] ||= []).push([g, m]));
      return [j, Object.entries(byMat).map(([mat, list]) => [mat, merge(list)])];
    });
  });

  const depthOnly = new THREE.MeshBasicMaterial({ colorWrite: false, transparent: true });
  function makeBody(style, override, cast) {
    const J = {}, root = new THREE.Group();
    const joint = (parent, name, x, y, z) => { const j = new THREE.Group(); j.position.set(x, y, z); parent.add(j); J[name] = j; return j; };
    const pelvis = joint(root, 'pelvis', 0, 0.93, 0);
    const chest = joint(pelvis, 'chest', 0, 0.08, 0);
    joint(joint(chest, 'neck', 0, 0.47, 0), 'head', 0, 0.09, 0);
    [['L', 1], ['R', -1]].forEach(([s, sx]) => {
      joint(joint(chest, 'sh' + s, 0.19 * sx, 0.39, 0), 'el' + s, 0, -0.29, 0);
      joint(joint(joint(pelvis, 'hip' + s, 0.095 * sx, -0.04, 0), 'kn' + s, 0, -0.42, 0), 'an' + s, 0, -0.42, 0);
    });
    MERGED[style].forEach(([name, list]) => list.forEach(([mat, geo]) => {
      const m = new THREE.Mesh(geo, override || M[mat]);
      m.castShadow = cast;
      m.receiveShadow = !override;
      J[name].add(m);
      if (override) { // translucent ghost: depth pre-pass so only its front surface is tinted
        const d = new THREE.Mesh(geo, depthOnly);
        d.renderOrder = 1;
        m.renderOrder = 2;
        J[name].add(d);
      }
    }));
    root.scale.setScalar(AGENTS[style].scale);
    world.add(root);
    return { root, J, A: AGENTS[style] };
  }

  const tmpV = new THREE.Vector3();
  // Pose from gait phase, gait amplitude, reach blend. Local +z is forward, right side is −x.
  function pose(B, st) {
    if (B.kind === 'smplx') return poseSMPLX(B, st);
    if (B.kind === 'g1') return poseG1(B, st);
    const { J, A } = B;
    const a = st.a, w = st.reach;
    const legs = { L: st.phi, R: st.phi + Math.PI };
    for (const s of ['L', 'R']) {
      const p = legs[s];
      const hip = -A.hipAmp * Math.cos(p) * a;
      const knee = (0.12 * Math.max(0, Math.sin(p)) + A.kneeAmp * Math.pow(Math.max(0, -Math.sin(p)), 1.4)) * a;
      J['hip' + s].rotation.set(A.hipBias + hip, 0, 0);
      J['kn' + s].rotation.set(A.kneeBias + knee, 0, 0);
      J['an' + s].rotation.set(-(A.hipBias + A.kneeBias) - (hip + knee) * 0.85, 0, 0); // flat stance foot
      const opp = s === 'L' ? legs.R : legs.L;
      J['sh' + s].rotation.set(-A.swing * Math.cos(opp) * a + 0.04, 0, (s === 'L' ? 1 : -1) * A.abd);
      J['el' + s].rotation.set(-(A.elbow + 0.2 * a), 0, 0);
    }
    // right arm reaches toward the goal object
    J.shR.rotation.x = lerp(J.shR.rotation.x, -st.reachPitch, w);
    J.shR.rotation.z = lerp(J.shR.rotation.z, -0.02, w);
    J.elR.rotation.x = lerp(J.elR.rotation.x, -0.18, w);
    J.pelvis.rotation.set(0, 0.09 * Math.cos(st.phi) * a * A.twist, 0);
    J.chest.rotation.set(A.lean * (1 + a) + 0.1 * w, -0.14 * Math.cos(st.phi) * a * A.twist, 0);
    J.neck.rotation.set(0.1 + 0.08 * w - 0.05 * a - A.lean, 0, 0);
    J.head.rotation.set(0.06, 0.12 * Math.cos(st.phi) * a * 0.3 * A.twist, 0);

    B.root.position.set(st.x, 0, st.z);
    B.root.rotation.set(0, st.yaw, 0);
    // keep the lower foot on the floor (ankle 7.5 cm up, in body scale)
    J.pelvis.position.y = 0.93;
    B.root.updateMatrixWorld(true);
    const yl = J.anL.getWorldPosition(tmpV).y, yr = J.anR.getWorldPosition(tmpV).y;
    J.pelvis.position.y += (0.075 * A.scale - Math.min(yl, yr)) / A.scale;
  }

  const BODIES = {};
  ['human', 'g1'].forEach(k => {
    BODIES[k] = { main: makeBody(k, null, true), past: makeBody(k, M.past, false), ghosts: M.ghosts.map(m => makeBody(k, m, false)) };
    [BODIES[k].past, ...BODIES[k].ghosts].forEach(g => g.root.traverse(o => o.layers.set(1)));
  });


  // ── Real body models (loaded lazily; the procedural bodies above stay if loading fails) ──
  // Human: Anny body model (NAVER LABS Europe, Apache-2.0; MakeHuman/MPFB2 data CC0) re-rigged onto the
  //        exact SMPL-X kinematic tree (55 joints, SMPL-X order) and driven by SMPL-X-format pose parameters.
  // Robot: Unitree G1 29-DoF (MuJoCo Menagerie; © Unitree Robotics, BSD-3-Clause) driven by its joint vector q.
  async function loadBin(url) {
    const buf = await (await fetch(url)).arrayBuffer();
    const n = new DataView(buf).getUint32(0, true);
    const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, n)));
    return { meta, buf, base: 4 + n + (-n & 3) };
  }
  const ceil4 = n => n + (-n & 3);
  const qTmp = new THREE.Quaternion(), qTmp2 = new THREE.Quaternion(), vTmp = new THREE.Vector3(), vTmp2 = new THREE.Vector3();
  const qAxis = (x, y, z, a) => new THREE.Quaternion().setFromAxisAngle(V(x, y, z), a);

  function buildHuman({ meta, buf, base }) {
    const { nv, nf, nj, scale } = meta;
    let o = base;
    const J = new Float32Array(buf.slice(o, o + nj * 12)); o += nj * 12;
    const pq = new Int16Array(buf, o, nv * 3); o += ceil4(nv * 6);
    const idx = new Uint16Array(buf.slice(o, o + nf * 6)); o += ceil4(nf * 6);
    const si = new Uint8Array(buf.slice(o, o + nv * 4)); o += nv * 4;
    const sw = new Uint8Array(buf.slice(o, o + nv * 4));
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(pq, v => v * scale), 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
    geo.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4, true));
    geo.computeVertexNormals();
    const jp = i => V(J[i * 3], J[i * 3 + 1], J[i * 3 + 2]);
    const idOf = Object.fromEntries(meta.joints.map((n, i) => [n, i]));
    let minY = Infinity;
    for (let i = 1; i < nv * 3; i += 3) minY = Math.min(minY, pq[i] * scale);
    return {
      geo, meta, jp, idOf,
      ankleH: jp(idOf.left_ankle).y - minY,                      // ankle joint height above the sole at rest
      dU: [16, 17].map(i => jp(i + 2).sub(jp(i)).normalize()),   // rest upper-arm directions (A-pose)
      dF: [18, 19].map(i => jp(i + 2).sub(jp(i)).normalize()),   // rest forearm directions
      eye: jp(idOf.left_eye_smplhf).add(jp(idOf.right_eye_smplhf)).multiplyScalar(0.5),
    };
  }
  function makeHumanBody(H, override, cast) {
    const { meta, jp } = H;
    const bones = meta.joints.map(n => Object.assign(new THREE.Bone(), { name: n }));
    meta.parents.forEach((p, i) => {
      bones[i].position.copy(p < 0 ? jp(i) : jp(i).sub(jp(p)));
      if (p >= 0) bones[p].add(bones[i]);
    });
    const root = new THREE.Group();
    const mesh = new THREE.SkinnedMesh(H.geo, override || M.skin);
    mesh.add(bones[0]);
    root.add(mesh);
    root.updateMatrixWorld(true);
    const skeleton = new THREE.Skeleton(bones);
    mesh.bind(skeleton);
    mesh.frustumCulled = false;
    mesh.castShadow = cast;
    mesh.receiveShadow = !override;
    if (override) { // translucent ghost: skinned depth pre-pass
      const d = new THREE.SkinnedMesh(H.geo, depthOnly);
      d.bind(skeleton, mesh.bindMatrix);
      d.frustumCulled = false;
      d.renderOrder = 1; mesh.renderOrder = 2;
      root.add(d);
    }
    const eye = new THREE.Object3D(); // head-camera marker: +z looks forward
    eye.position.copy(H.eye).sub(jp(H.idOf.head)).add(V(0, 0.01, 0.05));
    bones[H.idOf.head].add(eye);
    world.add(root);
    return { kind: 'smplx', H, root, bones, J: { head: eye }, eye, A: AGENTS.human, local: Array.from({ length: 55 }, () => new THREE.Quaternion()) };
  }
  // ── Planted-footstep gait with two-bone leg IK (shared by the human and the G1) ──
  // Each foot stays fixed at its footstep during stance (no skating) and travels on a smooth
  // arc during swing; hip and knee angles come from the leg geometry, and the pelvis rises
  // and falls over the stance leg via a soft minimum of what both legs can reach.
  const smoother = x => x * x * x * (x * (x * 6 - 15) + 10);
  function legRig(hip, knee, ankle, soleY) { // rest positions in the body frame (y up, z forward)
    return { hipY: hip.y, hipZ: hip.z, ankleZ: ankle.z, ankleH: ankle.y - soleY,
      L1: Math.hypot(knee.y - hip.y, knee.z - hip.z), L2: Math.hypot(ankle.y - knee.y, ankle.z - knee.z),
      r1: Math.atan2(knee.z - hip.z, hip.y - knee.y), r2: Math.atan2(ankle.z - knee.z, knee.y - ankle.y) };
  }
  function legIK(R, A, st) {
    const a = smooth(clamp(st.a * 1.4, 0, 1)), S = A.stride, beta = 0.6, k = 0.025;
    const reach = 0.995 * (R.L1 + R.L2), Lm = A.reachFrac * (R.L1 + R.L2), FOOT = 0.14 * A.scale;
    const legs = [0, 0.5].map(o => { // left, right (half a cycle apart)
      const x = st.s / S + o, n = Math.floor(x), u = x - n;
      let fs = S * (n + beta / 2 - o), f = 0;
      if (u >= beta) { f = smoother((u - beta) / (1 - beta)); fs += S * f; }
      const dzN = (fs - st.s) * a;                                   // foot ahead (+) / behind (−) the pelvis
      // lift peaks early in swing (just after toe-off), as in human gait, so the foot never dips mid-swing
      return { dzN, dz: dzN + R.ankleZ - R.hipZ, y: R.ankleH + A.lift * Math.sin(Math.PI * Math.pow(f, 0.7)) * a, f };
    });
    // pelvis: a gentle bob between standing height and what both legs can reach (soft minimum)
    const top = legs.map(l => l.y + Math.sqrt(Math.max(0, Lm * Lm - l.dz * l.dz)));
    const low = -k * Math.log(Math.exp(-top[0] / k) + Math.exp(-top[1] / k)), stand = R.ankleH + Lm;
    const hipY = stand - 0.38 * (stand - low);
    return { rootY: hipY - R.hipY, legs: legs.map(l => {
      // if the hip rides too high for the foot, the heel lifts and the foot rolls onto its toes (toe-off),
      // or onto its heel at heel strike: derived from geometry, so it is continuous through the gait
      const need = hipY - Math.sqrt(Math.max(0, reach * reach - l.dz * l.dz));
      const raise = Math.max(0, need - l.y), y = l.y + raise;
      const pitch = (l.dzN < 0 ? 1 : -0.6) * Math.asin(clamp(raise / FOOT, 0, 1)) + 0.25 * Math.sin(Math.PI * l.f) * a;
      const dy = hipY - y, D = clamp(Math.hypot(l.dz, dy), 0.05, R.L1 + R.L2 - 1e-4);
      const phi1 = Math.atan2(l.dz, dy) + Math.acos(clamp((R.L1 * R.L1 + D * D - R.L2 * R.L2) / (2 * R.L1 * D), -1, 1));
      const bend = Math.PI - Math.acos(clamp((R.L1 * R.L1 + R.L2 * R.L2 - D * D) / (2 * R.L1 * R.L2), -1, 1));
      const qh = R.r1 - phi1, qk = R.r2 - (phi1 - bend) - qh;
      return { qh, qk, qa: -(qh + qk) + pitch };
    }) };
  }

  // SMPL-X pose from the gait state. Rest joint frames are world-aligned (as in SMPL-X), so each
  // joint's local rotation is exactly its body_pose entry; arms are aimed by world-space targets.
  const wq = Array.from({ length: 55 }, () => new THREE.Quaternion());
  function poseSMPLX(B, st) {
    const { H, bones, A, local } = B;
    const a = st.a, w = st.reach, id = H.idOf;
    local.forEach(q => q.identity());
    const legs = { left: st.phi, right: st.phi + Math.PI };
    if (!H.leg) H.leg = legRig(H.jp(id.left_hip), H.jp(id.left_knee), H.jp(id.left_ankle), H.jp(id.left_ankle).y - H.ankleH);
    const gaitIK = legIK(H.leg, A, st);
    ['left', 'right'].forEach((s, i) => {
      const l = gaitIK.legs[i];
      local[id[s + '_hip']].setFromAxisAngle(V(1, 0, 0), l.qh);
      local[id[s + '_knee']].setFromAxisAngle(V(1, 0, 0), l.qk);
      local[id[s + '_ankle']].setFromAxisAngle(V(1, 0, 0), l.qa);
    });
    local[0].setFromAxisAngle(V(0, 1, 0), 0.09 * Math.cos(st.phi) * a);
    const tw = -0.14 * Math.cos(st.phi) * a / 3, lean = (A.lean * (1 + a) + 0.1 * w) / 3;
    [id.spine1, id.spine2, id.spine3].forEach(j => local[j].copy(qAxis(0, 1, 0, tw)).multiply(qAxis(1, 0, 0, lean)));
    local[id.neck].setFromAxisAngle(V(1, 0, 0), 0.04 + 0.08 * w - 0.05 * a - A.lean);
    local[id.head].setFromAxisAngle(V(1, 0, 0), 0.04);
    // world rotations down to the collars, then aim each arm
    for (let i = 0; i < 55; i++) {
      const p = H.meta.parents[i];
      if (p < 0) wq[i].copy(local[i]); else wq[i].copy(wq[p]).multiply(local[i]);
      if (i === id.left_collar || i === id.right_collar) {
        const k = i === id.left_collar ? 0 : 1, sx = k ? -1 : 1, s = k ? 'right' : 'left';
        const opp = k ? legs.left : legs.right;
        let swing = A.swing * Math.cos(opp) * a + 0.06, flex = A.elbow + 0.25 * a, abd = 0.12;
        if (k === 1) { swing = lerp(swing, st.reachPitch, w); flex = lerp(flex, 0.12, w); abd = lerp(abd, 0.02, w); }
        const up = V(sx * Math.sin(abd), -Math.cos(swing), Math.sin(swing)).normalize();
        const fore = V(sx * Math.sin(abd) * 0.6, -Math.cos(swing + flex), Math.sin(swing + flex)).normalize();
        // shoulder: rest upper-arm direction → target (expressed in the collar's frame)
        const inv = qTmp.copy(wq[i]).invert();
        const sh = new THREE.Quaternion().setFromUnitVectors(H.dU[k], up.applyQuaternion(qTmp2.copy(inv)));
        local[id[s + '_shoulder']].copy(sh);
        // elbow: minimal-twist correction of the carried-along forearm onto its target
        const cur = vTmp.copy(H.dF[k]).applyQuaternion(sh);
        const want = fore.applyQuaternion(qTmp2.copy(inv));
        const el = new THREE.Quaternion().setFromUnitVectors(cur, want).multiply(sh);
        local[id[s + '_elbow']].copy(sh.invert().multiply(el));
        // relaxed hand: gentle finger curl
        ['index', 'middle', 'ring', 'pinky'].forEach(f => [1, 2, 3].forEach(n => local[id[`${s}_${f}${n}`]].setFromAxisAngle(V(0, 0, 1), -sx * 0.18)));
      }
    }
    bones.forEach((b, i) => b.quaternion.copy(local[i]));
    B.root.position.set(st.x, gaitIK.rootY, st.z);
    B.root.rotation.set(0, st.yaw, 0);
  }

  function buildG1({ meta, buf, base }, toCreased) {
    const sc = meta.scale;
    let sole = 0;
    meta.bodies.forEach(b => b.meshes.forEach(m => {
      const pq = new Int16Array(buf, base + m.pos, m.nv * 3);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(pq, v => v * sc), 3));
      g.setIndex(new THREE.BufferAttribute(new Uint16Array(buf.slice(base + m.idx, base + m.idx + m.nf * 6)), 1));
      g.computeBoundingBox();
      if (b.name === 'left_ankle_roll_link') sole = Math.min(sole, g.boundingBox.min.z);
      if (m.name === 'head_link') m.headBox = g.boundingBox.clone();
      m.geo = toCreased ? toCreased(g, 0.6) : (g.computeVertexNormals(), g); // crisp machined edges
    }));
    return { meta, sole };
  }
  const MJ = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().set(0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 1)); // MuJoCo (x fwd, y left, z up) → body frame
  function makeG1Body(G, override, cast) {
    const root = new THREE.Group(), frame = new THREE.Group();
    frame.quaternion.copy(MJ);
    root.add(frame);
    const links = [], joints = [];
    let eye = null;
    const feet = [];
    G.meta.bodies.forEach((b, i) => {
      const o = new THREE.Group(), jg = new THREE.Group();
      o.position.fromArray(b.pos);
      o.quaternion.set(b.quat[1], b.quat[2], b.quat[3], b.quat[0]);
      o.add(jg);
      (b.parent < 0 ? frame : links[b.parent]).add(o);
      links.push(jg);
      if (b.joint) joints.push({ name: b.joint.name.replace('_joint', ''), jg, axis: V(...b.joint.axis), range: b.joint.range });
      b.meshes.forEach(m => {
        const mesh = new THREE.Mesh(m.geo, override || (m.rgba[0] < 0.5 ? M.joint : M.shell));
        mesh.castShadow = cast; mesh.receiveShadow = !override;
        jg.add(mesh);
        if (override) { const d = new THREE.Mesh(m.geo, depthOnly); d.renderOrder = 1; mesh.renderOrder = 2; jg.add(d); }
        if (m.headBox) { // head camera at the front of the head, looking forward (+x in MuJoCo)
          eye = new THREE.Object3D();
          eye.position.set(m.headBox.max.x, (m.headBox.min.y + m.headBox.max.y) / 2, m.headBox.min.z + 0.7 * (m.headBox.max.z - m.headBox.min.z));
          eye.quaternion.setFromAxisAngle(V(0, 1, 0), Math.PI / 2);
          jg.add(eye);
        }
      });
      if (/ankle_roll_link$/.test(b.name)) { const f = new THREE.Object3D(); f.position.z = G.sole; jg.add(f); feet.push(f); }
    });
    world.add(root);
    return { kind: 'g1', G, root, joints, feet, eye, J: { head: eye }, A: AGENTS.g1, q: new Float32Array(joints.length) };
  }
  const jIdx = {};
  function poseG1(B, st) {
    const { A, joints, q } = B;
    const a = st.a, w = st.reach;
    if (!jIdx.done) { joints.forEach((j, i) => { jIdx[j.name] = i; }); jIdx.done = true; }
    if (!B.G.leg) { // measure the leg geometry once, at the zero configuration
      joints.forEach(j => j.jg.quaternion.identity());
      B.root.position.set(0, 0, 0); B.root.rotation.set(0, 0, 0); B.root.updateMatrixWorld(true);
      const P = n => B.root.worldToLocal(joints[jIdx[n]].jg.getWorldPosition(new THREE.Vector3()));
      B.G.leg = legRig(P('left_hip_pitch'), P('left_knee'), P('left_ankle_pitch'), B.root.worldToLocal(B.feet[0].getWorldPosition(new THREE.Vector3())).y);
    }
    const gaitIK = legIK(B.G.leg, A, st);
    q.fill(0);
    const legs = { left: st.phi, right: st.phi + Math.PI };
    for (const s of ['left', 'right']) {
      const sy = s === 'left' ? 1 : -1, l = gaitIK.legs[s === 'left' ? 0 : 1];
      q[jIdx[s + '_hip_pitch']] = l.qh;
      q[jIdx[s + '_knee']] = l.qk;
      q[jIdx[s + '_ankle_pitch']] = l.qa;
      q[jIdx[s + '_hip_roll']] = sy * 0.02;
      const opp = s === 'left' ? legs.right : legs.left;
      let pitch = -A.swing * Math.cos(opp) * a, elbow = A.elbow + 0.15 * a, roll = sy * 0.18;
      if (s === 'right') { pitch = lerp(pitch, -st.reachPitch, w); elbow = lerp(elbow, 0.1, w); roll = lerp(roll, -0.05, w); }
      q[jIdx[s + '_shoulder_pitch']] = pitch;
      q[jIdx[s + '_shoulder_roll']] = roll;
      q[jIdx[s + '_elbow']] = elbow;
    }
    q[jIdx.waist_yaw] = -0.12 * Math.cos(st.phi) * a;
    q[jIdx.waist_pitch] = A.lean * (1 + a) * 0.6 + 0.08 * w;
    joints.forEach((j, i) => { q[i] = clamp(q[i], j.range[0], j.range[1]); j.jg.quaternion.setFromAxisAngle(j.axis, q[i]); });
    B.root.position.set(st.x, gaitIK.rootY, st.z);
    B.root.rotation.set(0, st.yaw, 0);
  }

  Promise.all([loadBin('models/human-smplx.bin'), loadBin('models/g1.bin')]).then(([h, g]) => {
    const H = buildHuman(h), G = buildG1(g, addons.toCreasedNormals);
    const swap = (k, make, R) => {
      const old = BODIES[k];
      [old.main, old.past, ...old.ghosts].forEach(b => world.remove(b.root));
      BODIES[k] = { main: make(R, null, true), past: make(R, M.past, false), ghosts: M.ghosts.map(m => make(R, m, false)) };
      [BODIES[k].past, ...BODIES[k].ghosts].forEach(b => b.root.traverse(o => o.layers.set(1)));
    };
    swap('human', makeHumanBody, H);
    swap('g1', makeG1Body, G);
    MERGED.human.concat(MERGED.g1).forEach(([, list]) => list.forEach(([, geo]) => geo.dispose()));
    AGENTS.human.loaded = AGENTS.g1.loaded = true;
    if (!st.running) draw();
  }).catch(err => console.warn('Body models unavailable; keeping procedural bodies.', err));

  // ── Episodes ───────────────────────────────────────────
  const EPISODES = [
    { agent: 'human', goal: 'pick up the cup', target: V(-1.6, 0.99, -2.12), reachPitch: 1.05,
      pts: [[2.3, 1.9], [1.3, 1.1], [-1.0, 0.9], [-1.3, -0.5], [-1.6, -1.55]] },
    { agent: 'g1', goal: 'take the box from the shelf', target: V(-3.3, 1.02, -0.45), reachPitch: 1.5,
      pts: [[2.6, 0.9], [1.4, 0.95], [0.1, 1.0], [-1.6, 0.65], [-2.84, -0.45]] },
  ].map(ep => {
    ep.A = AGENTS[ep.agent];
    ep.curve = new THREE.CatmullRomCurve3(ep.pts.map(([x, z]) => V(x, 0, z)), false, 'centripetal');
    ep.L = ep.curve.getLength();
    ep.dMove = ep.L / ep.A.vmax + T_ACC;
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
    // S-curve speed: v = vmax·smoothstep(t/T_ACC) on the ramps, so acceleration itself is continuous
    const VMAX = ep.A.vmax, ramp = x => VMAX * T_ACC * (x * x * x - x * x * x * x / 2);
    tau = clamp(tau, 0, ep.dMove);
    if (tau < T_ACC) { const x = tau / T_ACC; return [ramp(x), VMAX * smooth(x)]; }
    if (tau < ep.dMove - T_ACC) return [0.5 * VMAX * T_ACC + VMAX * (tau - T_ACC), VMAX];
    const x = (ep.dMove - tau) / T_ACC;
    return [ep.L - ramp(x), VMAX * smooth(x)];
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
    return { x: pt.x, z: pt.z, yaw, phi: (TAU * s) / ep.A.stride, a: v / ep.A.vmax, s, reach, reachPitch: ep.reachPitch };
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
    <div class="f3d-ego"><span class="f3d-rec"></span><span class="f3d-ego-label"></span></div>
    <div class="f3d-story">
      <ol class="f3d-steps"><li>Scene</li><li>Goal</li><li>Motion</li></ol>
      <p class="f3d-caption"></p>
      <p class="f3d-agent"></p>
    </div>
    <pre class="f3d-format" aria-hidden="true"></pre>
    <div class="f3d-goal"></div>
    <div class="f3d-legend"><span class="lg-obs">observed</span><span class="lg-pred">predicted</span><span class="lg-samp">samples</span></div>`;
  const $ = s => ui.querySelector(s);
  const steps = [...ui.querySelectorAll('.f3d-steps li')];
  const fmt = $('.f3d-format');
  const egoFrame = $('.f3d-ego'), caption = $('.f3d-caption'), goalTag = $('.f3d-goal'), agentTag = $('.f3d-agent'), egoLabel = $('.f3d-ego-label');

  // ── Frame ──────────────────────────────────────────────
  let W = 1, H = 1, inset = { x: 12, y: 12, w: 200, h: 124 };
  const head = new THREE.Vector3(), fwd = new THREE.Vector3(), proj = new THREE.Vector3();
  const LOOK = V(-0.05, 0.55, -0.35);
  let lastKey = '', fmtTick = 0;
  const f2 = x => (x >= 0 ? ' ' : '') + x.toFixed(2);
  const f3 = v => '[' + v.map(f2).join(' ') + ']';
  const aa = q => { const s = Math.sqrt(Math.max(0, 1 - q.w * q.w)), ang = 2 * Math.acos(clamp(q.w, -1, 1)); return s < 1e-6 ? [0, 0, 0] : [q.x / s * ang, q.y / s * ang, q.z / s * ang]; };
  const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n);
  function smplxText(B, t) {
    const id = B.H.idOf, L = B.local;
    const go = aa(qAxis(0, 1, 0, B.root.rotation.y).multiply(L[0]));
    const tr = B.bones[0].getWorldPosition(vTmp);
    const rows = ['left_hip', 'right_hip', 'left_knee', 'right_knee', 'left_shoulder', 'right_elbow'];
    return [`SMPL-X  frame ${String(Math.floor(t * 30)).padStart(4, '0')} @ 30 fps`,
      `transl         ${f3([tr.x, tr.y, tr.z])}`,
      `global_orient  ${f3(go)}`,
      `body_pose      (21×3 axis-angle)`,
      ...rows.map(r => ` ${String(id[r]).padStart(2)} ${pad(r, 14)}${f3(aa(L[id[r]]))}`),
      `    … 15 more · hand_pose 2×15×3`].join('\n');
  }
  function g1Text(B, t) {
    const rows = ['left_hip_pitch', 'left_knee', 'left_ankle_pitch', 'right_hip_pitch', 'right_knee', 'waist_yaw', 'right_shoulder_pitch', 'right_elbow'];
    return [`Unitree G1  q ∈ ℝ²⁹ (rad)  frame ${String(Math.floor(t * 50)).padStart(4, '0')} @ 50 Hz`,
      ...rows.map(r => ` ${String(jIdx[r]).padStart(2)} ${pad(r, 21)}${f2(B.q[jIdx[r]])}`),
      `    … 21 more joints`].join('\n');
  }

  function render(t) {
    const [ep, u] = locate(t);
    const st = stateAt(ep, u);
    const phase = u < T_SCENE ? 0 : u < ep.tWalk ? 1 : 2;

    // main camera: slow reveal orbit during the scene phase, then a gentle drift
    const orbit = u < T_SCENE ? lerp(-0.5, 0, ease(u / T_SCENE)) : 0;
    const th = -(0.6 + orbit + 0.03 * Math.sin(t * 0.2));
    const R = W / H < 1.8 ? 9.2 : 8.4;
    cam.position.set(LOOK.x + R * Math.sin(th), 4.9, LOOK.z + R * Math.cos(th));
    cam.lookAt(LOOK);

    const set = BODIES[ep.agent], other = BODIES[ep.agent === 'human' ? 'g1' : 'human'];
    [other.main, other.past, ...other.ghosts].forEach(b => { b.root.visible = false; });
    const body = set.main;
    body.root.visible = true;
    pose(body, st);
    // observed history: earlier poses trail behind and fade with age (the prediction is the path on the floor)
    HISTORY.forEach((dt, i) => {
      const g = set.ghosts[i];
      const hs = stateAt(ep, u - dt);
      g.root.visible = phase === 2 && st.s - hs.s > 0.18;
      if (g.root.visible) pose(g, hs);
    });
    set.past.root.visible = false;

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
    if (body.eye) ego.position.copy(head);
    else ego.position.copy(head).addScaledVector(fwd, 0.13 * ep.A.scale).add(V(0, 0.1 * ep.A.scale, 0));
    ego.lookAt(ego.position.x + fwd.x, ego.position.y - 0.62, ego.position.z + fwd.z);

    // draw: main view, then the egocentric inset
    const d = gov.dpr;
    shared.frame(canvas, ctx2d, 1, vp => {
      vp(0, 0, canvas.width, canvas.height);
      renderer.render(scene, cam);
      if (inset.w > 0) {
        ego.aspect = inset.w / inset.h;
        ego.updateProjectionMatrix();
        vp(Math.round(inset.x * d), Math.round(inset.y * d), Math.round(inset.w * d), Math.round(inset.h * d));
        renderer.render(scene, ego);
      }
    });

    // overlay text
    // live readout of the motion in the agent's native format
    if ((fmtTick++ & 3) === 0) fmt.textContent = body.kind === 'smplx' ? smplxText(body, t) : body.kind === 'g1' ? g1Text(body, t) : '';
    const key = ep.agent + phase;
    if (key !== lastKey) {
      steps.forEach((li, i) => li.classList.toggle('on', i === phase));
      caption.textContent = [ep.A.observe, `Condition on an interaction goal: ${ep.goal}`, ep.A.caption][phase];
      agentTag.textContent = ep.A.label;
      egoLabel.textContent = ep.A.cam;
      lastKey = key;
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
    canvas.width = Math.round(W * gov.dpr);
    canvas.height = Math.round(H * gov.dpr);
    canvas.style.width = '100%';
    canvas.style.height = H + 'px';
    cam.aspect = W / H;
    cam.fov = W / H < 1.8 ? 34 : 30;
    cam.updateProjectionMatrix();
    const iw = W < 480 ? 0 : Math.round(clamp(W * 0.27, 150, 270));
    inset = { x: 12, y: 12, w: iw, h: Math.round(iw * 0.62) };
    Object.assign(egoFrame.style, { width: iw + 'px', height: inset.h + 'px', display: iw ? '' : 'none' });
    fmt.style.top = (inset.y + inset.h + 10) + 'px'; // native-format readout sits under the camera inset
    draw();
  }

  // ── Loop, visibility, pause ────────────────────────────
  const st = { t: 11.3, last: null, running: false, visible: false, paused: false };
  const draw = () => render(st.t);
  const gov = window.vizGovernor(1.75, () => resize());
  function frame(now) {
    if (!st.running) return;
    if (st.last !== null) { gov.tick((now - st.last) / 1000); st.t += Math.min((now - st.last) / 1000, 0.05); }
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
  fallback.width = fallback.height = 0; // release the 2D sketch's backing store
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
      btn.innerHTML = `<svg class="ico" aria-hidden="true"><use href="#i-${st.paused ? 'play' : 'pause'}-fill"/></svg>`;
      update();
    });
  }
};
