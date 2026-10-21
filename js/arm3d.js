/*
 * Hero illustration: an ABB-style 6-axis industrial arm doing mocap-tracked pick-and-place.
 * Loaded lazily by viz.js with three.js and two addons; until it is ready (or if WebGL /
 * the CDN is unavailable) the 2D canvas sketch stays in place.
 *
 * Everything is a function of time t: a deterministic pick → place cycle drives an
 * analytic inverse-kinematics solution (planar 2-link shoulder/elbow + spherical wrist
 * that keeps the tool pointing down and aligned with each part).
 */
window.mountArm3D = function (fig, THREE, addons, fallback) {
  'use strict';

  const { RoomEnvironment, RoundedBoxGeometry, OrbitControls } = addons;
  const reduceMQ = matchMedia('(prefers-reduced-motion: reduce)');
  const darkMQ = matchMedia('(prefers-color-scheme: dark)');
  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, s) => a + (b - a) * s;
  const smooth = s => s * s * (3 - 2 * s);
  const ease = s => (s < 0.5 ? 4 * s * s * s : 1 - Math.pow(-2 * s + 2, 3) / 2);
  const wrapPi = a => Math.atan2(Math.sin(a), Math.cos(a));
  const V = (x, y, z) => new THREE.Vector3(x, y, z);

  // ── Robot dimensions (metres, roughly IRB 1200 proportions) ──
  const J2Y = 0.42;              // shoulder height
  const L2 = 0.35;               // upper arm
  const A3 = 0.045, D4 = 0.34;   // elbow offset, forearm to wrist centre
  const L3 = Math.hypot(A3, D4), B3 = Math.atan2(A3, D4);
  const D6 = 0.075;              // wrist centre to flange
  const TOOL = 0.135;            // flange to fingertip centre

  // ── Renderer, scene, camera ──────────────────────────────
  const shared = window.vizShared(THREE), renderer = shared.renderer; // one WebGL context for all scenes
  const canvas = document.createElement('canvas');
  const ctx2d = canvas.getContext('2d');
  canvas.className = 'arm3d-canvas';
  canvas.style.aspectRatio = '400 / 304';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'Animated 3D illustration: an industrial six-axis robot arm picks thin cylindrical items (pencils, cables, bolts) from a bin under an overhead stereo camera and places them in a tote, while motion-capture cameras track markers on its gripper.');

  const scene = new THREE.Scene();
  scene.environment = shared.env(RoomEnvironment);
  scene.environmentIntensity = 0.75;
  const cam = new THREE.PerspectiveCamera(30, 400 / 304, 0.05, 20);
  const LOOK = V(-0.03, 0.31, 0.12);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x6b665e, 0.55));
  const key = new THREE.DirectionalLight(0xfff6ea, 2.4);
  key.position.set(0.55, 3.2, 0.85); // high key: short, grounded shadows
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  Object.assign(key.shadow.camera, { left: -1.1, right: 1.1, top: 1.1, bottom: -1.1, near: 0.5, far: 6 });
  key.shadow.bias = -0.0003;
  key.shadow.normalBias = 0.01;
  key.shadow.radius = 5;
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xc9d8ff, 0.9);
  rim.position.set(-1.6, 1.4, -1.2);
  scene.add(rim);

  // ── Materials ───────────────────────────────────────────
  const M = {
    paint: new THREE.MeshPhysicalMaterial({ color: 0xeceae4, roughness: 0.36, metalness: 0.0, clearcoat: 0.6, clearcoatRoughness: 0.25 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x2a2d32, roughness: 0.5, metalness: 0.25 }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x17181b, roughness: 0.85 }),
    steel: new THREE.MeshStandardMaterial({ color: 0xb4bac2, roughness: 0.28, metalness: 0.9 }),
    alu: new THREE.MeshStandardMaterial({ color: 0x9aa1aa, roughness: 0.4, metalness: 0.8 }),
    plate: new THREE.MeshStandardMaterial({ color: 0x3b4048, roughness: 0.6, metalness: 0.5 }),
    pad: new THREE.MeshStandardMaterial({ color: 0x3d4a5c, roughness: 0.9 }),
    lens: new THREE.MeshPhysicalMaterial({ color: 0x05070a, roughness: 0.05, metalness: 0.2, clearcoat: 1 }),
    ir: new THREE.MeshStandardMaterial({ color: 0x400000, emissive: 0xff2a2a, emissiveIntensity: 1.6 }),
    marker: new THREE.MeshStandardMaterial({ color: 0xf2f4f7, emissive: 0xdfe6ee, emissiveIntensity: 0.55, roughness: 0.2 }),
    binA: new THREE.MeshStandardMaterial({ color: 0x4b3fc8, roughness: 0.7 }),
    binB: new THREE.MeshStandardMaterial({ color: 0x8b939e, roughness: 0.7 }),
    shadow: new THREE.ShadowMaterial({ opacity: 0.28 }),
    grid: new THREE.LineBasicMaterial({ transparent: true, opacity: 0.12 }),
    fov: new THREE.LineDashedMaterial({ dashSize: 0.025, gapSize: 0.02, transparent: true, opacity: 0.55 }),
    fovFill: new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.05, side: THREE.DoubleSide, depthWrite: false }),
    det: new THREE.LineBasicMaterial({ transparent: true }),
    trail: new THREE.LineBasicMaterial({ transparent: true, opacity: 0.85, vertexColors: true }),
  };

  // ── Geometry helpers ────────────────────────────────────
  const shadowed = m => { m.castShadow = true; m.receiveShadow = true; return m; };
  const mesh = (geo, mat, parent, x = 0, y = 0, z = 0) => {
    const m = shadowed(new THREE.Mesh(geo, mat));
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  };
  const rbox = (w, h, d, r, mat, parent, x, y, z) => mesh(new RoundedBoxGeometry(w, h, d, 4, r), mat, parent, x, y, z);
  const cylY = (rt, rb, h, mat, parent, x, y, z, seg = 40) => mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat, parent, x, y, z);
  const cylZ = (r, h, mat, parent, x, y, z, seg = 40) => { const m = cylY(r, r, h, mat, parent, x, y, z, seg); m.rotation.x = Math.PI / 2; return m; };
  const cylX = (rt, rb, h, mat, parent, x, y, z, seg = 40) => { const m = cylY(rt, rb, h, mat, parent, x, y, z, seg); m.rotation.z = -Math.PI / 2; return m; };
  // lathe-turned solid from a (radius, height) profile
  const lathe = (pts, mat, parent, y = 0) => mesh(new THREE.LatheGeometry(pts.map(([r, h]) => new THREE.Vector2(r, h)), 64), mat, parent, 0, y, 0);
  // tapered link with rounded ends between (0,0) r0 and (len,0) r1, extruded in z
  function linkGeo(len, r0, r1, depth, bevel) {
    const s = new THREE.Shape();
    const ang = Math.asin((r0 - r1) / len);
    s.absarc(0, 0, r0, Math.PI / 2 + ang, Math.PI * 1.5 - ang, false);
    s.absarc(len, 0, r1, -Math.PI / 2 - ang, Math.PI / 2 + ang, false);
    s.closePath();
    const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 5, curveSegments: 40 });
    g.translate(0, 0, -depth / 2);
    return g;
  }

  // ── Floor, plinth and grid ──────────────────────────────
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), M.shadow);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  {
    const g = [], R = 1.0, step = 0.1;
    for (let v = -R; v <= R + 1e-6; v += step) g.push(v, 0.001, -R, v, 0.001, R, -R, 0.001, v, R, 0.001, v);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(g, 3));
    scene.add(new THREE.LineSegments(geo, M.grid));
  }
  rbox(0.36, 0.035, 0.36, 0.008, M.plate, scene, 0, 0.0175, 0);
  for (let i = 0; i < 4; i++) {
    const a = TAU * (i + 0.5) / 4;
    cylY(0.012, 0.012, 0.012, M.steel, scene, Math.cos(a) * 0.15, 0.04, Math.sin(a) * 0.15, 16);
  }

  // ── Robot ───────────────────────────────────────────────
  const robot = new THREE.Group();
  robot.position.y = 0.035;
  scene.add(robot);
  // base casting
  lathe([[0, 0], [0.125, 0], [0.125, 0.018], [0.112, 0.03], [0.1, 0.08], [0.096, 0.13], [0, 0.13]], M.paint, robot);
  for (let i = 0; i < 8; i++) {
    const a = TAU * i / 8;
    cylY(0.007, 0.007, 0.008, M.steel, robot, Math.cos(a) * 0.115, 0.022, Math.sin(a) * 0.115, 12);
  }
  rbox(0.07, 0.05, 0.06, 0.012, M.dark, robot, -0.105, 0.05, 0); // cable connector box

  const j1 = new THREE.Group(); j1.position.y = 0.13; robot.add(j1);
  lathe([[0, 0], [0.098, 0], [0.098, 0.012], [0.09, 0.02], [0.088, 0.12], [0.07, 0.17], [0, 0.17]], M.paint, j1);
  rbox(0.12, 0.13, 0.09, 0.03, M.paint, j1, -0.06, 0.12, -0.07); // axis-1/2 motor housing
  cylZ(0.034, 0.02, M.dark, j1, -0.06, 0.13, -0.12);

  const j2 = new THREE.Group(); j2.position.set(0, J2Y - 0.13, 0); j1.add(j2);
  cylZ(0.078, 0.2, M.paint, j2, 0, 0, 0.0);
  cylZ(0.06, 0.012, M.dark, j2, 0, 0, 0.106);
  cylZ(0.06, 0.012, M.dark, j2, 0, 0, -0.106);
  const upper = mesh(linkGeo(L2, 0.072, 0.056, 0.07, 0.014), M.paint, j2, 0, 0, 0.065);
  upper.castShadow = true;

  const j3 = new THREE.Group(); j3.position.set(L2, 0, 0); j2.add(j3);
  cylZ(0.064, 0.17, M.paint, j3, 0, 0, 0.02);
  cylZ(0.05, 0.012, M.dark, j3, 0, 0, 0.11);
  rbox(0.16, 0.1, 0.11, 0.03, M.paint, j3, -0.03, A3 * 0.5, -0.02); // axis-3/4 motor block
  cylX(0.035, 0.035, 0.02, M.dark, j3, -0.12, A3 * 0.5, -0.02);

  const j4 = new THREE.Group(); j4.position.set(0, A3, -0.02); j3.add(j4);
  cylX(0.05, 0.042, D4 - 0.11, M.paint, j4, (D4 - 0.11) / 2 + 0.05, 0, 0);
  cylX(0.052, 0.052, 0.012, M.dark, j4, 0.05, 0, 0);

  const j5 = new THREE.Group(); j5.position.set(D4, 0, 0); j4.add(j5);
  rbox(0.1, 0.075, 0.1, 0.03, M.paint, j5, -0.02, 0, 0);
  cylZ(0.037, 0.106, M.paint, j5, 0, 0, 0);
  cylZ(0.03, 0.01, M.dark, j5, 0, 0, 0.055);
  cylZ(0.03, 0.01, M.dark, j5, 0, 0, -0.055);

  const j6 = new THREE.Group(); j6.position.set(D6 - 0.03, 0, 0); j5.add(j6);
  cylX(0.034, 0.034, 0.03, M.paint, j6, 0.015, 0, 0);
  cylX(0.03, 0.03, 0.008, M.steel, j6, 0.034, 0, 0);
  for (let i = 0; i < 6; i++) {
    const a = TAU * i / 6;
    cylX(0.003, 0.003, 0.004, M.dark, j6, 0.039, Math.cos(a) * 0.022, Math.sin(a) * 0.022, 8);
  }
  // parallel gripper: adapter, body, rail and two fingers (finger separation along local z)
  cylX(0.026, 0.026, 0.02, M.alu, j6, 0.048, 0, 0);
  rbox(0.045, 0.05, 0.1, 0.008, M.dark, j6, 0.078, 0, 0);
  rbox(0.012, 0.03, 0.11, 0.003, M.alu, j6, 0.104, 0, 0);
  const fingers = [-1, 1].map(sd => {
    const f = new THREE.Group();
    rbox(0.07, 0.022, 0.011, 0.003, M.alu, f, 0.035, 0, 0);
    rbox(0.026, 0.024, 0.004, 0.0015, M.pad, f, 0.058, 0, -sd * 0.0072);
    f.position.set(0.108, 0, 0);
    f.userData.side = sd;
    j6.add(f);
    return f;
  });
  // mocap rigid body: four retro-reflective markers on stalks (asymmetric constellation)
  const markers = [[0.07, 0.05, 0.03], [0.07, -0.05, 0.045], [0.085, 0.045, -0.05], [0.06, -0.025, -0.06]].map(([x, y, z]) => {
    const stalk = cylY(0.0025, 0.0025, Math.abs(y), M.dark, j6, x, y / 2, z, 8);
    stalk.castShadow = false;
    const m = mesh(new THREE.SphereGeometry(0.009, 20, 14), M.marker, j6, x, y + Math.sign(y) * 0.005, z);
    return m;
  });
  const tcp = new THREE.Object3D(); // fingertip centre: j6 sits 0.03 before the flange, TOOL is flange → tips
  tcp.position.x = 0.03 + TOOL;
  j6.add(tcp);


  // ── Work cell ───────────────────────────────────────────
  function tote(cx, cz, w, d, h, mat) {
    const g = new THREE.Group();
    g.position.set(cx, 0, cz);
    const t = 0.012;
    rbox(w, t, d, 0.004, mat, g, 0, t / 2, 0);
    rbox(w, h, t, 0.005, mat, g, 0, h / 2, d / 2 - t / 2);
    rbox(w, h, t, 0.005, mat, g, 0, h / 2, -d / 2 + t / 2);
    rbox(t, h, d, 0.005, mat, g, w / 2 - t / 2, h / 2, 0);
    rbox(t, h, d, 0.005, mat, g, -w / 2 + t / 2, h / 2, 0);
    scene.add(g);
    return g;
  }
  const BIN = V(-0.36, 0, 0.34), TOTE = V(0.38, 0, 0.28);
  const surfaces = [floor, tote(BIN.x, BIN.z, 0.3, 0.24, 0.1, M.binA), tote(TOTE.x, TOTE.z, 0.3, 0.22, 0.1, M.binB)];

  // ── Overhead stereo camera: post + cantilever arm, camera level above the bin, lenses down ──
  const noShadow = m => { m.castShadow = false; return m; };
  // aluminium extrusion: square bar with a dark T-slot groove on each face
  function extrusion(len, parent, axis) {
    const g = new THREE.Group();
    const w = 0.032;
    noShadow(rbox(axis === 'y' ? w : len, axis === 'y' ? len : w, w, 0.003, M.alu, g, 0, 0, 0));
    const gw = 0.007, gl = len - 0.01;
    [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([a, b]) => {
      const sz = axis === 'y' ? [a ? 0.002 : gw, gl, b ? 0.002 : gw] : [gl, a ? 0.002 : gw, b ? 0.002 : gw];
      const off = w / 2 + 0.0005;
      const m = noShadow(mesh(new THREE.BoxGeometry(...sz), M.dark, g, 0, 0, 0));
      if (axis === 'y') m.position.set(a * off, 0, b * off); else m.position.set(0, a * off, b * off);
    });
    parent.add(g);
    return g;
  }
  const POST = V(BIN.x - 0.25, 0, BIN.z - 0.21), POST_H = 0.72;
  const toBin = V(BIN.x - POST.x, 0, BIN.z - POST.z), ARM_L = toBin.length();
  rbox(0.16, 0.012, 0.16, 0.003, M.plate, scene, POST.x, 0.006, POST.z);
  [[1, 1], [1, -1], [-1, 1], [-1, -1]].forEach(([a, b]) => cylY(0.006, 0.006, 0.006, M.steel, scene, POST.x + a * 0.06, 0.015, POST.z + b * 0.06, 12));
  extrusion(POST_H, scene, 'y').position.set(POST.x, POST_H / 2 + 0.012, POST.z);
  const armG = new THREE.Group();
  armG.position.set(POST.x, POST_H, POST.z);
  armG.rotation.y = Math.atan2(-toBin.z, toBin.x); // local +x points at the bin centre
  scene.add(armG);
  extrusion(ARM_L + 0.03, armG, 'x').position.set((ARM_L + 0.03) / 2 - 0.016, 0, 0);
  const brace = extrusion(0.19, armG, 'x');
  brace.position.set(0.067, -0.067, 0);
  brace.rotation.z = Math.PI / 4;
  rbox(0.055, 0.008, 0.055, 0.002, M.steel, armG, ARM_L, -0.02, 0);          // end plate
  cylY(0.006, 0.006, 0.045, M.steel, armG, ARM_L, -0.046, 0, 16);              // drop rod

  // camera body (ZED-style capsule), long axis along the bin's long axis, lenses facing the floor
  const CAM_Y = POST_H - 0.085;
  const cam3 = new THREE.Group();
  cam3.position.set(BIN.x, CAM_Y, BIN.z);
  scene.add(cam3);
  rbox(0.03, 0.012, 0.022, 0.003, M.dark, cam3, 0, 0.021, 0);                  // tripod-thread bracket
  const body = mesh(new THREE.CapsuleGeometry(0.016, 0.14, 8, 24), M.dark, cam3, 0, 0, 0);
  body.rotation.z = Math.PI / 2;
  body.scale.set(1, 1, 0.85);
  [-0.06, 0.06].forEach(x => {
    noShadow(cylY(0.0115, 0.0115, 0.006, M.rubber, cam3, x, -0.015, 0, 28));
    noShadow(mesh(new THREE.CircleGeometry(0.0085, 28), M.lens, cam3, x, -0.0185, 0)).rotation.x = Math.PI / 2;
  });
  noShadow(mesh(new THREE.CircleGeometry(0.0022, 12), new THREE.MeshBasicMaterial({ color: 0x3b82f6 }), cam3, 0, -0.0165, 0.006)).rotation.x = Math.PI / 2;
  // USB cable: up the drop rod, along the top of the arm, down the back of the post
  {
    const e = V(Math.cos(armG.rotation.y), 0, -Math.sin(armG.rotation.y)); // arm direction
    const at = (d, y, back = 0) => V(POST.x + e.x * (d - back), y, POST.z + e.z * (d - back));
    const top = POST_H + 0.0195;
    const pts = [V(BIN.x, CAM_Y + 0.027, BIN.z), V(BIN.x, top - 0.012, BIN.z), at(ARM_L - 0.03, top), at(ARM_L * 0.5, top),
      at(0.03, top), at(0, top - 0.004, 0.019), at(0, POST_H - 0.06, 0.0195), at(0, 0.03, 0.0195)];
    noShadow(mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, false, 'centripetal', 0.2), 120, 0.0032, 8), M.rubber, scene));
  }
  // field of view: pyramid from the optical centre to a footprint just covering the bin rim
  {
    const O = V(BIN.x, CAM_Y - 0.02, BIN.z), y = 0.1, hx = 0.19, hz = 0.15;
    const c = [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]].map(([dx, dz]) => V(BIN.x + dx, y, BIN.z + dz));
    const pts = [];
    c.forEach((p, i) => { pts.push(O, p, p, c[(i + 1) % 4]); });
    const l = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), M.fov);
    l.computeLineDistances();
    scene.add(l);
    const tri = [];
    c.forEach((p, i) => tri.push(O, p, c[(i + 1) % 4]));
    const vol = new THREE.Mesh(new THREE.BufferGeometry().setFromPoints(tri), M.fovFill);
    scene.add(vol);
  }

  // ── OptiTrack-style mocap cameras on tripods, each aimed at the workspace ──
  const WORKSPACE = V(0, 0.12, 0.25);
  [V(-0.82, 0, -0.42), V(0.86, 0, -0.38)].forEach(pos => {
    const g = new THREE.Group();
    g.position.copy(pos);
    scene.add(g);
    for (let i = 0; i < 3; i++) {                                              // tripod legs
      const a = TAU * i / 3 + 0.4;
      const foot = V(Math.cos(a) * 0.15, 0, Math.sin(a) * 0.15), apex = V(0, 0.36, 0);
      const leg = noShadow(cylY(0.007, 0.007, apex.distanceTo(foot), M.dark, g, 0, 0, 0, 10));
      leg.position.copy(apex).add(foot).multiplyScalar(0.5);
      leg.quaternion.setFromUnitVectors(V(0, 1, 0), apex.clone().sub(foot).normalize());
    }
    noShadow(cylY(0.016, 0.016, 0.05, M.dark, g, 0, 0.37, 0, 16));             // leg hub
    noShadow(cylY(0.009, 0.009, 0.2, M.alu, g, 0, 0.48, 0, 16));               // centre mast
    const head = new THREE.Group();
    head.position.set(0, 0.62, 0);
    g.add(head);
    g.updateMatrixWorld(true);
    head.lookAt(WORKSPACE);                                                    // +z faces the workspace
    noShadow(rbox(0.075, 0.07, 0.1, 0.012, M.dark, head, 0, 0, -0.012));
    noShadow(rbox(0.05, 0.03, 0.03, 0.006, M.dark, head, 0, -0.05, -0.012)); // pan-tilt mount
    noShadow(mesh(new THREE.TorusGeometry(0.024, 0.0055, 10, 36), M.ir, head, 0, 0, 0.04));
    noShadow(mesh(new THREE.CircleGeometry(0.017, 28), M.lens, head, 0, 0, 0.0385));
  });

  // ── Parts: pencils, cables and bolts (all thin cylinders, axis = local y) ──
  function pencil(color) {
    const g = new THREE.Group();
    mesh(new THREE.CylinderGeometry(0.0085, 0.0085, 0.13, 6), new THREE.MeshStandardMaterial({ color, roughness: 0.55 }), g, 0, 0, 0);
    mesh(new THREE.CylinderGeometry(0.0085, 0.0085, 0.012, 16), new THREE.MeshStandardMaterial({ color: 0xc9cdd2, metalness: 0.8, roughness: 0.3 }), g, 0, 0.071, 0);
    mesh(new THREE.CylinderGeometry(0.0082, 0.0082, 0.014, 16), new THREE.MeshStandardMaterial({ color: 0xe88aa0, roughness: 0.8 }), g, 0, 0.084, 0);
    mesh(new THREE.ConeGeometry(0.0085, 0.024, 6), new THREE.MeshStandardMaterial({ color: 0xe7c9a2, roughness: 0.8 }), g, 0, -0.077, 0).rotation.x = Math.PI;
    return g;
  }
  function cable() {
    const g = new THREE.Group();
    mesh(new THREE.CylinderGeometry(0.0065, 0.0065, 0.15, 16), new THREE.MeshStandardMaterial({ color: 0x1c1f24, roughness: 0.6 }), g, 0, 0, 0);
    [-1, 1].forEach(s => rbox(0.016, 0.026, 0.011, 0.003, new THREE.MeshStandardMaterial({ color: 0xd8dde3, roughness: 0.4, metalness: 0.3 }), g, 0, s * 0.085, 0));
    return g;
  }
  function bolt() {
    const g = new THREE.Group();
    const m = new THREE.MeshStandardMaterial({ color: 0xbfc5cc, metalness: 0.95, roughness: 0.3 });
    mesh(new THREE.CylinderGeometry(0.0075, 0.0075, 0.11, 20), m, g, 0, -0.01, 0);
    mesh(new THREE.CylinderGeometry(0.0145, 0.0145, 0.012, 6), m, g, 0, 0.051, 0);
    return g;
  }
  const PARTS = [
    { make: () => pencil(0xf2b632), r: 0.0085, label: 'pencil' },
    { make: cable, r: 0.0065, label: 'cable' },
    { make: bolt, r: 0.0075, label: 'bolt' },
    { make: () => pencil(0x3e7bd6), r: 0.0085, label: 'pencil' },
  ];
  const CONF = ['0.97', '0.95', '0.98', '0.94'];
  // poses in the bin (pick) and tote (place): [x, z, yaw]
  const PICK = [[-0.07, 0.05, 0.5], [0.06, -0.04, -0.7], [-0.03, -0.05, 1.3], [0.07, 0.06, 0.15]].map(([dx, dz, yaw]) => ({ x: BIN.x + dx, z: BIN.z + dz, yaw }));
  const PLACE = [[-0.09, 0.03, 0.2], [-0.03, -0.03, 0.2], [0.03, 0.03, 0.2], [0.09, -0.03, 0.2]].map(([dx, dz, yaw]) => ({ x: TOTE.x + dx, z: TOTE.z + dz, yaw }));
  const FLOOR_Y = 0.012;
  const items = PARTS.map(p => {
    const o = p.make();
    o.traverse(n => { if (n.material) { n.material = n.material.clone(); n.material.transparent = true; } });
    scene.add(o);
    return o;
  });
  // axis-aligned (horizontal) pose for a part lying at (x, z) with yaw
  const qLie = new THREE.Quaternion(), tmpQ = new THREE.Quaternion();
  function layPart(o, k, x, z, yaw) {
    o.position.set(x, FLOOR_Y + PARTS[k].r, z);
    qLie.setFromAxisAngle(V(0, 0, 1), Math.PI / 2);
    tmpQ.setFromAxisAngle(V(0, 1, 0), yaw);
    o.quaternion.copy(tmpQ).multiply(qLie);
  }
  function setOpacity(o, a) { o.visible = a > 0.01; o.traverse(n => { if (n.material) n.material.opacity = a; }); }

  // detection box around the target part
  const detBox = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(0.19, 0.035, 0.04)), M.det);
  scene.add(detBox);

  // TCP trail (vertex-coloured, fades with age)
  const TRAIL = 70;
  const trailGeo = new THREE.BufferGeometry();
  trailGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL * 3), 3));
  trailGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(TRAIL * 4), 4)); // rgba: fades by alpha
  const trail = new THREE.Line(trailGeo, M.trail);
  trail.frustumCulled = false;
  scene.add(trail);

  // ── Motion plan (polar targets around the base) ─────────
  const HOVER = 0.13;
  const pol = (x, y, z, yaw) => ({ th: Math.atan2(z, x), r: Math.hypot(x, z), y, yaw });
  const TC = 5.85;
  function plan(t) {
    const i = Math.floor(t / TC), j = ((i % 4) + 4) % 4;
    let u = t - i * TC;
    const pk = PICK[j], pl = PLACE[j], pv = PLACE[(j + 3) % 4];
    const yP = FLOOR_Y + PARTS[j].r, yPv = FLOOR_Y + PARTS[(j + 3) % 4].r;
    const B = pol(pk.x, yP, pk.z, pk.yaw), BH = pol(pk.x, yP + HOVER, pk.z, pk.yaw);
    const T = pol(pl.x, yP, pl.z, pl.yaw), TH = pol(pl.x, yP + HOVER, pl.z, pl.yaw);
    const PH = pol(pv.x, yPv + HOVER, pv.z, pv.yaw);
    // [duration, phase label, from, to, grip0, grip1, arc]
    const segs = [
      [1.5, 'approach', PH, BH, 0, 0, 0.1],
      [0.6, 'descend', BH, B, 0, 0, 0],
      [0.35, 'grasp', B, B, 0, 1, 0],
      [0.5, 'lift', B, BH, 1, 1, 0],
      [1.6, 'transfer', BH, TH, 1, 1, 0.12],
      [0.55, 'place', TH, T, 1, 1, 0],
      [0.3, 'release', T, T, 1, 0, 0],
      [0.45, 'retreat', T, TH, 0, 0, 0],
    ];
    let k = 0;
    while (k < segs.length - 1 && u > segs[k][0]) { u -= segs[k][0]; k++; }
    const [d, ph, A, Bp, g0, g1, arc] = segs[k];
    const s = ease(clamp(u / d, 0, 1));
    const th = A.th + wrapPi(Bp.th - A.th) * s;
    const r = lerp(A.r, Bp.r, s);
    let dy = wrapPi(2 * (Bp.yaw - A.yaw)) / 2; // parts are symmetric: yaw is mod π
    return {
      i, j, k, ph, s,
      x: r * Math.cos(th), z: r * Math.sin(th), y: lerp(A.y, Bp.y, s) + arc * Math.sin(Math.PI * s),
      yaw: A.yaw + dy * s, grip: lerp(g0, g1, s),
    };
  }

  // ── Inverse kinematics ──────────────────────────────────
  const tmpV = V(0, 0, 0), tmpW = V(0, 0, 0), DOWN = V(0, -1, 0);
  let lastQ6 = 0;
  const q = [0, 0, 0, 0, 0, 0];
  function solve(p) {
    // wrist centre straight above the fingertip (tool points down)
    const wx = p.x, wy = p.y + TOOL + D6 - robot.position.y, wz = p.z;
    const q1 = Math.atan2(-wz, wx);
    const r = Math.hypot(wx, wz), h = wy - J2Y;
    const D = clamp(Math.hypot(r, h), 0.05, L2 + L3 - 1e-4);
    const e2 = Math.atan2(h, r) + Math.acos(clamp((L2 * L2 + D * D - L3 * L3) / (2 * L2 * D), -1, 1));
    const psi = Math.acos(clamp((L2 * L2 + L3 * L3 - D * D) / (2 * L2 * L3), -1, 1));
    const e3 = e2 - (Math.PI - psi);        // absolute direction of elbow → wrist centre
    const e3g = e3 - B3;                    // absolute pitch of the forearm frame
    j1.rotation.y = q1;
    j2.rotation.z = e2;
    j3.rotation.z = e3g - e2;
    j4.rotation.x = 0;
    j5.rotation.z = -Math.PI / 2 - e3g;     // keep the tool axis vertical
    // axis 6: rotate the finger-separation axis (local z) to be perpendicular to the part
    j6.rotation.x = 0;
    robot.updateMatrixWorld(true);
    const z0 = tmpV.set(0, 0, 1).transformDirection(j6.matrixWorld).setY(0).normalize();
    const want = tmpW.set(Math.sin(p.yaw), 0, Math.cos(p.yaw)); // horizontal, ⟂ to part axis
    let q6 = Math.atan2(z0.clone().cross(want).dot(DOWN), z0.dot(want));
    if (q6 - lastQ6 > Math.PI / 2) q6 -= Math.PI; else if (q6 - lastQ6 < -Math.PI / 2) q6 += Math.PI;
    lastQ6 = q6;
    j6.rotation.x = q6;
    robot.updateMatrixWorld(true);
    q[0] = q1; q[1] = Math.PI / 2 - e2; q[2] = e3g - e2; q[3] = 0; q[4] = j5.rotation.z; q[5] = q6;
  }

  // ── DOM overlay ─────────────────────────────────────────
  const ui = document.createElement('div');
  ui.className = 'arm3d-ui';
  ui.innerHTML = `<div class="arm3d-hud"><b class="hud-phase"></b><span class="hud-ee"></span><span class="hud-q"></span></div>
    <div class="arm3d-tag det-tag"></div><div class="arm3d-tag ok-tag">single pick ✓</div>
    <div class="arm3d-hint">${matchMedia('(hover: none)').matches ? 'Swipe to orbit · tap to move the arm' : 'Drag to orbit · click to move the arm'}</div>`;
  const hudPhase = ui.querySelector('.hud-phase'), hudEe = ui.querySelector('.hud-ee'), hudQ = ui.querySelector('.hud-q');
  const detTag = ui.querySelector('.det-tag'), okTag = ui.querySelector('.ok-tag');

  // ── Theme ───────────────────────────────────────────────
  function applyTheme() {
    const cs = getComputedStyle(document.documentElement);
    const accent = new THREE.Color(cs.getPropertyValue('--accent').trim() || '#1f3fb8');
    const ink = new THREE.Color(cs.getPropertyValue('--ink-3').trim() || '#646a75');
    const dark = darkMQ.matches;
    M.shadow.opacity = dark ? 0.5 : 0.24;
    M.grid.color.copy(ink);
    M.grid.opacity = dark ? 0.16 : 0.13;
    M.fov.color.copy(accent);
    M.fovFill.color.copy(accent);
    M.det.color.copy(accent);
    M.binA.color.set(cs.getPropertyValue('--chip-b').trim() || '#5647e0'); // source bin takes the theme colour
    scene.environmentIntensity = dark ? 0.6 : 0.8;
  }

  // ── Interaction: orbit the camera, click/tap a surface to send the arm there ──
  const controls = new OrbitControls(cam, canvas);
  controls.target.copy(LOOK);
  Object.assign(controls, { enableZoom: false, enablePan: false, rotateSpeed: 0.7, dampingFactor: 0.08, minPolarAngle: 0.35, maxPolarAngle: 1.35 });
  canvas.style.touchAction = 'pan-y'; // vertical swipes still scroll the page on phones
  let userCam = false, inDraw = false;
  const hint = ui.querySelector('.arm3d-hint');
  const hideHint = () => hint.classList.add('gone');
  controls.addEventListener('start', () => { userCam = true; hideHint(); canvas.classList.add('grabbing'); });
  controls.addEventListener('end', () => canvas.classList.remove('grabbing'));
  controls.addEventListener('change', () => { if (!st.running && !inDraw) draw(); });

  // target marker: accent when reachable, red when the arm had to stop short
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.024, 0.032, 48), new THREE.MeshBasicMaterial({ transparent: true, side: THREE.DoubleSide, depthWrite: false }));
  ring.rotation.x = -Math.PI / 2;
  ring.visible = false;
  scene.add(ring);
  let ringT0 = 0;

  // teach mode: the arm sweeps to a clicked point, holds, then blends back into the cycle
  const IDLE = 3.5, ctl = { mode: 'auto', autoT: 8.6, from: null, to: null, t0: 0, dur: 1, arc: 0.08, cur: null };
  function blend(A, B, s, arc) {
    const a = pol(A.x, A.y, A.z, A.yaw), b = pol(B.x, B.y, B.z, B.yaw);
    const th = a.th + wrapPi(b.th - a.th) * s, r = lerp(a.r, b.r, s);
    return { x: r * Math.cos(th), z: r * Math.sin(th), y: lerp(a.y, b.y, s) + arc * Math.sin(Math.PI * s), yaw: a.yaw + (wrapPi(2 * (b.yaw - a.yaw)) / 2) * s };
  }
  function pose() {
    const p = plan(ctl.autoT);
    if (ctl.mode === 'teach') {
      const s = ease(clamp((st.t - ctl.t0) / ctl.dur, 0, 1));
      const b = blend(ctl.from, ctl.to, s, ctl.arc);
      if (st.running && st.t - ctl.t0 > ctl.dur + IDLE) { ctl.mode = 'resume'; ctl.from = b; ctl.t0 = st.t; }
      return { ...p, ...b, ph: s < 1 ? 'teach · moving' : 'teach · holding', manual: true };
    }
    if (ctl.mode === 'resume') {
      const s = ease(clamp((st.t - ctl.t0) / 1.4, 0, 1));
      if (s >= 1) ctl.mode = 'auto';
      return { ...p, ...blend(ctl.from, p, s, 0.06), ph: 'resuming', manual: true };
    }
    return p;
  }
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  function goTo(pt) {
    hideHint();
    const y = Math.max(pt.y, 0) + 0.025;
    const th = Math.atan2(pt.z, pt.x);
    const h = y + TOOL + D6 - robot.position.y - J2Y, Lmax = L2 + L3 - 0.03;
    const rMax = Math.sqrt(Math.max(0, Lmax * Lmax - h * h)), rMin = 0.24;
    const r0 = Math.hypot(pt.x, pt.z), r = clamp(r0, rMin, rMax);
    const reachable = Math.abs(r - r0) < 1e-3;
    ctl.from = { ...ctl.cur };
    ctl.to = { x: r * Math.cos(th), y, z: r * Math.sin(th), yaw: ctl.cur.yaw };
    const dist = Math.hypot(ctl.to.x - ctl.from.x, ctl.to.y - ctl.from.y, ctl.to.z - ctl.from.z);
    ctl.dur = st.running ? clamp(0.45 + dist * 1.6, 0.6, 1.8) : 1e-4; // paused / reduced motion: jump
    ctl.arc = clamp(dist * 0.25, 0.03, 0.12);
    ctl.t0 = st.t;
    ctl.mode = 'teach';
    ring.position.set(pt.x, pt.y + 0.003, pt.z);
    ring.material.color.set(reachable ? M.det.color : 0xe5484d);
    ring.visible = true;
    ringT0 = st.t;
    if (!st.running) draw();
  }
  let down = null;
  canvas.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
  canvas.addEventListener('pointerup', e => {
    if (!down) return;
    const tap = Math.hypot(e.clientX - down.x, e.clientY - down.y) < 6 && performance.now() - down.t < 450;
    down = null;
    if (!tap) return;
    const rect = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    ray.setFromCamera(ndc, cam);
    const hit = ray.intersectObjects(surfaces, true)[0];
    if (hit) goTo(hit.point);
  });

  // ── Frame ───────────────────────────────────────────────
  const tipW = V(0, 0, 0), proj = V(0, 0, 0);
  const live = new THREE.Color(0x22c55e);
  const hist = [];
  let W = 1, H = 1;
  const place = (el, p, dx, dy) => {
    proj.copy(p).project(cam);
    el.style.transform = `translate(${((proj.x + 1) / 2) * W + dx}px, ${((1 - proj.y) / 2) * H + dy}px)`;
  };

  function render(t) {
    inDraw = true;
    const p = pose();
    solve(p);
    ctl.cur = { x: p.x, y: p.y, z: p.z, yaw: p.yaw };

    // fingers
    const open = lerp(0.03, PARTS[p.j].r + 0.0068, p.grip);
    fingers.forEach(f => { f.position.z = f.userData.side * open; });

    // parts: bin → gripper → tote. The tote empties while the arm retreats after the
    // 4th part; the bin refills as the next batch starts. A held part rides along in teach mode.
    const binIn = p.j === 0 && p.k === 0 && !p.manual ? smooth(p.s) : 1;
    const toteOut = p.j === 3 && p.k === 7 && !p.manual ? 1 - smooth(p.s) : 1;
    items.forEach((o, m) => {
      if (m === p.j && p.k >= 3 && p.k <= 5) {
        // held: the part's axis is the gripper's local y, so the fingers close across it
        tcp.getWorldPosition(o.position);
        j6.getWorldQuaternion(o.quaternion);
        setOpacity(o, 1);
      } else if (m < p.j || (m === p.j && p.k >= 6)) {
        layPart(o, m, PLACE[m].x, PLACE[m].z, PLACE[m].yaw);
        setOpacity(o, toteOut);
      } else {
        layPart(o, m, PICK[m].x, PICK[m].z, PICK[m].yaw);
        setOpacity(o, binIn);
      }
    });

    // detection box and label during approach / descend / grasp (auto mode only)
    const showDet = p.k <= 2 && !p.manual;
    detBox.visible = showDet;
    if (showDet) {
      detBox.position.set(PICK[p.j].x, FLOOR_Y + PARTS[p.j].r, PICK[p.j].z);
      detBox.rotation.set(0, PICK[p.j].yaw, 0);
      M.det.opacity = 0.6 + 0.4 * Math.sin(t * 6) ** 2;
    }
    detTag.textContent = `${PARTS[p.j].label} · ${CONF[p.j]}`;
    detTag.style.opacity = showDet ? 1 : 0;
    place(detTag, V(PICK[p.j].x, FLOOR_Y + 0.06, PICK[p.j].z), -40, -26);
    tcp.getWorldPosition(tipW);
    okTag.style.opacity = !p.manual && (p.k === 3 || (p.k === 4 && p.s < 0.45)) ? 1 : 0;
    place(okTag, tipW, 16, -40);

    // target ring: pulses in, fades out
    if (ring.visible) {
      const a = st.t - ringT0;
      ring.scale.setScalar(1 + 0.6 * Math.exp(-a * 4) + 0.08 * Math.sin(a * 6));
      ring.material.opacity = clamp(1.2 - a / 4, 0, 1);
      if (a > 5) ring.visible = false;
    }

    // mocap trail: the fingertip's actual recent path
    const lastH = hist[0];
    if (!lastH || lastH.distanceToSquared(tipW) > 1e-8) { hist.unshift(tipW.clone()); if (hist.length > TRAIL) hist.pop(); }
    const P = trailGeo.attributes.position.array, Cc = trailGeo.attributes.color.array;
    hist.forEach((v, n) => {
      v.toArray(P, n * 3);
      const a = 1 - n / TRAIL;
      Cc[n * 4] = live.r; Cc[n * 4 + 1] = live.g; Cc[n * 4 + 2] = live.b; Cc[n * 4 + 3] = a * a;
    });
    trailGeo.setDrawRange(0, hist.length);
    trailGeo.attributes.position.needsUpdate = true;
    trailGeo.attributes.color.needsUpdate = true;

    // camera: gentle sway until the visitor takes over, then orbit controls
    if (!userCam) {
      const sw = Math.sin(t * 0.18) * 0.12;
      const R = 2.4, el = 0.46, az = 0.55 + sw;
      cam.position.set(LOOK.x + R * Math.cos(el) * Math.sin(az), LOOK.y + R * Math.sin(el), LOOK.z + R * Math.cos(el) * Math.cos(az));
      cam.lookAt(LOOK);
    } else {
      controls.update();
    }
    shared.frame(canvas, ctx2d, 1.05, vp => { vp(0, 0, canvas.width, canvas.height); renderer.render(scene, cam); });

    // HUD
    hudPhase.textContent = p.ph;
    hudEe.textContent = `tcp  x ${tipW.x.toFixed(2)}  y ${tipW.z.toFixed(2)}  z ${tipW.y.toFixed(2)} m`;
    hudQ.textContent = 'q  ' + q.map(a => String(Math.round(a * 180 / Math.PI)).padStart(4, ' ')).join(' ') + '°';
    inDraw = false;
  }

  function resize() {
    W = Math.max(1, fig.clientWidth);
    H = Math.round(W * 304 / 400);
    canvas.width = Math.round(W * gov.dpr);
    canvas.height = Math.round(H * gov.dpr);
    canvas.style.width = '100%';
    canvas.style.height = H + 'px';
    ui.style.height = H + 'px'; // overlay covers the canvas only, not the caption below
    cam.aspect = W / H;
    cam.updateProjectionMatrix();
    draw();
  }

  // ── Loop, visibility, pause ─────────────────────────────
  // st.t is wall-clock scene time; ctl.autoT drives the pick-place cycle and pauses in teach mode.
  const st = { t: 0, last: null, running: false, visible: false, paused: false };
  const draw = () => render(st.t);
  const gov = window.vizGovernor(2, () => resize());
  function frame(now) {
    if (!st.running) return;
    if (st.last !== null) {
      gov.tick((now - st.last) / 1000);
      const dt = Math.min((now - st.last) / 1000, 0.05);
      st.t += dt;
      if (ctl.mode !== 'teach') ctl.autoT += dt;
    }
    st.last = now;
    draw();
    requestAnimationFrame(frame);
  }
  function update() {
    const go = st.visible && !st.paused && !reduceMQ.matches;
    if (go && !st.running) { st.running = true; st.last = null; requestAnimationFrame(frame); }
    if (!go) st.running = false;
    controls.enableDamping = st.running; // damping needs a running loop to settle
  }

  applyTheme();
  fig.insertBefore(canvas, fallback);
  fig.insertBefore(ui, fallback);
  resize();
  fallback.style.display = 'none';
  fallback.width = fallback.height = 0; // release the 2D sketch's backing store
  fig.classList.add('is-3d');
  new ResizeObserver(resize).observe(fig);
  new IntersectionObserver(([e]) => { st.visible = e.isIntersecting; update(); }, { rootMargin: '80px' }).observe(canvas);
  darkMQ.addEventListener('change', () => { applyTheme(); draw(); });
  window.addEventListener('vizthemechange', () => { applyTheme(); if (!st.running) draw(); }); // follow the page's theme fade
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
