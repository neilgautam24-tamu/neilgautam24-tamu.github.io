/*
 * 3D illustration for the C2BL research (EchoNet + NeuralMRI).
 * Loaded lazily by viz.js, which passes in three.js from the CDN.
 *
 * Four stages on a loop:
 *   1. FE simulation    beating left ventricle; Lagrangian material points trace their paths
 *   2. Tri-planar echo  three apical planes show the wall contour and in-plane optical flow
 *   3. 3D motion        full 3D displacement, as a heatmap and vectors on the surface
 *   4. MRI → surface    sparse MRI slices → hierarchical occupancy samples → coarse-to-fine surface
 */
window.mountCardiac3D = function (fig, THREE) {
  'use strict';

  const reduceMQ = matchMedia('(prefers-reduced-motion: reduce)');
  const darkMQ = matchMedia('(prefers-color-scheme: dark)');
  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, s) => a + (b - a) * s;
  const smooth = s => s * s * (3 - 2 * s);
  const V = (x, y, z) => new THREE.Vector3(x, y, z);

  const STAGES = [
    { dur: 4.2, cap: 'A finite-element simulation drives the heart. Lagrangian material points give every tissue point an exact trajectory.', metric: '' },
    { dur: 5.2, cap: 'Tri-planar echo slices with pixel-exact optical-flow ground truth, used to supervise SEA-RAFT.', metric: '2D EPE 0.121 px' },
    { dur: 4.4, cap: 'Inverse multi-planar projection lifts the 2D flow into full 3D volumetric displacement.', metric: '3D EPE 0.084 mm' },
    { dur: 6.2, cap: 'NeuralMRI: an implicit occupancy field turns sparse MRI cross-sections into a continuous 3D surface.', metric: 'Chamfer 0.057 mm' },
  ];
  const CYCLE = STAGES.reduce((s, x) => s + x.dur, 0);
  const BEAT = 1.25; // seconds per heartbeat

  // Per-stage targets; values cross-fade over the first 0.7 s of each stage.
  const TGT = {
    heart:   [1, 1, 1, 0],
    epi:     [0.34, 0.16, 0.97, 0],
    heat:    [0, 0, 1, 0],
    markers: [1, 0, 0, 0],
    planes:  [0, 1, 0, 0],
    arrows:  [0, 0, 1, 0],
    beat:    [1, 1, 1, 0],
    mri:     [0, 0, 0, 1],
  };

  // ── Renderer ───────────────────────────────────────────
  const stage = fig.querySelector('.c3d-stage');
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const canvas = renderer.domElement;
  canvas.className = 'c3d-canvas';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'Animated 3D illustration of a beating left ventricle: finite-element material points trace their motion, three echo planes show optical flow, the surface is colored by 3D displacement, and finally a surface is reconstructed coarse-to-fine from sparse MRI slices.');
  stage.prepend(canvas);

  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(32, 1.6, 0.1, 50);
  const root = new THREE.Group();
  root.rotation.z = 0.32;
  scene.add(root);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x9a8f86, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(3, 5, 4);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xbcd0ff, 1.2);
  rim.position.set(-4, 2, -3);
  scene.add(rim);

  // ── Left-ventricle model ───────────────────────────────
  // Truncated prolate spheroids for endocardium (layer 0) and epicardium (layer 1).
  // s ∈ [0, 1] is contraction: wall thickening, base descent and apex-to-base twist.
  const U_MAX = 0.6 * Math.PI, NU = 36, NV = 64;
  const DIMS = [{ a: 0.62, c: 1.32, k: 0.3 }, { a: 0.95, c: 1.55, k: 0.08 }];
  const Y_OFF = 0.53; // recentre the heart vertically
  function lv(layer, u, v, s, out, twist = true) {
    const d = DIMS[layer];
    const a = d.a * (1 - d.k * s);
    const h = (1 - Math.cos(u)) / (1 - Math.cos(U_MAX));
    const vv = twist ? v + 0.24 * s * (h - 0.35) : v;
    const r = a * Math.sin(u);
    const y0 = -d.c * Math.cos(u);
    const y = -d.c + (y0 + d.c) * (1 - 0.13 * s);
    return out.set(r * Math.cos(vv), y + Y_OFF, r * Math.sin(vv));
  }
  const REST_BASE = lv(1, U_MAX, 0, 0, V(0, 0, 0)).y;

  function gridGeo(nu, nv) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((nu + 1) * (nv + 1) * 3), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array((nu + 1) * (nv + 1) * 3), 3));
    const idx = [];
    for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
      const a = i * (nv + 1) + j, b = a + nv + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
    geo.setIndex(idx);
    return geo;
  }
  function fillGrid(geo, layer, nu, nv, s, colorFn) {
    const P = geo.attributes.position.array, Cc = geo.attributes.color.array, p = V(0, 0, 0);
    let n = 0;
    for (let i = 0; i <= nu; i++) for (let j = 0; j <= nv; j++, n += 3) {
      lv(layer, (i / nu) * U_MAX, (j / nv) * TAU, s, p);
      P[n] = p.x; P[n + 1] = p.y; P[n + 2] = p.z;
      if (colorFn) colorFn(i / nu, j / nv, Cc, n);
    }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
    geo.computeVertexNormals();
  }

  const M = {
    endo: new THREE.MeshStandardMaterial({ roughness: 0.55, side: THREE.DoubleSide, transparent: true }),
    epi: new THREE.MeshPhysicalMaterial({ roughness: 0.35, clearcoat: 0.4, vertexColors: true, transparent: true, side: THREE.DoubleSide }),
    rim: new THREE.MeshStandardMaterial({ roughness: 0.6, transparent: true, side: THREE.DoubleSide }),
    wire: new THREE.LineBasicMaterial({ transparent: true }),
    marker: new THREE.MeshBasicMaterial({ transparent: true }),
    loop: new THREE.LineBasicMaterial({ transparent: true }),
    contour: new THREE.LineBasicMaterial({ transparent: true }),
    flow: new THREE.LineBasicMaterial({ vertexColors: true, transparent: true }),
    arrows: new THREE.LineBasicMaterial({ vertexColors: true, transparent: true }),
    slice: new THREE.MeshBasicMaterial({ transparent: true, side: THREE.DoubleSide, depthWrite: false }),
    sliceEdge: new THREE.LineBasicMaterial({ transparent: true }),
    ring: new THREE.LineBasicMaterial({ transparent: true }),
    pts: new THREE.PointsMaterial({ size: 0.045, vertexColors: true, transparent: true, depthWrite: false }),
    recon: new THREE.MeshStandardMaterial({ roughness: 0.45, flatShading: true, transparent: true }),
    reconSmooth: new THREE.MeshStandardMaterial({ roughness: 0.4, transparent: true }),
  };

  const endoGeo = gridGeo(NU, NV), epiGeo = gridGeo(NU, NV);
  const endo = new THREE.Mesh(endoGeo, M.endo);
  const epi = new THREE.Mesh(epiGeo, M.epi);
  epi.renderOrder = 2;
  // base rim joining the two walls
  const rimGeo = new THREE.BufferGeometry();
  rimGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((NV + 1) * 2 * 3), 3));
  { const idx = []; for (let j = 0; j < NV; j++) { const a = j * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); } rimGeo.setIndex(idx); }
  const rimMesh = new THREE.Mesh(rimGeo, M.rim);
  // FE mesh lines on the epicardium
  const WU = 9, WV = 16;
  const wireGeo = new THREE.BufferGeometry();
  const wireCount = (WU * (NV) + WV * NU) * 2;
  wireGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(wireCount * 3), 3));
  const wire = new THREE.LineSegments(wireGeo, M.wire);
  const heart = new THREE.Group();
  heart.add(endo, rimMesh, epi, wire);
  root.add(heart);

  // Lagrangian material points and their periodic trajectories (in reference-free space)
  const MK = [];
  for (let i = 0; i < 4; i++) for (let j = 0; j < 7; j++) MK.push([(0.3 + 0.2 * i) * U_MAX, (j / 7) * TAU + i * 0.4]);
  const markerGeo = new THREE.SphereGeometry(0.028, 10, 8);
  const markers = MK.map(() => { const m = new THREE.Mesh(markerGeo, M.marker); heart.add(m); return m; });
  const loops = MK.map(([u, v]) => {
    const pts = [];
    for (let k = 0; k <= 40; k++) pts.push(lv(1, u, v, 0.5 - 0.5 * Math.cos((k / 40) * TAU), V(0, 0, 0)).multiplyScalar(1.012));
    const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), M.loop);
    heart.add(l);
    return l;
  });

  // ── Tri-planar echo ────────────────────────────────────
  function echoTexture(seed) {
    const S = 256, c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d'), img = g.createImageData(S, S);
    let x = seed * 9301 + 49297;
    const rnd = () => ((x = (x * 9301 + 49297) % 233280) / 233280);
    for (let py = 0; py < S; py++) for (let px = 0; px < S; px++) {
      const dx = px - S / 2, dy = S - 6 - py, r = Math.hypot(dx, dy), ang = Math.atan2(dx, dy);
      const i = (py * S + px) * 4;
      const inside = r < S - 12 && Math.abs(ang) < 0.72 && dy > 0;
      const v = 18 + 70 * Math.pow(rnd(), 3) * (1 - r / S * 0.5);
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = inside ? 235 * clamp((0.72 - Math.abs(ang)) * 30, 0, 1) : 0;
    }
    g.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }
  const PLANE_W = 2.5, APEX_Y = -1.66 + Y_OFF;
  const ANG = [0, Math.PI / 3, (2 * Math.PI) / 3];
  const planes = ANG.map((a, k) => {
    const mat = new THREE.MeshBasicMaterial({ map: echoTexture(k + 1), transparent: true, side: THREE.DoubleSide, depthWrite: false });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(PLANE_W, PLANE_W), mat);
    m.rotation.y = -a;
    m.position.y = APEX_Y + PLANE_W / 2;
    root.add(m);
    return m;
  });
  // contours of both walls in each plane (the ventricle is axisymmetric, so the in-plane
  // section uses the untwisted shape; twist is out-of-plane motion that a single plane misses)
  const CN = 40;
  const contours = [];
  ANG.forEach(a => [0, 1].forEach(layer => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((CN * 2 + 2) * 3), 3));
    const l = new THREE.Line(geo, M.contour);
    l.renderOrder = 3;
    contours.push({ a, layer, l });
    root.add(l);
  }));
  const FLOW_U = [0.18, 0.3, 0.42, 0.54, 0.66, 0.78, 0.9];
  const flowCount = ANG.length * 2 * FLOW_U.length * 2;
  const flowGeo = new THREE.BufferGeometry();
  flowGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(flowCount * 3 * 2 * 3), 3));
  flowGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(flowCount * 3 * 2 * 3), 3));
  const flow = new THREE.LineSegments(flowGeo, M.flow);
  flow.renderOrder = 4;
  flow.frustumCulled = false;
  root.add(flow);

  // ── 3D displacement vectors ────────────────────────────
  const AU = 8, AV = 18;
  const arrowGeo = new THREE.BufferGeometry();
  arrowGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(AU * AV * 2 * 3), 3));
  arrowGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(AU * AV * 2 * 3), 3));
  const arrows = new THREE.LineSegments(arrowGeo, M.arrows);
  arrows.frustumCulled = false;
  heart.add(arrows);

  // perceptual colormap (reversed magma): pale at rest, deep where the tissue moves most
  const VIR = ['#fcf3dd', '#fdb47a', '#e8595f', '#9c2c7f', '#3b0f70'].map(c => new THREE.Color(c));
  const cmap = (t, out) => {
    t = clamp(t, 0, 1) * 4;
    const i = Math.min(3, Math.floor(t));
    return out.copy(VIR[i]).lerp(VIR[i + 1], t - i);
  };

  // ── NeuralMRI ──────────────────────────────────────────
  const mri = new THREE.Group();
  root.add(mri);
  const SLICE_U = [0.16, 0.28, 0.4, 0.52, 0.64, 0.76, 0.9].map(f => f * U_MAX);
  const slices = SLICE_U.map(u => {
    const g = new THREE.Group();
    const y = lv(1, u, 0, 0, V(0, 0, 0)).y;
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2.3, 2.3), M.slice);
    quad.rotation.x = -Math.PI / 2;
    quad.position.y = y;
    const edge = new THREE.LineSegments(new THREE.EdgesGeometry(quad.geometry), M.sliceEdge);
    edge.rotation.copy(quad.rotation);
    edge.position.copy(quad.position);
    g.add(quad, edge);
    [0, 1].forEach(layer => {
      const pts = [];
      for (let k = 0; k <= 64; k++) pts.push(lv(layer, u, (k / 64) * TAU, 0, V(0, 0, 0), false));
      g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), M.ring));
    });
    mri.add(g);
    return g;
  });
  // two long-axis slice contours
  [0, Math.PI / 2].forEach(a => [0, 1].forEach(layer => {
    const pts = [];
    for (let k = CN; k >= 0; k--) pts.push(lv(layer, (k / CN) * U_MAX, a, 0, V(0, 0, 0), false));
    for (let k = 0; k <= CN; k++) pts.push(lv(layer, (k / CN) * U_MAX, a + Math.PI, 0, V(0, 0, 0), false));
    mri.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), M.ring));
  }));

  // hierarchical occupancy samples: a coarse grid, then dense samples near the surface
  function occupied(p) {
    const y = p.y - Y_OFF, r = Math.hypot(p.x, p.z);
    const e = (d) => (r / d.a) ** 2 + (y / d.c) ** 2;
    return e(DIMS[1]) <= 1 && e(DIMS[0]) > 1 && p.y <= REST_BASE;
  }
  function pointCloud(list) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(list.flatMap(p => [p.x, p.y, p.z]), 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(list.length * 3), 3));
    geo.userData.occ = list.map(occupied);
    const pts = new THREE.Points(geo, M.pts.clone());
    mri.add(pts);
    return pts;
  }
  const coarse = [];
  for (let i = 0; i < 9; i++) for (let j = 0; j < 12; j++) for (let k = 0; k < 9; k++)
    coarse.push(V(-1.15 + i * 0.2875, -1.75 + Y_OFF + j * 0.21, -1.15 + k * 0.2875));
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const fine = [];
  for (let n = 0; n < 1800; n++) {
    const p = lv(rnd() < 0.5 ? 0 : 1, Math.acos(1 - rnd() * (1 - Math.cos(U_MAX))), rnd() * TAU, 0, V(0, 0, 0), false);
    fine.push(p.add(V(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).multiplyScalar(0.18)));
  }
  const coarsePts = pointCloud(coarse), finePts = pointCloud(fine);
  coarsePts.material.size = 0.07;

  // reconstruction, coarse → fine
  const LEVELS = [[4, 6], [7, 12], [14, 24], [36, 64]];
  const recon = LEVELS.map(([nu, nv], i) => {
    const geo = gridGeo(nu, nv);
    fillGrid(geo, 1, nu, nv, 0);
    const m = new THREE.Mesh(geo, i < 3 ? M.recon : M.reconSmooth);
    mri.add(m);
    return m;
  });

  // ── Theme ──────────────────────────────────────────────
  const COL = {};
  function applyTheme() {
    const cs = getComputedStyle(document.documentElement);
    const accent = new THREE.Color(cs.getPropertyValue('--accent').trim() || '#1f3fb8');
    const ink3 = new THREE.Color(cs.getPropertyValue('--ink-3').trim() || '#646a75');
    const dark = darkMQ.matches;
    COL.muscle = new THREE.Color(dark ? '#d9777c' : '#c4555c');
    COL.epi = new THREE.Color(dark ? '#e6a3a3' : '#e9a8a4');
    COL.accent = accent;
    COL.gray = ink3.clone();
    M.endo.color.copy(COL.muscle);
    M.rim.color.copy(COL.muscle).multiplyScalar(0.85);
    M.wire.color.copy(dark ? new THREE.Color('#f4d0cf') : new THREE.Color('#8a3b40'));
    M.marker.color.copy(accent);
    M.loop.color.copy(accent);
    M.contour.color.set(dark ? '#ffffff' : '#ffe9c7');
    // dark speckle vanishes on a dark page; let it glow additively instead
    planes.forEach(p => { p.material.blending = dark ? THREE.AdditiveBlending : THREE.NormalBlending; p.material.needsUpdate = true; });
    M.slice.color.copy(accent);
    M.sliceEdge.color.copy(accent);
    M.ring.color.copy(accent);
    M.recon.color.copy(accent).lerp(new THREE.Color('#ffffff'), dark ? 0.1 : 0.25);
    M.reconSmooth.color.copy(M.recon.color);
    [coarsePts, finePts].forEach(pc => {
      const col = pc.geometry.attributes.color.array;
      const faint = ink3.clone().lerp(new THREE.Color(cs.getPropertyValue('--bg').trim() || '#fbfaf7'), 0.55);
      pc.geometry.userData.occ.forEach((o, i) => (o ? accent : faint).toArray(col, i * 3));
      pc.geometry.attributes.color.needsUpdate = true;
    });
  }

  // ── Frame ──────────────────────────────────────────────
  const steps = [...fig.querySelectorAll('.c3d-steps li')];
  const caption = fig.querySelector('.c3d-caption');
  const metric = fig.querySelector('.c3d-metric');
  const bar = fig.querySelector('.c3d-bar');
  const tmpA = V(0, 0, 0), tmpB = V(0, 0, 0), tmpC = new THREE.Color();
  let lastStage = -1, W = 1, H = 1;

  function beatS(t) {
    const ph = (t / BEAT) % 1;
    if (ph < 0.35) return smooth(ph / 0.35);
    if (ph < 0.62) return 1 - smooth((ph - 0.35) / 0.27);
    return 0;
  }

  function render(t) {
    let u = ((t % CYCLE) + CYCLE) % CYCLE, k = 0;
    while (u >= STAGES[k].dur) { u -= STAGES[k].dur; k++; }
    const prev = (k + 3) % 4, mix = smooth(clamp(u / 0.7, 0, 1));
    const val = key => lerp(TGT[key][prev], TGT[key][k], mix);

    const amp = val('beat');
    const s = beatS(t) * amp;
    const heartA = val('heart'), heat = val('heat');

    // walls
    fillGrid(endoGeo, 0, NU, NV, s);
    fillGrid(epiGeo, 1, NU, NV, s, (fu, fv, Cc, n) => {
      if (heat < 0.01) { COL.epi.toArray(Cc, n); return; }
      const uu = fu * U_MAX, vv = fv * TAU;
      const d = lv(1, uu, vv, s, tmpA).distanceTo(lv(1, uu, vv, 0, tmpB));
      cmap(d / 0.3, tmpC).lerp(COL.epi, 1 - heat).toArray(Cc, n);
    });
    M.endo.opacity = heartA;
    M.rim.opacity = heartA;
    M.epi.opacity = val('epi') * heartA;
    M.epi.depthWrite = M.epi.opacity > 0.9;
    heart.visible = heartA > 0.01;

    // base rim
    { const P = rimGeo.attributes.position.array;
      for (let j = 0; j <= NV; j++) {
        lv(0, U_MAX, (j / NV) * TAU, s, tmpA).toArray(P, j * 6);
        lv(1, U_MAX, (j / NV) * TAU, s, tmpA).toArray(P, j * 6 + 3);
      }
      rimGeo.attributes.position.needsUpdate = true;
      rimGeo.computeVertexNormals(); }

    // FE wireframe
    { const P = wireGeo.attributes.position.array; let n = 0;
      const push = p => { P[n++] = p.x * 1.004; P[n++] = p.y; P[n++] = p.z * 1.004; };
      for (let i = 1; i <= WU; i++) { const uu = (i / WU) * U_MAX;
        for (let j = 0; j < NV; j++) { push(lv(1, uu, (j / NV) * TAU, s, tmpA)); push(lv(1, uu, ((j + 1) / NV) * TAU, s, tmpA)); } }
      for (let j = 0; j < WV; j++) { const vv = (j / WV) * TAU;
        for (let i = 0; i < NU; i++) { push(lv(1, (i / NU) * U_MAX, vv, s, tmpA)); push(lv(1, ((i + 1) / NU) * U_MAX, vv, s, tmpA)); } }
      wireGeo.attributes.position.needsUpdate = true; }
    M.wire.opacity = heartA * (0.5 * (1 - heat) + 0.12) * (1 - 0.5 * val('planes'));

    // material points
    const mA = val('markers') * heartA;
    MK.forEach(([uu, vv], i) => { lv(1, uu, vv, s, markers[i].position).multiplyScalar(1.012); markers[i].visible = mA > 0.01; loops[i].visible = mA > 0.01; });
    M.marker.opacity = mA;
    M.loop.opacity = 0.55 * mA;

    // echo planes, contours and in-plane optical flow
    const pA = val('planes');
    planes.forEach(p => { p.visible = pA > 0.01; p.material.opacity = 0.42 * pA; });
    contours.forEach(({ a, layer, l }) => {
      l.visible = pA > 0.01;
      const P = l.geometry.attributes.position.array; let n = 0;
      for (let i = CN; i >= 0; i--) { lv(layer, (i / CN) * U_MAX, a, s, tmpA, false).toArray(P, n); n += 3; }
      for (let i = 0; i <= CN; i++) { lv(layer, (i / CN) * U_MAX, a + Math.PI, s, tmpA, false).toArray(P, n); n += 3; }
      l.geometry.attributes.position.needsUpdate = true;
    });
    M.contour.opacity = pA;
    flow.visible = pA > 0.01;
    M.flow.opacity = pA;
    if (flow.visible) {
      const P = flowGeo.attributes.position.array, Cc = flowGeo.attributes.color.array;
      const s2 = beatS(t + 0.1) * amp;
      let n = 0;
      const seg = (a, b, c) => { a.toArray(P, n); c.toArray(Cc, n); n += 3; b.toArray(P, n); c.toArray(Cc, n); n += 3; };
      ANG.forEach(a => [a, a + Math.PI].forEach(side => FLOW_U.forEach(f => [0.3, 0.7].forEach(w => {
        const uu = f * U_MAX;
        const p0 = lv(0, uu, side, s, V(0, 0, 0), false).lerp(lv(1, uu, side, s, tmpA, false), w);
        const p1 = lv(0, uu, side, s2, V(0, 0, 0), false).lerp(lv(1, uu, side, s2, tmpA, false), w);
        const d = p1.clone().sub(p0).multiplyScalar(4);
        const len = d.length();
        const e1 = V(Math.cos(a), 0, Math.sin(a));
        tmpC.setHSL((Math.atan2(d.y, d.dot(e1)) / TAU + 1) % 1, 0.85, 0.55);
        const tip = p0.clone().add(d);
        if (len < 0.004) { seg(p0, p0, tmpC); seg(p0, p0, tmpC); seg(p0, p0, tmpC); return; }
        const back = d.clone().normalize().multiplyScalar(-Math.min(0.06, len * 0.45));
        const side2 = V(0, 1, 0).cross(e1).normalize();
        const perp = side2.clone().cross(d).normalize().multiplyScalar(Math.min(0.03, len * 0.25));
        seg(p0, tip, tmpC);
        seg(tip, tip.clone().add(back).add(perp), tmpC);
        seg(tip, tip.clone().add(back).sub(perp), tmpC);
      }))));
      flowGeo.attributes.position.needsUpdate = true;
      flowGeo.attributes.color.needsUpdate = true;
    }

    // 3D displacement vectors
    const aA = val('arrows') * heartA;
    arrows.visible = aA > 0.01;
    M.arrows.opacity = aA;
    if (arrows.visible) {
      const P = arrowGeo.attributes.position.array, Cc = arrowGeo.attributes.color.array;
      let n = 0;
      for (let i = 0; i < AU; i++) for (let j = 0; j < AV; j++) {
        const uu = (0.2 + 0.8 * (i + 0.5) / AU) * U_MAX, vv = (j / AV) * TAU + i * 0.17;
        const cur = lv(1, uu, vv, s, V(0, 0, 0)), ref = lv(1, uu, vv, 0, tmpB);
        const d = cur.clone().sub(ref);
        const out = V(cur.x, 0, cur.z).normalize().multiplyScalar(0.04);
        const a0 = cur.clone().add(out), a1 = a0.clone().add(d.multiplyScalar(1.6));
        cmap(d.length() / 1.6 / 0.3, tmpC);
        a0.toArray(P, n); tmpC.toArray(Cc, n); n += 3;
        a1.toArray(P, n); tmpC.toArray(Cc, n); n += 3;
      }
      arrowGeo.attributes.position.needsUpdate = true;
      arrowGeo.attributes.color.needsUpdate = true;
    }

    // NeuralMRI: slices → samples → coarse-to-fine surface
    const mA2 = val('mri');
    mri.visible = mA2 > 0.01;
    if (mri.visible) {
      const l = k === 3 ? u : STAGES[3].dur;
      slices.forEach((g, i) => { g.visible = l > 0.25 + i * 0.16; });
      M.slice.opacity = 0.06 * mA2;
      M.sliceEdge.opacity = 0.35 * mA2;
      M.ring.opacity = 0.95 * mA2 * (1 - 0.6 * smooth(clamp((l - 4.2) / 0.8, 0, 1)));
      const ptsOut = 1 - smooth(clamp((l - 4.0) / 0.8, 0, 1));
      coarsePts.material.opacity = smooth(clamp((l - 1.4) / 0.5, 0, 1)) * (1 - smooth(clamp((l - 2.6) / 0.6, 0, 1)) * 0.7) * ptsOut * mA2;
      finePts.material.opacity = smooth(clamp((l - 2.3) / 0.6, 0, 1)) * ptsOut * mA2 * 0.9;
      const lvl = clamp(Math.floor((l - 3.1) / 0.55), -1, 3);
      recon.forEach((m, i) => { m.visible = i === lvl; });
      const rA = smooth(clamp((l - 3.1) / 0.4, 0, 1)) * mA2;
      M.recon.opacity = M.reconSmooth.opacity = 0.92 * rA;
    }

    // camera orbit
    const th = t * 0.22 + 0.6;
    const R = W < 560 ? 6.4 : 5.6;
    cam.position.set(Math.sin(th) * R, 1.3, Math.cos(th) * R);
    cam.lookAt(0, 0.05, 0);
    renderer.render(scene, cam);

    if (k !== lastStage) {
      steps.forEach((li, i) => li.classList.toggle('on', i === k));
      caption.textContent = STAGES[k].cap;
      metric.textContent = STAGES[k].metric;
      metric.hidden = !STAGES[k].metric;
      bar.hidden = k !== 2;
      lastStage = k;
    }
    steps[k].style.setProperty('--p', (u / STAGES[k].dur).toFixed(3));
  }

  function resize() {
    W = Math.max(1, stage.clientWidth);
    H = Math.max(1, stage.clientHeight);
    renderer.setSize(W, H, false);
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    cam.aspect = W / H;
    cam.updateProjectionMatrix();
    draw();
  }

  // ── Loop, visibility, pause ────────────────────────────
  const st = { t: 11.2, last: null, running: false, visible: false, paused: false };
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
  fig.classList.add('is-ready');
  resize();
  new ResizeObserver(resize).observe(stage);
  new IntersectionObserver(([e]) => { st.visible = e.isIntersecting; update(); }, { rootMargin: '80px' }).observe(stage);
  darkMQ.addEventListener('change', () => { applyTheme(); draw(); });
  reduceMQ.addEventListener('change', update);
  const btn = fig.querySelector('.viz-toggle');
  if (btn) btn.addEventListener('click', () => {
    st.paused = !st.paused;
    btn.setAttribute('aria-pressed', st.paused);
    btn.setAttribute('aria-label', st.paused ? 'Play animation' : 'Pause animation');
    btn.innerHTML = `<i class="bi bi-${st.paused ? 'play' : 'pause'}-fill" aria-hidden="true"></i>`;
    update();
  });
};
