/*
 * Illustrative canvas animations. No dependencies, no build step.
 * Every scene is a pure function of time t, so visitors who prefer reduced
 * motion get a single still frame, and off-screen canvases stop drawing.
 */
(() => {
  'use strict';

  const reduceMQ = matchMedia('(prefers-reduced-motion: reduce)');
  const darkMQ = matchMedia('(prefers-color-scheme: dark)');
  const MONO = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  const TAU = Math.PI * 2;
  const C = {};

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, s) => a + (b - a) * s;
  const ease = s => (s < 0.5 ? 4 * s * s * s : 1 - Math.pow(-2 * s + 2, 3) / 2);
  const smooth = s => s * s * (3 - 2 * s);

  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    ['ink', 'ink-2', 'ink-3', 'line', 'accent', 'accent-bg', 'live', 'surface', 'bg-alt']
      .forEach(k => { C[k] = cs.getPropertyValue('--' + k).trim(); });
  }

  // Seeded PRNG (mulberry32) and a stateless 3-int hash, both in [0, 1).
  function rng(seed) {
    return () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hash(a, b, c) {
    let h = (Math.imul(a, 374761393) + Math.imul(b, 668265263) + Math.imul(c, 1442695041)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }

  // ── Drawing helpers ────────────────────────────────────
  function path(ctx, pts, color, w = 1.5, alpha = 1, dash) {
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = w;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (dash) ctx.setLineDash(dash);
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.stroke();
    ctx.restore();
  }
  function dot(ctx, x, y, r, fill, stroke, w = 1.5, alpha = 1) {
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = w; ctx.stroke(); }
    ctx.restore();
  }
  function label(ctx, s, x, y, { color = C['ink-3'], align = 'left', size = 10, weight = 500, alpha = 1 } = {}) {
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.font = `${weight} ${size}px ${MONO}`;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.fillText(s, x, y);
    ctx.restore();
  }
  function pill(ctx, s, x, y, align = 'left') {
    ctx.save();
    ctx.font = `600 10px ${MONO}`;
    const w = ctx.measureText(s).width + 14;
    const x0 = align === 'right' ? x - w : x;
    ctx.globalAlpha = 0.92;
    ctx.fillStyle = C.surface;
    ctx.strokeStyle = C.line;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x0, y, w, 19, 9.5); else ctx.rect(x0, y, w, 19);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    label(ctx, s, x0 + 7, y + 10, { color: C['ink-2'], weight: 600 });
  }

  // ── 1. Hero: pick-and-place arm ────────────────────────
  // A 2-link arm with base yaw, drawn in oblique side view. A camera detector
  // picks targets, planar IK drives the arm, and a mocap rigid body on the
  // wrist leaves a tracked trajectory.
  function armScene() {
    const BX = 200, FLOOR = 280, SH = 214, L1 = 100, L2 = 90, LG = 34, DEPTH = 0.2;
    const BIN = [124, 102, 80, 58], TOTE = [282, 304, 326, 348], IY = 266, HOV = 200;
    const TAGS = ['cable 0.97', 'pencil 0.94', 'bolt 0.98', 'cable 0.95'];
    const TC = 4.95;
    const binP = j => ({ yaw: Math.PI, r: BX - BIN[j] });
    const toteP = j => ({ yaw: 0, r: TOTE[j] - BX });

    function plan(t) {
      const i = Math.floor(t / TC), j = i % 4;
      let u = t - i * TC;
      const b = binP(j), o = toteP(j), prev = toteP((j + 3) % 4);
      // [duration, phase, from, fromY, to, toY, grip0, grip1, arc height]
      const segs = [
        [1.2, 'approach', prev, HOV, b, HOV, 0, 0, 38],
        [0.5, 'descend', b, HOV, b, IY, 0, 0, 0],
        [0.35, 'grasp', b, IY, b, IY, 0, 1, 0],
        [0.45, 'lift', b, IY, b, HOV, 1, 1, 0],
        [1.3, 'transfer', b, HOV, o, HOV, 1, 1, 42],
        [0.45, 'place', o, HOV, o, IY, 1, 1, 0],
        [0.3, 'release', o, IY, o, IY, 1, 0, 0],
        [0.4, 'retreat', o, IY, o, HOV, 0, 0, 0],
      ];
      let k = 0;
      while (k < segs.length - 1 && u > segs[k][0]) { u -= segs[k][0]; k++; }
      const [d, ph, A, ya, B, yb, g0, g1, arc] = segs[k];
      const s = ease(clamp(u / d, 0, 1));
      const yaw = lerp(A.yaw, B.yaw, s), r = lerp(A.r, B.r, s);
      const y = lerp(ya, yb, s) - arc * Math.sin(Math.PI * s);
      return { j, k, ph, s, yaw, r, y, g: lerp(g0, g1, s) };
    }
    // Oblique projection: points further from the viewer sit slightly higher.
    const proj = (rp, y, yaw) => ({ x: BX + rp * Math.cos(yaw), y: y - rp * Math.sin(yaw) * DEPTH });
    const tipOf = p => proj(p.r, p.y, p.yaw);

    function link(ctx, a, b, w) {
      path(ctx, [a, b], C['ink-2'], w);
      path(ctx, [a, b], C.surface, w - 4);
    }
    function item(ctx, x, y, alpha = 1) {
      dot(ctx, x, y, 5, C['bg-alt'], C['ink-3'], 1.5, alpha);
      dot(ctx, x, y, 1.6, C['ink-3'], null, 0, alpha);
    }
    function box(ctx, x, y, s, alpha) {
      const h = s / 2, c = 5;
      ctx.save();
      ctx.globalAlpha *= alpha;
      ctx.strokeStyle = C.accent;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(([sx, sy]) => {
        ctx.moveTo(x + sx * h, y + sy * h - sy * c);
        ctx.lineTo(x + sx * h, y + sy * h);
        ctx.lineTo(x + sx * h - sx * c, y + sy * h);
      });
      ctx.stroke();
      ctx.restore();
    }

    return (ctx, t) => {
      const p = plan(t);
      const tip = tipOf(p);

      // floor with hatching
      path(ctx, [{ x: 16, y: FLOOR }, { x: 384, y: FLOOR }], C['ink-3'], 1.2, 0.6);
      for (let x = 22; x < 384; x += 12) path(ctx, [{ x, y: FLOOR + 1 }, { x: x - 6, y: FLOOR + 7 }], C['ink-3'], 1, 0.22);

      // bin + tote
      const tray = x0 => path(ctx, [{ x: x0, y: 236 }, { x: x0, y: 276 }, { x: x0 + 102, y: 276 }, { x: x0 + 102, y: 236 }], C['ink-2'], 2);
      tray(40); tray(262);
      label(ctx, 'bin', 91, 296, { align: 'center' });
      label(ctx, 'tote', 313, 296, { align: 'center' });

      // items
      const batchIn = p.j === 0 && p.k === 0 ? p.s : 1;
      for (let m = 0; m < 4; m++) {
        if (m > p.j || (m === p.j && p.k < 3)) item(ctx, BIN[m], IY, batchIn);
        if (m < p.j || (m === p.j && p.k >= 6)) item(ctx, TOTE[m], IY);
        if (p.j === 0 && p.k === 0) item(ctx, TOTE[m], IY, 1 - p.s);
      }

      // camera + frustum + detections
      path(ctx, [{ x: 44, y: 234 }, { x: 91, y: 50 }, { x: 138, y: 234 }], C.accent, 1, 0.35, [3, 4]);
      ctx.save();
      ctx.fillStyle = C.surface;
      ctx.strokeStyle = C['ink-2'];
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(79, 32, 24, 15, 3); else ctx.rect(79, 32, 24, 15);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      dot(ctx, 91, 49, 3.5, C.surface, C['ink-2'], 1.5);
      label(ctx, 'rgb-d', 110, 40);
      if (p.k <= 2) {
        for (let m = p.j; m < 4; m++) box(ctx, BIN[m], IY, 18, m === p.j ? 1 : 0.3);
        pill(ctx, TAGS[p.j], BIN[p.j] - 8, 206, 'left');
      }

      // mocap-tracked trajectory (sampled from the plan, so it needs no state)
      const trail = [];
      for (let n = 0; n <= 34; n++) {
        const tt = t - n * 0.03;
        if (tt < 0) break;
        trail.push(tipOf(plan(tt)));
      }
      for (let n = 1; n < trail.length; n++) {
        path(ctx, [trail[n - 1], trail[n]], C.live, 2, 0.55 * (1 - n / trail.length));
      }

      // turntable + pedestal
      ctx.save();
      ctx.strokeStyle = C['ink-3'];
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.ellipse(BX, FLOOR, 30, 7, 0, 0, TAU);
      ctx.stroke();
      ctx.fillStyle = C.surface;
      ctx.strokeStyle = C['ink-2'];
      ctx.lineWidth = 1.5;
      ctx.fillRect(187, SH, 26, FLOOR - SH);
      ctx.strokeRect(187, SH, 26, FLOOR - SH);
      ctx.restore();
      dot(ctx, BX + 30 * Math.cos(p.yaw), FLOOR + 7 * Math.sin(p.yaw), 2.5, C.accent);

      // planar IK, elbow up, in the arm's own (r, height) plane
      const wy = p.y - LG;
      const dr = p.r, dz = SH - wy;
      const d = clamp(Math.hypot(dr, dz), Math.abs(L1 - L2) + 0.01, L1 + L2 - 0.01);
      const ea = Math.atan2(dz, dr) + Math.acos(clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1));
      const S = proj(0, SH, p.yaw);
      const E = proj(L1 * Math.cos(ea), SH - L1 * Math.sin(ea), p.yaw);
      const W = proj(p.r, wy, p.yaw);

      link(ctx, S, E, 12);
      link(ctx, E, W, 10);
      const palm = { x: W.x, y: W.y + 22 };
      link(ctx, W, palm, 7);
      [S, E, W].forEach(J => { dot(ctx, J.x, J.y, 6, C.surface, C['ink-2'], 2); dot(ctx, J.x, J.y, 1.8, C['ink-2']); });

      const o = lerp(12, 6.5, p.g);
      path(ctx, [{ x: palm.x - o - 2, y: palm.y }, { x: palm.x + o + 2, y: palm.y }], C['ink-2'], 3);
      path(ctx, [{ x: palm.x - o, y: palm.y }, { x: palm.x - o, y: tip.y + 2 }], C['ink-2'], 3);
      path(ctx, [{ x: palm.x + o, y: palm.y }, { x: palm.x + o, y: tip.y + 2 }], C['ink-2'], 3);

      if (p.k >= 3 && p.k <= 5) item(ctx, tip.x, tip.y);

      // mocap rigid body on the wrist
      const mk = [{ x: W.x - 11, y: W.y + 9 }, { x: W.x + 11, y: W.y + 9 }, { x: W.x + 4, y: W.y - 5 }];
      path(ctx, [...mk, mk[0]], C.live, 1, 0.6);
      mk.forEach(m => dot(ctx, m.x, m.y, 2.8, C.live, C.surface, 1.2));

      if (p.k === 3 || (p.k === 4 && p.s < 0.5)) {
        const a = p.k === 3 ? 1 : 1 - p.s * 2;
        label(ctx, 'single pick ✓', tip.x + 14, tip.y - 4, { color: C.live, weight: 600, alpha: a });
      }

      // readout
      const xm = (tip.x - BX) / 400, zm = (FLOOR - p.y) / 400;
      label(ctx, `phase  ${p.ph}`, 388, 20, { align: 'right', color: C['ink-2'] });
      label(ctx, `ee  x ${xm >= 0 ? '+' : '−'}${Math.abs(xm).toFixed(2)}  z ${zm.toFixed(2)} m`, 388, 35, { align: 'right' });
      label(ctx, `yaw ${String(Math.round((p.yaw * 180) / Math.PI)).padStart(3, ' ')}°  mocap 3/3`, 388, 50, { align: 'right' });
    };
  }

  // ── 2. Thesis: goal-conditioned motion prediction ──────
  function foresightScene() {
    const GY = 236, X0 = 120, DW = 6, HOLD = 1.6, TCY = DW + HOLD, STRIDE = 64;
    const GOALS = [540, 500, 575];

    function root(u, gx) {
      const s = clamp(u / DW, 0, 1);
      return { x: X0 + (gx - X0) * smooth(s), a: clamp(6 * s * (1 - s) * 0.95, 0, 1) };
    }
    function pose(x, a) {
      const ph = (TAU * (x - X0)) / STRIDE;
      const hip = { x, y: GY - 58 + 1.6 * Math.cos(2 * ph) * a };
      const leg = q => {
        const th = 0.42 * Math.sin(q) * a;
        const kb = 0.06 + 0.6 * a * Math.max(0, Math.cos(q + 0.3));
        const knee = { x: hip.x + 30 * Math.sin(th), y: hip.y + 30 * Math.cos(th) };
        const ank = { x: knee.x + 29 * Math.sin(th - kb), y: knee.y + 29 * Math.cos(th - kb) };
        return [hip, knee, ank, { x: ank.x + 7, y: ank.y }];
      };
      const sh = { x: hip.x + 3 * a, y: hip.y - 38 };
      const arm = q => {
        const ua = -0.38 * Math.sin(q) * a;
        const el = { x: sh.x + 22 * Math.sin(ua), y: sh.y + 22 * Math.cos(ua) };
        const fa = ua + 0.25 + 0.2 * a;
        return [sh, el, { x: el.x + 20 * Math.sin(fa), y: el.y + 20 * Math.cos(fa) }];
      };
      return { hip, sh, head: { x: sh.x + 2, y: sh.y - 13 }, near: [leg(ph), arm(ph + Math.PI)], far: [leg(ph + Math.PI), arm(ph)] };
    }
    function figure(ctx, P, color, alpha, w = 2.4) {
      P.far.forEach(l => path(ctx, l, color, w, alpha * 0.45));
      path(ctx, [P.hip, P.sh], color, w, alpha);
      P.near.forEach(l => path(ctx, l, color, w, alpha));
      dot(ctx, P.head.x, P.head.y, 8, null, color, w, alpha);
    }

    return (ctx, t) => {
      const c = Math.floor(t / TCY), u = t - c * TCY, gx = GOALS[c % GOALS.length];
      const fade = Math.min(1, u / 0.3, (TCY - u) / 0.35);
      const now = root(u, gx);
      ctx.globalAlpha = fade;

      // ground band
      path(ctx, [{ x: 20, y: GY }, { x: 620, y: GY }], C['ink-3'], 1.2, 0.6);
      for (let x = 24; x < 620; x += 14) path(ctx, [{ x, y: GY + 1 }, { x: x - 6, y: GY + 7 }], C['ink-3'], 1, 0.18);

      // footprints: observed (solid) and predicted (hollow)
      const future = root(u + 2.4, gx).x;
      for (let fx = X0 + STRIDE / 4; fx < future; fx += STRIDE / 2) {
        const past = fx <= now.x;
        const alt = Math.round((fx - X0) / (STRIDE / 2)) % 2 ? -3 : 3;
        ctx.save();
        ctx.globalAlpha *= past ? 0.45 : 0.7;
        ctx.beginPath();
        ctx.ellipse(fx, GY + 12 + alt, 5, 2, 0, 0, TAU);
        if (past) { ctx.fillStyle = C['ink-3']; ctx.fill(); } else { ctx.strokeStyle = C.accent; ctx.lineWidth = 1.2; ctx.stroke(); }
        ctx.restore();
      }

      // sampled root trajectories, re-planned autoregressively
      const step = Math.floor(u / 0.8);
      if (now.a > 0.1) {
        const unc = clamp((gx - now.x) / 320, 0.15, 1);
        for (let s = 0; s < 6; s++) {
          const r1 = hash(c, step, s * 2) - 0.5, r2 = hash(c, step, s * 2 + 1) - 0.5;
          const ex = future + r1 * 26 * unc, ey = GY + 12 + r2 * 14 * unc;
          const pts = [];
          for (let q = 0; q <= 16; q++) {
            const v = q / 16;
            pts.push({ x: lerp(now.x, ex, v), y: lerp(GY + 12, ey, v) + Math.sin(Math.PI * v) * r2 * 18 * unc });
          }
          path(ctx, pts, C.accent, 1.2, 0.4, [3, 3]);
        }
      }

      // goal
      const reached = u > DW;
      ctx.save();
      ctx.strokeStyle = C.accent;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.ellipse(gx, GY + 12, 16, 4.5, 0, 0, TAU);
      ctx.stroke();
      if (reached) {
        const k = (u - DW) / HOLD;
        ctx.globalAlpha *= 1 - k;
        ctx.beginPath();
        ctx.ellipse(gx, GY + 12, 16 + 40 * k, 4.5 + 11 * k, 0, 0, TAU);
        ctx.stroke();
      }
      ctx.restore();
      path(ctx, [{ x: gx + 18, y: GY + 10 }, { x: gx + 18, y: GY - 40 }], C.accent, 1.5);
      ctx.save();
      ctx.fillStyle = C.accent;
      ctx.beginPath();
      ctx.moveTo(gx + 18, GY - 40); ctx.lineTo(gx + 34, GY - 34); ctx.lineTo(gx + 18, GY - 28);
      ctx.fill();
      ctx.restore();
      label(ctx, 'goal', gx + 18, GY - 52, { color: C.accent, align: 'center', weight: 600 });

      // poses: observed past, current, predicted future
      [2, 1].forEach(dt => { if (u - dt > 0) figure(ctx, pose(root(u - dt, gx).x, root(u - dt, gx).a), C['ink-3'], 0.18); });
      [0.6, 1.2, 1.8, 2.4].forEach((dt, n) => {
        const f = root(u + dt, gx);
        if (f.x - now.x > 6) figure(ctx, pose(f.x, f.a), C.accent, [0.55, 0.4, 0.28, 0.18][n], 2);
      });
      figure(ctx, pose(now.x, now.a), C.ink, 1, 2.6);

      // now divider + labels
      path(ctx, [{ x: now.x, y: GY + 22 }, { x: now.x, y: GY + 38 }], C['ink-3'], 1.2);
      label(ctx, 'observed', now.x - 8, GY + 31, { align: 'right' });
      label(ctx, 'predicted', now.x + 8, GY + 31, { color: C.accent });

      // egocentric inset: what the head-mounted camera sees
      const ix = 18, iy = 18, iw = 168, ih = 94;
      ctx.save();
      ctx.fillStyle = C.surface;
      ctx.strokeStyle = C.line;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(ix, iy, iw, ih, 8); else ctx.rect(ix, iy, iw, ih);
      ctx.fill();
      ctx.stroke();
      ctx.clip();
      const ph = (TAU * (now.x - X0)) / STRIDE;
      const hy = iy + 34 + 1.4 * Math.sin(2 * ph) * now.a;
      const vx = ix + iw / 2;
      for (let l = -4; l <= 4; l++) path(ctx, [{ x: vx, y: hy }, { x: vx + l * 70, y: iy + ih + 60 }], C['ink-3'], 1, 0.25);
      const walked = (now.x - X0) / 60;
      for (let n = 1; n < 16; n++) {
        const z = n * 0.5 - (walked % 0.5);
        if (z < 0.3 || z > 4.5) continue;
        const y = hy + 18 / z;
        path(ctx, [{ x: ix, y }, { x: ix + iw, y }], C['ink-3'], 1, 0.25);
      }
      path(ctx, [{ x: ix, y: hy }, { x: ix + iw, y: hy }], C['ink-3'], 1, 0.5);
      const D = Math.max(0.3, (gx - now.x) / 60);
      const gy = hy + 18 / D, gr = clamp(6 / D, 1.5, 22);
      ctx.fillStyle = C.accent;
      ctx.globalAlpha = 0.85 * fade;
      ctx.beginPath();
      ctx.ellipse(vx + 10 / D, gy, gr * 1.6, gr * 0.5, 0, 0, TAU);
      ctx.fill();
      ctx.restore();
      label(ctx, 'ego rgb', ix + 9, iy + 12, { color: C['ink-2'], weight: 600 });
      dot(ctx, ix + iw - 12, iy + 12, 3, '#e5484d');

      label(ctx, `rollout step ${String(step).padStart(2, '0')} · 6 samples`, 622, 22, { align: 'right' });
      ctx.globalAlpha = 1;
    };
  }

  // ── 3. HG-SCRUB: relightable Gaussian splats ───────────
  function splatScene() {
    const r = rng(7);
    const G = [];
    const gauss = () => { let a = 0; while (!a) a = r(); return Math.sqrt(-2 * Math.log(a)) * Math.cos(TAU * r()); };
    const jit = col => col.map(v => clamp(v + (r() - 0.5) * 0.08, 0, 1));
    const norm = v => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

    function bone(ax, ay, bx, by, rad, n, col) {
      const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy), px = -dy / len, py = dx / len, rot = Math.atan2(dy, dx);
      for (let i = 0; i < n; i++) {
        const s = r(), lat = clamp(gauss() * 0.45, -0.95, 0.95), sx = rad * (0.6 + 0.4 * r());
        G.push({ x: ax + dx * s + px * lat * rad, y: ay + dy * s + py * lat * rad, sx, sy: sx * (0.45 + 0.3 * r()),
          rot: rot + gauss() * 0.15, n: [px * lat, py * lat, Math.sqrt(1 - lat * lat)], c: jit(col), g: 0 });
      }
    }
    function blob(cx, cy, rx, ry, n, col, g, keep = () => true) {
      for (let i = 0; i < n; i++) {
        const a = TAU * r(), rr = Math.sqrt(r()), x = cx + rx * rr * Math.cos(a), y = cy + ry * rr * Math.sin(a);
        if (!keep(x, y)) continue;
        const nx = (x - cx) / rx, ny = (y - cy) / ry;
        const sx = Math.min(rx, ry) * (0.16 + 0.12 * r());
        G.push({ x, y, sx, sy: sx * (0.55 + 0.35 * r()), rot: r() * Math.PI, n: norm([nx, ny, Math.sqrt(Math.max(0.05, 1 - nx * nx - ny * ny))]), c: jit(col), g });
      }
    }
    function plane(n, col, place, nrm, size, flat) {
      for (let i = 0; i < n; i++) {
        const [x, y] = place(r(), r()), sx = size * (0.6 + 0.6 * r());
        G.push({ x, y, sx, sy: sx * flat, rot: gauss() * 0.08, n: norm(nrm), c: jit(col), g: 1 });
      }
    }

    // scene: floor, box (front, side, top), sphere
    plane(170, [0.78, 0.74, 0.66], (a, b) => [20 + 360 * a, 188 + 34 * Math.pow(b, 1.3)], [0, -0.75, 0.66], 8, 0.28);
    plane(60, [0.36, 0.62, 0.55], (a, b) => [288 + 50 * a, 142 + 46 * b], [0, 0, 1], 6, 0.6);
    plane(22, [0.36, 0.62, 0.55], (a, b) => [338 + 12 * a, 142 - 8 * a + 46 * b], [1, 0, 0.25], 5, 0.6);
    plane(26, [0.4, 0.66, 0.58], (a, b) => [288 + 50 * a + 12 * b, 142 - 8 * b], [0, -1, 0.15], 5, 0.5);
    blob(88, 160, 26, 26, 120, [0.86, 0.42, 0.33], 1);

    // human
    const SKIN = [0.85, 0.66, 0.52], SHIRT = [0.29, 0.45, 0.72], PANTS = [0.22, 0.25, 0.32];
    bone(193, 118, 191, 153, 7, 26, PANTS); bone(191, 153, 190, 186, 6, 24, PANTS);
    bone(207, 118, 209, 153, 7, 26, PANTS); bone(209, 153, 210, 186, 6, 24, PANTS);
    bone(186, 188, 196, 188, 3, 8, [0.15, 0.15, 0.17]); bone(206, 188, 216, 188, 3, 8, [0.15, 0.15, 0.17]);
    blob(200, 93, 18, 28, 110, SHIRT, 0);
    bone(184, 72, 176, 100, 5.5, 22, SHIRT); bone(176, 100, 173, 126, 4.5, 18, SKIN);
    bone(216, 72, 225, 100, 5.5, 22, SHIRT); bone(225, 100, 228, 124, 4.5, 18, SKIN);
    bone(200, 60, 200, 68, 4, 6, SKIN);
    blob(200, 48, 11, 12, 40, SKIN, 0);
    blob(200, 46, 12, 12, 30, [0.16, 0.12, 0.1], 0, (x, y) => y < 43);

    const bump = (u, a, b) => smooth(clamp((u - a) / 0.5, 0, 1)) * (1 - smooth(clamp((u - b + 0.5) / 0.5, 0, 1)));

    return (ctx, t, k) => {
      const a = t * 0.7;
      const L = norm([Math.cos(a), -0.55, 0.35 + 0.9 * Math.sin(a)]);
      const w = 0.5 + 0.5 * Math.sin(t * 0.4);
      const tint = [lerp(1, 0.8, w), lerp(0.93, 0.92, w), lerp(0.8, 1.05, w)];
      const u = t % 10;
      const humanA = 1 - 0.94 * bump(u, 6, 8), sceneA = 1 - 0.94 * bump(u, 4, 6);
      const mode = u >= 4 && u < 6 ? 'human only' : u >= 6 && u < 8 ? 'scene only' : 'composite';

      for (const s of G) {
        const al = s.g ? sceneA : humanA;
        if (al < 0.02) continue;
        const d = Math.max(0, s.n[0] * L[0] + s.n[1] * L[1] + s.n[2] * L[2]);
        const sh = 0.3 + 0.85 * d;
        ctx.fillStyle = `rgb(${clamp(s.c[0] * sh * tint[0] * 255, 0, 255) | 0},${clamp(s.c[1] * sh * tint[1] * 255, 0, 255) | 0},${clamp(s.c[2] * sh * tint[2] * 255, 0, 255) | 0})`;
        const cs = Math.cos(s.rot), sn = Math.sin(s.rot);
        for (const [scale, alpha] of [[1.8, 0.18], [1, 0.85]]) {
          ctx.globalAlpha = alpha * al;
          ctx.setTransform(k * cs * s.sx * scale, k * sn * s.sx * scale, -k * sn * s.sy * scale, k * cs * s.sy * scale, k * s.x, k * s.y);
          ctx.beginPath();
          ctx.arc(0, 0, 1, 0, TAU);
          ctx.fill();
        }
      }
      ctx.setTransform(k, 0, 0, k, 0, 0);
      ctx.globalAlpha = 1;

      pill(ctx, mode, 12, 12);
      ctx.save();
      ctx.strokeStyle = C['ink-3'];
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.ellipse(366, 22, 18, 7, 0, 0, TAU);
      ctx.stroke();
      ctx.restore();
      dot(ctx, 366 + 18 * Math.cos(a), 22 + 7 * Math.sin(a), 4, '#f5a524');
      label(ctx, 'light', 342, 22, { align: 'right' });
    };
  }

  // ── 4. Free-Generation: trajectory control while denoising ─
  function diffusionScene() {
    const COLS = 40, ROWS = 22, CS = 10, OY = 2, TC = 7.5, STEPS = 50;
    function curve(c) {
      const q = rng(c * 31 + 5);
      const P = [
        { x: 50 + 40 * q(), y: 40 + 140 * q() },
        { x: 130 + 50 * q(), y: 20 + 180 * q() },
        { x: 230 + 50 * q(), y: 20 + 180 * q() },
        { x: 310 + 40 * q(), y: 40 + 140 * q() },
      ];
      return s => {
        const m = 1 - s;
        return {
          x: m * m * m * P[0].x + 3 * m * m * s * P[1].x + 3 * m * s * s * P[2].x + s * s * s * P[3].x,
          y: m * m * m * P[0].y + 3 * m * m * s * P[1].y + 3 * m * s * s * P[2].y + s * s * s * P[3].y,
        };
      };
    }

    return (ctx, t) => {
      const c = Math.floor(t / TC), u = t - c * TC, B = curve(c);
      let step;
      if (u < 3.4) step = Math.ceil(STEPS * (1 - u / 3.4));
      else if (u < 6.6) step = 0;
      else step = Math.round((STEPS * (u - 6.6)) / 0.9);
      step = clamp(step, 0, STEPS);
      const sigma = Math.pow(step / STEPS, 1.2);
      const s = 0.5 - 0.5 * Math.cos((TAU * u) / 3.6);
      const p = B(s);

      ctx.fillStyle = C.accent;
      for (let i = 0; i < COLS; i++) {
        for (let j = 0; j < ROWS; j++) {
          const cx = (i + 0.5) * CS, cy = OY + (j + 0.5) * CS;
          const dd = (cx - p.x) ** 2 + (cy - p.y) ** 2;
          const sig = 0.04 + 0.9 * Math.exp(-dd / (2 * 17 * 17));
          const v = (1 - sigma) * sig + sigma * hash(i, j, step + c * 97) * 0.8;
          ctx.globalAlpha = 0.05 + 0.8 * v;
          ctx.fillRect(cx - 4.5, cy - 4.5, 9, 9);
        }
      }
      ctx.globalAlpha = 1;

      const pts = [];
      for (let q = 0; q <= 40; q++) pts.push(B(q / 40));
      path(ctx, pts, C['ink-2'], 1.5, 0.8, [4, 4]);
      const a = B(0), z = B(1), zb = B(0.97);
      dot(ctx, a.x, a.y, 4, C.surface, C['ink-2'], 1.5);
      const ang = Math.atan2(z.y - zb.y, z.x - zb.x);
      ctx.save();
      ctx.fillStyle = C['ink-2'];
      ctx.translate(z.x, z.y);
      ctx.rotate(ang);
      ctx.beginPath();
      ctx.moveTo(4, 0); ctx.lineTo(-6, -5); ctx.lineTo(-6, 5);
      ctx.fill();
      ctx.restore();

      ctx.save();
      ctx.strokeStyle = C.ink;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      ctx.strokeRect(p.x - 28, p.y - 28, 56, 56);
      ctx.restore();
      label(ctx, 'mask', p.x - 28, p.y - 36, { color: C.ink, weight: 600 });

      pill(ctx, `denoise ${String(step).padStart(2, '0')}/${STEPS} · frame ${String(Math.floor(s * 15) + 1).padStart(2, '0')}/16`, 10, 8);
    };
  }

  // ── Mounting ───────────────────────────────────────────
  // name: [factory, virtual width, virtual height, still-frame time]
  const SCENES = {
    arm: [armScene, 400, 304, 3.3],
    foresight: [foresightScene, 640, 290, 3.2],
    splats: [splatScene, 400, 225, 1.1],
    diffusion: [diffusionScene, 400, 225, 4.4],
  };
  const mounted = [];

  function mount(canvas) {
    const def = SCENES[canvas.dataset.viz];
    if (!def) return;
    const [make, vw, vh, still] = def;
    const render = make();
    const ctx = canvas.getContext('2d');
    const btn = canvas.closest('.viz')?.querySelector('.viz-toggle');
    const st = { t: still, k: 1, last: null, running: false, visible: false, paused: false };

    const draw = () => {
      ctx.setTransform(st.k, 0, 0, st.k, 0, 0);
      ctx.clearRect(0, 0, vw, vh);
      ctx.globalAlpha = 1;
      render(ctx, st.t, st.k);
    };
    const frame = now => {
      if (!st.running) return;
      if (st.last !== null) st.t += Math.min((now - st.last) / 1000, 0.05);
      st.last = now;
      draw();
      requestAnimationFrame(frame);
    };
    const update = () => {
      const go = st.visible && !st.paused && !reduceMQ.matches;
      if (go && !st.running) { st.running = true; st.last = null; requestAnimationFrame(frame); }
      if (!go) st.running = false;
    };
    const resize = () => {
      const w = canvas.getBoundingClientRect().width;
      if (!w) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round((w * vh / vw) * dpr);
      st.k = canvas.width / vw;
      draw();
    };

    new ResizeObserver(resize).observe(canvas);
    new IntersectionObserver(([e]) => { st.visible = e.isIntersecting; update(); }, { rootMargin: '80px' }).observe(canvas);
    if (btn) {
      btn.addEventListener('click', () => {
        st.paused = !st.paused;
        btn.setAttribute('aria-pressed', st.paused);
        btn.setAttribute('aria-label', st.paused ? 'Play animation' : 'Pause animation');
        btn.innerHTML = `<i class="bi bi-${st.paused ? 'play' : 'pause'}-fill" aria-hidden="true"></i>`;
        update();
      });
    }
    mounted.push({ draw, update });
  }

  readColors();
  document.querySelectorAll('canvas[data-viz]').forEach(mount);
  darkMQ.addEventListener('change', () => { readColors(); mounted.forEach(m => m.draw()); });
  // Canvas text needs the web font; redraw still frames once it has loaded.
  if (document.fonts) document.fonts.ready.then(() => mounted.forEach(m => m.draw()));
  reduceMQ.addEventListener('change', () => mounted.forEach(m => m.update()));

  // 3D scenes (js/foresight3d.js, js/cardiac3d.js) load three.js from the CDN once, when
  // their section nears the viewport. On any failure the thesis keeps its 2D canvas and
  // the C2BL figure stays hidden.
  const webgl = (() => { try { return !!document.createElement('canvas').getContext('webgl2'); } catch (e) { return false; } })();
  let threeP;
  const three = () => (threeP ||= import('https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.min.js'));
  function lazy3D(el, mountFn) {
    if (!el || !webgl || !mountFn) return;
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      three().then(mountFn).catch(err => console.warn('3D illustration unavailable.', err));
    }, { rootMargin: '600px' });
    io.observe(el);
  }
  const fs = document.querySelector('canvas[data-viz="foresight"]');
  lazy3D(fs, window.mountForesight3D && (THREE => window.mountForesight3D(fs.closest('.viz'), THREE, fs)));
  const heartFig = document.querySelector('.c3d');
  // The figure is display:none until mounted, so watch its role card instead.
  lazy3D(heartFig && heartFig.closest('.role'), window.mountCardiac3D && (THREE => window.mountCardiac3D(heartFig, THREE)));
})();
