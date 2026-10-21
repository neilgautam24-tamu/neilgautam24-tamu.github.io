/*
 * 3D illustration for the C2BL research (EchoNet + NeuralMRI).
 * Loaded lazily by viz.js, which passes in three.js (and RoomEnvironment) from the CDN.
 *
 * An anatomical left ventricle: D-shaped cross-section, tilted base, trabeculated
 * endocardium with two papillary muscles, coronary vessels and epicardial fat, and a
 * cutaway that exposes the wall with its helical fibre architecture.
 *
 * Four stages on a loop:
 *   1. FE simulation    beating ventricle; fibre streamlines, element edges, Lagrangian points
 *   2. Tri-planar echo  three apical planes show the wall contour and in-plane optical flow
 *   3. 3D motion        full 3D displacement, as a heatmap and vectors on the surface
 *   4. MRI → surface    sparse MRI slices → hierarchical occupancy samples → coarse-to-fine surface
 */
window.mountCardiac3D = function (fig, THREE, addons) {
  'use strict';
  addons = addons || {};

  const reduceMQ = matchMedia('(prefers-reduced-motion: reduce)');
  const darkMQ = matchMedia('(prefers-color-scheme: dark)');
  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, s) => a + (b - a) * s;
  const smooth = s => s * s * (3 - 2 * s);
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const gauss = (x, w) => Math.exp(-(x * x) / (w * w));
  const angDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

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
    epi:     [1, 0.22, 1, 0],
    heat:    [0, 0, 1, 0],
    markers: [1, 0, 0, 0],
    fibres:  [1, 0, 0, 0],
    vessels: [1, 0.2, 0, 0],
    planes:  [0, 1, 0, 0],
    arrows:  [0, 0, 1, 0],
    beat:    [1, 1, 1, 0],
    mri:     [0, 0, 0, 1],
  };

  // ── Renderer ───────────────────────────────────────────
  const stage = fig.querySelector('.c3d-stage');
  const shared = window.vizShared(THREE), renderer = shared.renderer; // one WebGL context for all scenes
  const canvas = document.createElement('canvas');
  const ctx2d = canvas.getContext('2d');
  canvas.className = 'c3d-canvas';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'Animated 3D illustration of a beating left ventricle with a cutaway showing the wall, its muscle fibres and papillary muscles: finite-element material points trace their motion, three echo planes show optical flow, the surface is colored by 3D displacement, and finally a surface is reconstructed coarse-to-fine from sparse MRI slices.');
  stage.prepend(canvas);

  const scene = new THREE.Scene();
  if (addons.RoomEnvironment) {
    scene.environment = shared.env(addons.RoomEnvironment);
    scene.environmentIntensity = 0.55;
  }
  const cam = new THREE.PerspectiveCamera(30, 1.6, 0.1, 50);
  const root = new THREE.Group();
  root.rotation.z = 0.3;
  scene.add(root);

  scene.add(new THREE.HemisphereLight(0xfff4ee, 0x5a4440, 0.9));
  const key = new THREE.DirectionalLight(0xfff1e6, 2.6);
  key.position.set(2.5, 4.5, 4);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffd9cf, 0.7);
  fill.position.set(-4, 1, 2);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0xc8d6ff, 1.6);
  rim.position.set(-2, 3, -5);
  scene.add(rim);

  // ── Left-ventricle model ───────────────────────────────
  // (u, v): u ∈ [0, U_MAX] apex → base, v ∈ [0, 2π) around the long axis.
  // s ∈ [0, 1] is contraction: wall thickening, base descent and apex-to-base twist.
  const U_MAX = 0.6 * Math.PI, NU = 72, NV = 176;
  const DIMS = [{ a: 0.62, c: 1.32, k: 0.3 }, { a: 0.95, c: 1.55, k: 0.08 }];
  const Y_OFF = 0.53;                // recentre the heart vertically
  const V_CUT = Math.PI / 2 - 0.6;   // cutaway centred on the side that faces the camera
  const CUT_HALF = 0.62;
  const V0 = V_CUT + CUT_HALF, V_SPAN = TAU - 2 * CUT_HALF;
  const vWall = f => V0 + f * V_SPAN; // wall parameter (skips the cutaway wedge)
  const inCut = v => Math.abs(angDiff(v, V_CUT)) < CUT_HALF;
  const hOf = u => (1 - Math.cos(u)) / (1 - Math.cos(U_MAX));
  const uOf = h => Math.acos(1 - h * (1 - Math.cos(U_MAX)));
  const PAP = [V_CUT + 0.15, V_CUT + 2.35]; // papillary muscles (one visible through the cut)

  function lv(layer, u, v, s, out, twist = true) {
    const d = DIMS[layer];
    const h = hOf(u);
    // D-shaped section: flatter septum (v ≈ π + V_CUT), fuller free wall
    let a = d.a * (1 - d.k * s) * (1 + 0.05 * Math.cos(v - V_CUT) - 0.035 * Math.cos(2 * (v - V_CUT)));
    if (layer === 0) {
      // trabeculae carneae: fine longitudinal ridges, strongest toward the apex
      const ridge = Math.pow(0.5 + 0.5 * Math.cos(11 * v + 4 * h), 6) + 0.6 * Math.pow(0.5 + 0.5 * Math.cos(17 * v - 3 * h + 1), 8);
      a *= 1 - 0.045 * ridge * (1 - h) ** 0.6 * (h > 0.04 ? 1 : h / 0.04);
      // two papillary muscles bulging into the cavity between the apical third and mid-ventricle
      const band = smooth(clamp((h - 0.12) / 0.12, 0, 1)) * (1 - smooth(clamp((h - 0.5) / 0.18, 0, 1)));
      PAP.forEach(vp => { a *= 1 - 0.3 * band * gauss(angDiff(v, vp), 0.2) * (1 + 0.3 * s); });
    } else {
      a *= 1 + 0.01 * Math.sin(5 * v + 6 * h) * Math.sin(Math.PI * h);
    }
    const vv = twist ? v + 0.24 * s * (h - 0.35) : v;
    const r = a * Math.sin(u);
    const y0 = -d.c * Math.cos(u);
    // tilted, non-planar base (the mitral–aortic annulus is not flat)
    const tilt = Math.pow(h, 5) * (0.1 * Math.cos(v - V_CUT - 0.8) + 0.03 * Math.cos(2 * v));
    const y = -d.c + (y0 + d.c) * (1 - 0.13 * s) + tilt;
    return out.set(r * Math.cos(vv), y + Y_OFF, r * Math.sin(vv));
  }
  const REST_BASE = lv(1, U_MAX, 0, 0, V(0, 0, 0)).y;

  function gridGeo(nu, nv, uv = false) {
    const geo = new THREE.BufferGeometry();
    const n = (nu + 1) * (nv + 1);
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    if (uv) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    const idx = [];
    for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
      const a = i * (nv + 1) + j, b = a + nv + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
    geo.setIndex(idx);
    return geo;
  }
  function fillGrid(geo, layer, nu, nv, s, colorFn, vmap = f => f * TAU) {
    const P = geo.attributes.position.array, Cc = geo.attributes.color.array, p = V(0, 0, 0);
    let n = 0, k = 0;
    for (let i = 0; i <= nu; i++) for (let j = 0; j <= nv; j++, n += 3, k++) {
      lv(layer, (i / nu) * U_MAX, vmap(j / nv), s, p);
      P[n] = p.x; P[n + 1] = p.y; P[n + 2] = p.z;
      if (colorFn) colorFn(i / nu, j / nv, Cc, n, k);
    }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
    geo.computeVertexNormals();
  }

  // striated myocardium texture for cut surfaces: fibre angle rotates through the wall
  // (+60° at the endocardium → −60° at the epicardium), as in FE heart models
  function fibreTexture() {
    const S = 256, c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d'), img = g.createImageData(S, S);
    let x = 7;
    const rnd = () => ((x = (x * 16807) % 2147483647) / 2147483647);
    for (let py = 0; py < S; py++) for (let px = 0; px < S; px++) {
      const t = px / (S - 1);                        // 0 = endocardium, 1 = epicardium
      const th = (60 - 120 * t) * Math.PI / 180;
      const q = (px * Math.sin(th) + py * Math.cos(th)) * 0.55;
      const stripe = 0.5 + 0.5 * Math.sin(q + 0.6 * Math.sin(py * 0.05));
      const n = rnd();
      const base = [148, 38, 46], hi = [196, 74, 78], endo = [214, 120, 122];
      let col = base.map((b, i) => b + (hi[i] - b) * stripe * 0.55 + (n - 0.5) * 14);
      const e = Math.max(0, 1 - t / 0.07);              // thin glistening endocardial layer
      col = col.map((cc, i) => cc + (endo[i] - cc) * e * 0.7);
      const i4 = (py * S + px) * 4;
      img.data[i4] = col[0]; img.data[i4 + 1] = col[1]; img.data[i4 + 2] = col[2]; img.data[i4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return tex;
  }

  const M = {
    endo: new THREE.MeshPhysicalMaterial({ color: 0xc6535b, roughness: 0.32, clearcoat: 0.9, clearcoatRoughness: 0.18, sheen: 0.4, sheenColor: 0xffb0a8, side: THREE.DoubleSide, transparent: true }),
    epi: new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.4, clearcoat: 0.75, clearcoatRoughness: 0.22, sheen: 0.5, sheenColor: 0xffb4a6, sheenRoughness: 0.5, transparent: true, side: THREE.DoubleSide }),
    cut: new THREE.MeshStandardMaterial({ map: fibreTexture(), roughness: 0.55, side: THREE.DoubleSide, transparent: true }),
    artery: new THREE.MeshPhysicalMaterial({ color: 0x8e1a22, roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.15, transparent: true }),
    vein: new THREE.MeshPhysicalMaterial({ color: 0x4a2f5c, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.15, transparent: true }),
    fibre: new THREE.LineBasicMaterial({ transparent: true, depthWrite: false }),
    elem: new THREE.LineBasicMaterial({ transparent: true, depthWrite: false }),
    marker: new THREE.MeshStandardMaterial({ roughness: 0.25, metalness: 0.1, transparent: true }),
    loop: new THREE.LineBasicMaterial({ transparent: true }),
    contour: new THREE.LineBasicMaterial({ transparent: true }),
    flow: new THREE.LineBasicMaterial({ vertexColors: true, transparent: true }),
    arrows: new THREE.LineBasicMaterial({ vertexColors: true, transparent: true }),
    slice: new THREE.MeshBasicMaterial({ transparent: true, side: THREE.DoubleSide, depthWrite: false }),
    sliceEdge: new THREE.LineBasicMaterial({ transparent: true }),
    ring: new THREE.LineBasicMaterial({ transparent: true }),
    pts: new THREE.PointsMaterial({ size: 0.045, vertexColors: true, transparent: true, depthWrite: false }),
    recon: new THREE.MeshStandardMaterial({ roughness: 0.45, flatShading: true, transparent: true }),
    reconSmooth: new THREE.MeshPhysicalMaterial({ roughness: 0.35, clearcoat: 0.5, transparent: true }),
  };

  const heart = new THREE.Group();
  root.add(heart);
  const endoGeo = gridGeo(NU, NV), epiGeo = gridGeo(NU, NV);
  const endo = new THREE.Mesh(endoGeo, M.endo);
  const epi = new THREE.Mesh(epiGeo, M.epi);
  epi.renderOrder = 2;
  heart.add(endo, epi);

  // epicardial base colours: mottled muscle with fat along the coronary grooves (static)
  const grooveV = h => V_CUT - 1.02 + 0.22 * (1 - h);             // anterior interventricular groove (LAD), on the visible wall
  const PDA_V = V_CUT - 3.3;                                     // posterior groove
  const AV_H = 0.93;                                             // atrioventricular groove (LCx)
  const epiBase = new Float32Array((NU + 1) * (NV + 1) * 3);
  {
    const muscle = new THREE.Color(0x9c2f36), deep = new THREE.Color(0x7d2229), fat = new THREE.Color(0xe3c27f), c = new THREE.Color();
    let k = 0;
    for (let i = 0; i <= NU; i++) for (let j = 0; j <= NV; j++, k++) {
      const h = hOf((i / NU) * U_MAX), v = vWall(j / NV);
      const w = Math.max(
        gauss(angDiff(v, grooveV(h)), 0.16) * (0.25 + 0.75 * h),
        gauss(angDiff(v, PDA_V), 0.14) * (0.2 + 0.6 * h),
        gauss(h - AV_H, 0.06) * 0.85,
      );
      const mott = 0.5 + 0.5 * Math.sin(13 * v + 9 * h) * Math.sin(7 * v - 11 * h + 2);
      c.copy(muscle).lerp(deep, 0.35 * mott).lerp(fat, clamp(w * 1.1, 0, 0.85));
      c.toArray(epiBase, k * 3);
    }
  }

  // cut faces (two, at the edges of the wedge) and the base rim, both showing fibre texture
  const NT = 8;
  const cutGeos = [0, 1].map(() => gridGeo(NU, NT, true));
  cutGeos.forEach(g => {
    const UV = g.attributes.uv.array; let n = 0;
    for (let i = 0; i <= NU; i++) for (let j = 0; j <= NT; j++) { UV[n++] = j / NT; UV[n++] = hOf((i / NU) * U_MAX); }
  });
  cutGeos.forEach(g => heart.add(new THREE.Mesh(g, M.cut)));
  const rimGeo = gridGeo(1, NV, true);
  { const UV = rimGeo.attributes.uv.array; let n = 0;
    for (let i = 0; i <= 1; i++) for (let j = 0; j <= NV; j++) { UV[n++] = i; UV[n++] = (j / NV) * 6 % 1; } }
  const rimMesh = new THREE.Mesh(rimGeo, M.cut);
  heart.add(rimMesh);

  // FE element edges on the cut faces (hexahedral layers through the wall)
  const EU = 12, ET = 4;
  const elemGeo = new THREE.BufferGeometry();
  elemGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(2 * ((ET + 1) * NU + (EU + 1) * NT) * 2 * 3), 3));
  const elem = new THREE.LineSegments(elemGeo, M.elem);
  elem.frustumCulled = false;
  heart.add(elem);

  // epicardial fibre streamlines (helix angle ≈ −60°)
  const FIB = 26, FSEG = 40;
  const fibreGeo = new THREE.BufferGeometry();
  fibreGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(FIB * FSEG * 2 * 3), 3));
  const fibres = new THREE.LineSegments(fibreGeo, M.fibre);
  fibres.frustumCulled = false;
  heart.add(fibres);

  // coronary vessels: [material, radius, list of (h, v)]
  const path = (n, f) => Array.from({ length: n }, (_, k) => f(k / (n - 1)));
  const VESSELS = [
    [M.artery, 0.026, path(18, q => [1 - 0.93 * q, grooveV(1 - 0.93 * q)])],                         // LAD
    [M.artery, 0.022, path(16, q => [AV_H + 0.02, grooveV(1) - 0.05 - 2.3 * q])],                   // LCx (away from the cut)
    [M.artery, 0.016, path(10, q => [0.72 - 0.38 * q, grooveV(0.72) + 0.05 + 0.2 * q])],            // diagonal (toward the cut)
    [M.artery, 0.014, path(10, q => [0.48 - 0.26 * q, grooveV(0.48) + 0.05 + 0.16 * q])],           // 2nd diagonal
    [M.artery, 0.016, path(10, q => [AV_H - 0.02 - 0.55 * q, grooveV(1) - 1.25 - 0.15 * q])],      // obtuse marginal
    [M.artery, 0.018, path(14, q => [AV_H - 0.88 * q, PDA_V])],                                     // PDA
    [M.vein, 0.017, path(16, q => [0.97 - 0.85 * q, grooveV(0.97 - 0.85 * q) - 0.12])],             // great cardiac vein
  ];
  const vesselMeshes = VESSELS.map(([mat]) => { const m = new THREE.Mesh(new THREE.BufferGeometry(), mat); heart.add(m); return m; });

  // Lagrangian material points (outside the cutaway) and their periodic trajectories
  const MK = [];
  for (let i = 0; i < 4; i++) for (let j = 0; j < 9; j++) {
    const v = vWall((j + 0.5 + (i % 2) * 0.5) / 9.5);
    MK.push([(0.3 + 0.2 * i) * U_MAX, v]);
  }
  const markerGeo = new THREE.SphereGeometry(0.024, 16, 12);
  const markers = MK.map(() => { const m = new THREE.Mesh(markerGeo, M.marker); heart.add(m); return m; });
  const loops = MK.map(([u, v]) => {
    const pts = [];
    for (let k = 0; k <= 40; k++) pts.push(lv(1, u, v, 0.5 - 0.5 * Math.cos((k / 40) * TAU), V(0, 0, 0)).multiplyScalar(1.02));
    const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), M.loop);
    heart.add(l);
    return l;
  });

  // a point on the epicardium, pushed slightly outward (for vessels, fibres, markers)
  const onEpi = (h, v, s, lift, out) => {
    lv(1, uOf(h), v, s, out);
    const r = Math.hypot(out.x, out.z) || 1;
    out.x += (out.x / r) * lift; out.z += (out.z / r) * lift;
    return out;
  };

  // ── Bake the heartbeat into morph targets ──────────────
  // Every animated surface is a function of one contraction value s, so the relaxed (s = 0)
  // and contracted (s = 1) shapes are computed once and the GPU blends between them.
  const morphing = [];
  function bake(obj, fillAt, normals = true) {
    const geo = obj.geometry;
    fillAt(1); if (normals) geo.computeVertexNormals();
    const p1 = new THREE.Float32BufferAttribute(geo.attributes.position.array.slice(), 3);
    const n1 = normals ? new THREE.Float32BufferAttribute(geo.attributes.normal.array.slice(), 3) : null;
    fillAt(0); if (normals) geo.computeVertexNormals();
    geo.morphAttributes.position = [p1];
    if (n1) geo.morphAttributes.normal = [n1];
    if (obj.updateMorphTargets) obj.updateMorphTargets();
    obj.morphTargetInfluences = [0];
    obj.frustumCulled = false;
    morphing.push(obj);
  }
  const tA = V(0, 0, 0), tB = V(0, 0, 0);
  bake(endo, s => fillGrid(endoGeo, 0, NU, NV, s, null, vWall));
  bake(epi, s => fillGrid(epiGeo, 1, NU, NV, s, (fu, fv, Cc, n, idx) => { Cc[n] = epiBase[idx * 3]; Cc[n + 1] = epiBase[idx * 3 + 1]; Cc[n + 2] = epiBase[idx * 3 + 2]; }, vWall));
  // per-vertex displacement at full contraction, for the heatmap (|d(s)| ≈ s·|d(1)|)
  const DISP = new Float32Array((NU + 1) * (NV + 1));
  { const p0 = epiGeo.attributes.position.array, p1 = epiGeo.morphAttributes.position[0].array;
    for (let k = 0; k < DISP.length; k++) DISP[k] = Math.hypot(p1[k * 3] - p0[k * 3], p1[k * 3 + 1] - p0[k * 3 + 1], p1[k * 3 + 2] - p0[k * 3 + 2]); }
  heart.children.filter(o => cutGeos.includes(o.geometry)).forEach((m, f) => bake(m, s => {
    const g = cutGeos[f], P = g.attributes.position.array, vF = vWall(f); let n = 0;
    for (let i = 0; i <= NU; i++) {
      const uu = (i / NU) * U_MAX;
      lv(0, uu, vF, s, tA); lv(1, uu, vF, s, tB);
      for (let j = 0; j <= NT; j++) { const w = j / NT; P[n++] = lerp(tA.x, tB.x, w); P[n++] = lerp(tA.y, tB.y, w); P[n++] = lerp(tA.z, tB.z, w); }
    }
    g.attributes.position.needsUpdate = true;
  }));
  bake(rimMesh, s => {
    const P = rimGeo.attributes.position.array;
    for (let j = 0; j <= NV; j++) {
      lv(0, U_MAX, vWall(j / NV), s, tA).toArray(P, j * 3);
      lv(1, U_MAX, vWall(j / NV), s, tA).toArray(P, (NV + 1 + j) * 3);
    }
    rimGeo.attributes.position.needsUpdate = true;
  });
  bake(elem, s => {
    const P = elemGeo.attributes.position.array; let n = 0;
    const push = p => { P[n++] = p.x; P[n++] = p.y; P[n++] = p.z; };
    const at = (uu, vF, w) => { lv(0, uu, vF, s, tA); lv(1, uu, vF, s, tB); return tA.lerp(tB, w); };
    [vWall(0), vWall(1)].forEach(vF => {
      for (let e = 0; e <= ET; e++) for (let i = 0; i < NU; i++) { push(at((i / NU) * U_MAX, vF, e / ET)); push(at(((i + 1) / NU) * U_MAX, vF, e / ET)); }
      for (let e = 0; e <= EU; e++) for (let j = 0; j < NT; j++) { const uu = Math.max(0.02, e / EU) * U_MAX; push(at(uu, vF, j / NT)); push(at(uu, vF, (j + 1) / NT)); }
    });
    elemGeo.attributes.position.needsUpdate = true;
  }, false);
  bake(fibres, s => {
    const P = fibreGeo.attributes.position.array; let n = 0;
    for (let f = 0; f < FIB; f++) {
      const v0 = (f / FIB) * TAU;
      for (let q = 0; q < FSEG; q++) {
        const h0 = 0.06 + 0.92 * (q / FSEG), h1 = 0.06 + 0.92 * ((q + 1) / FSEG);
        const va = v0 + 1.25 * h0, vb = v0 + 1.25 * h1;
        if (inCut(va) || inCut(vb)) { for (let z = 0; z < 6; z++) P[n++] = 0; continue; }
        onEpi(h0, va, s, 0.006, tA).toArray(P, n); n += 3;
        onEpi(h1, vb, s, 0.006, tA).toArray(P, n); n += 3;
      }
    }
    fibreGeo.attributes.position.needsUpdate = true;
  }, false);
  VESSELS.forEach(([, rad, pts], i) => {
    const tube = s => new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts.map(([h, v]) => onEpi(h, v, s, rad * 0.55, V(0, 0, 0)))), pts.length * 4, rad, 10, false);
    const g1 = tube(1), g0 = tube(0);
    g0.morphAttributes.position = [g1.attributes.position];
    g0.morphAttributes.normal = [g1.attributes.normal];
    const m = vesselMeshes[i];
    m.geometry.dispose();
    m.geometry = g0;
    m.updateMorphTargets();
    m.morphTargetInfluences = [0];
    m.frustumCulled = false;
    morphing.push(m);
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
  const ANG = [V_CUT - 0.5, V_CUT - 0.5 + Math.PI / 3, V_CUT - 0.5 + (2 * Math.PI) / 3];
  const planes = ANG.map((a, k) => {
    const mat = new THREE.MeshBasicMaterial({ map: echoTexture(k + 1), transparent: true, side: THREE.DoubleSide, depthWrite: false });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(PLANE_W, PLANE_W), mat);
    m.rotation.y = -a;
    m.position.y = APEX_Y + PLANE_W / 2;
    root.add(m);
    return m;
  });
  // in-plane wall contours (untwisted: twist is out-of-plane motion a single plane misses)
  const CN = 48;
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
  const AU = 9, AV = 20;
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
      for (let k = 0; k <= 96; k++) pts.push(lv(layer, u, (k / 96) * TAU, 0, V(0, 0, 0), false));
      g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), M.ring));
    });
    mri.add(g);
    return g;
  });
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

  // reconstruction, coarse → fine (closed outer surface)
  const LEVELS = [[4, 6], [7, 12], [14, 24], [48, 96]];
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
    COL.accent = accent;
    M.fibre.color.set(dark ? '#ffd9cf' : '#fff0e6');
    M.elem.color.set(dark ? '#ffe3dc' : '#fff6f0');
    M.marker.color.copy(accent);
    M.marker.emissive.copy(accent).multiplyScalar(0.35);
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
    scene.environmentIntensity = dark ? 0.45 : 0.6;
  }

  // ── Frame ──────────────────────────────────────────────
  const steps = [...fig.querySelectorAll('.c3d-steps li')];
  const caption = fig.querySelector('.c3d-caption');
  const metric = fig.querySelector('.c3d-metric');
  const bar = fig.querySelector('.c3d-bar');
  const tmpA = V(0, 0, 0), tmpB = V(0, 0, 0), tmpC = new THREE.Color(), tmpE = new THREE.Color();
  let lastStage = -1, W = 1, H = 1, heatOn = false;

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
    heart.visible = heartA > 0.01;

    if (heart.visible) {
      morphing.forEach(o => { o.morphTargetInfluences[0] = s; });

      // heatmap colours (only while the 3D-motion stage is fading in or showing)
      if (heat > 0.01 || heatOn) {
        const Cc = epiGeo.attributes.color.array;
        for (let idx = 0; idx < DISP.length; idx++) {
          tmpE.fromArray(epiBase, idx * 3);
          if (heat > 0.01) {
            const d = s * DISP[idx];
            cmap(d / 0.3, tmpC);
            tmpE.lerp(tmpC, heat * (0.35 + 0.65 * clamp(d / 0.1, 0, 1)));
          }
          tmpE.toArray(Cc, idx * 3);
        }
        epiGeo.attributes.color.needsUpdate = true;
        heatOn = heat > 0.01;
      }
      const epiA = val('epi') * heartA;
      M.endo.opacity = heartA;
      M.epi.opacity = epiA;
      M.epi.depthWrite = epiA > 0.9;
      M.cut.opacity = heartA * (0.25 + 0.75 * epiA);
      M.cut.depthWrite = M.cut.opacity > 0.9;

      const fA = val('fibres') * heartA;
      elem.visible = fibres.visible = fA > 0.01;
      M.elem.opacity = 0.55 * fA;
      M.fibre.opacity = 0.42 * fA;

      const vA = val('vessels') * heartA;
      M.artery.opacity = M.vein.opacity = vA;
      M.artery.depthWrite = M.vein.depthWrite = vA > 0.9;
      vesselMeshes.forEach(m => { m.visible = vA > 0.01; });

      // material points
      const mA = val('markers') * heartA;
      MK.forEach(([uu, vv], i) => { lv(1, uu, vv, s, markers[i].position).multiplyScalar(1.02); markers[i].visible = mA > 0.01; loops[i].visible = mA > 0.01; });
      M.marker.opacity = mA;
      M.loop.opacity = 0.5 * mA;
    }

    // echo planes, contours and in-plane optical flow
    const pA = val('planes');
    planes.forEach(p => { p.visible = pA > 0.01; p.material.opacity = 0.42 * pA; });
    contours.forEach(({ a, layer, l }) => {
      l.visible = pA > 0.01;
      if (!l.visible) return;
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
        const uu = (0.2 + 0.8 * (i + 0.5) / AU) * U_MAX, vv = vWall((j + 0.5 + (i % 2) * 0.5) / (AV + 0.5));
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

    // camera: gentle sway in front of the cutaway (it stays in view)
    const th = 0.6 + 0.5 * Math.sin(t * 0.17);
    const R = W < 560 ? 6.2 : 5.4;
    cam.position.set(Math.sin(th) * R, 1.45, Math.cos(th) * R);
    cam.lookAt(0, 0.02, 0);
    shared.frame(canvas, ctx2d, 1.05, vp => { vp(0, 0, canvas.width, canvas.height); renderer.render(scene, cam); });

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
    canvas.width = Math.round(W * gov.dpr);
    canvas.height = Math.round(H * gov.dpr);
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    cam.aspect = W / H;
    cam.updateProjectionMatrix();
    draw();
  }

  // ── Loop, visibility, pause ────────────────────────────
  const st = { t: 1.6, last: null, running: false, visible: false, paused: false };
  const draw = () => render(st.t);
  const gov = window.vizGovernor(2, () => resize());
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
  fig.classList.add('is-ready');
  resize();
  new ResizeObserver(resize).observe(stage);
  new IntersectionObserver(([e]) => { st.visible = e.isIntersecting; update(); }, { rootMargin: '80px' }).observe(stage);
  darkMQ.addEventListener('change', () => { applyTheme(); draw(); });
  window.addEventListener('vizthemechange', () => { applyTheme(); if (!st.running) draw(); }); // follow the page's theme fade
  reduceMQ.addEventListener('change', update);
  const btn = fig.querySelector('.viz-toggle');
  if (btn) btn.addEventListener('click', () => {
    st.paused = !st.paused;
    btn.setAttribute('aria-pressed', st.paused);
    btn.setAttribute('aria-label', st.paused ? 'Play animation' : 'Pause animation');
    btn.innerHTML = `<svg class="ico" aria-hidden="true"><use href="#i-${st.paused ? 'play' : 'pause'}-fill"/></svg>`;
    update();
  });
};
