/*
 * Falling maple leaves across the whole page, shown only in the Fall theme.
 * Leaves are pre-drawn sprites (a maple outline with veins, shaded) in the shades of red sampled from
 * the photograph, plus the occasional gold. Each one falls, sways, spins and tumbles (a cosine squash
 * fakes the 3D flip); a slow wind drifts them sideways and scrolling sends a gust through.
 * Off for reduced motion; pauses with the tab (requestAnimationFrame).
 */
(() => {
  'use strict';
  const root = document.documentElement;
  const reduceMQ = matchMedia('(prefers-reduced-motion: reduce)');
  const LEAF = 'M50 2 58 22 70 14 66 36 86 28 80 44 98 46 82 58 88 70 66 66 64 80 54 70 52 98 48 98 46 70 36 80 34 66 12 70 18 58 2 46 20 44 14 28 34 36 30 14 42 22Z';
  // weights favour the reds; gold and orange are accents, as in the street
  const COLORS = [
    ['#b52f2b', 4], ['#c9502f', 3], ['#9b2a2c', 3], ['#d26a3a', 2], ['#7e2b3a', 2],
    ['#9a5034', 2], ['#5e1a22', 1], ['#d9b54a', 1], ['#e08a3c', 1],
  ];
  const BAG = COLORS.flatMap(([c, w]) => Array(w).fill(c));

  function sprite(color) {
    const S = 80, c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d'), p = new Path2D(LEAF);
    g.translate(8, 8);
    g.scale(64 / 100, 64 / 100);
    const grad = g.createLinearGradient(10, 10, 90, 90);
    grad.addColorStop(0, shade(color, 0.12));
    grad.addColorStop(0.55, color);
    grad.addColorStop(1, shade(color, -0.3));
    g.fillStyle = g.strokeStyle = grad;
    g.shadowColor = 'rgba(30, 10, 8, .22)'; g.shadowBlur = 4; g.shadowOffsetY = 2;
    g.lineJoin = 'round'; g.lineWidth = 7;  // rounds the lobe tips so the outline reads as a leaf, not a star
    g.fill(p); g.stroke(p);
    g.shadowColor = 'transparent';
    g.strokeStyle = shade(color, -0.4);
    g.globalAlpha = 0.55;
    g.lineWidth = 1.6;
    g.lineCap = 'round';
    g.beginPath(); // main vein + stem, and the side veins toward the lobes
    g.moveTo(50, 98); g.lineTo(50, 18);
    [[50, 62, 16, 40], [50, 62, 84, 40], [50, 70, 24, 66], [50, 70, 76, 66]].forEach(([x0, y0, x1, y1]) => { g.moveTo(x0, y0); g.lineTo(x1, y1); });
    g.stroke();
    return c;
  }
  function shade(hex, k) {
    const n = parseInt(hex.slice(1), 16), f = v => Math.round(Math.max(0, Math.min(255, v + v * k)));
    return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
  }

  let canvas, ctx, sprites, leaves = [], W = 0, H = 0, dpr = 1, running = false, last = 0, fade = 0, target = 0;
  let wind = 0, gust = 0, lastScroll = scrollY;
  const rnd = (a, b) => a + Math.random() * (b - a);

  function spawn(l, anywhere) {
    l.sprite = sprites[BAG[(Math.random() * BAG.length) | 0]];
    l.size = rnd(20, 38) * (W < 640 ? 0.8 : 1);   // drawn size of the 80px sprite (leaf ≈ 80%)
    l.x = rnd(-40, W + 40);
    l.y = anywhere ? rnd(-H * 0.2, H) : rnd(-80, -30);
    l.vy = rnd(28, 60) * (l.size / 28);       // bigger leaves fall a little faster
    l.sway = rnd(18, 55); l.freq = rnd(0.5, 1.2); l.phase = rnd(0, 6.28);
    l.rot = rnd(0, 6.28); l.spin = rnd(-1.4, 1.4);
    l.tumble = rnd(0, 6.28); l.tumbleRate = rnd(1.2, 3.2);
    l.alpha = rnd(0.7, 0.95);
    return l;
  }
  function resize() {
    dpr = Math.min(devicePixelRatio || 1, 2);
    W = innerWidth; H = innerHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    const n = Math.round(Math.min(18, Math.max(7, W / 85)));
    while (leaves.length < n) leaves.push(spawn({}, true));
    leaves.length = n;
  }
  function frame(now) {
    if (!running) return;
    const dt = Math.min((now - last) / 1000, 0.05); last = now;
    fade += Math.sign(target - fade) * Math.min(Math.abs(target - fade), dt * 1.2); // ~0.8 s fade in/out
    const sv = scrollY - lastScroll; lastScroll = scrollY;
    gust = gust * Math.pow(0.08, dt) + sv * 2.2;                      // scrolling stirs a gust that dies away
    wind = 14 * Math.sin(now / 9000) + 8 * Math.sin(now / 3100);      // slow, uneven breeze
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const t = now / 1000;
    for (const l of leaves) {
      const sw = Math.cos(t * l.freq + l.phase);
      l.x += (wind + Math.max(-260, Math.min(260, gust)) * 0.6 + l.sway * sw * l.freq) * dt;
      l.y += (l.vy - Math.min(0, gust) * 0.15) * dt * (0.85 + 0.25 * Math.abs(sw)); // drift slows at the end of each swing
      l.rot += (l.spin + sw * 0.6) * dt;
      l.tumble += l.tumbleRate * dt;
      if (l.y > H + 50 || l.x < -90 || l.x > W + 90) spawn(l, false);
      const flip = Math.cos(l.tumble);                                 // edge-on when ~0
      ctx.setTransform(dpr, 0, 0, dpr, l.x * dpr, l.y * dpr);
      ctx.rotate(l.rot);
      ctx.scale(Math.max(0.12, Math.abs(flip)), 1);
      ctx.globalAlpha = l.alpha * fade * (flip < 0 ? 0.82 : 1);       // the underside is a touch paler
      ctx.drawImage(l.sprite, -l.size / 2, -l.size / 2, l.size, l.size);
    }
    if (target === 0 && fade === 0) { running = false; ctx.clearRect(0, 0, W, H); canvas.style.display = 'none'; return; }
    requestAnimationFrame(frame);
  }
  function update() {
    const on = root.dataset.theme === 'maple' && !reduceMQ.matches;
    target = on ? 1 : 0;
    if (on && !canvas) {
      canvas = document.createElement('canvas');
      canvas.className = 'leaf-fall';
      canvas.setAttribute('aria-hidden', 'true');
      document.body.appendChild(canvas);
      ctx = canvas.getContext('2d');
      sprites = Object.fromEntries(COLORS.map(([c]) => [c, sprite(c)]));
      addEventListener('resize', () => canvas && resize());
    }
    if (on && !running) {
      canvas.style.display = '';
      resize();
      running = true; last = performance.now(); lastScroll = scrollY;
      requestAnimationFrame(frame);
    }
  }
  new MutationObserver(update).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  reduceMQ.addEventListener('change', update);
  update();
})();
