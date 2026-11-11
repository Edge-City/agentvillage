// Agent Village explainer film. Deterministic canvas animation: draw(frame) paints one frame.
// Vertical 1080x1920, 30 fps. Rendered to mp4 by render.mjs.
'use strict';

const W = 1080, H = 1920, FPS = 30, DUR = 47;
const TAU = Math.PI * 2;

// ---------- math helpers ----------
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const lerp = (a, b, k) => a + (b - a) * k;
const prog = (t, a, b) => clamp((t - a) / (b - a));
const easeOut = x => 1 - Math.pow(1 - x, 3);
const easeIn = x => x * x * x;
const easeInOut = x => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const spring = x => (x <= 0 ? 0 : x >= 1 ? 1 : 1 - Math.pow(2, -9 * x) * Math.cos(x * 9));
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hash = (i, seed) => {
  let x = Math.sin(i * 127.1 + seed * 311.7) * 43758.5453;
  return x - Math.floor(x);
};
function noise1(x, seed) {
  const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
  return lerp(hash(i, seed), hash(i + 1, seed), u);
}
const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
function mix(c1, c2, k, a = 1) {
  const A = hex(c1), B = hex(c2);
  return `rgba(${Math.round(lerp(A[0], B[0], k))},${Math.round(lerp(A[1], B[1], k))},${Math.round(lerp(A[2], B[2], k))},${a})`;
}
const rgba = (c, a) => mix(c, c, 0, a);

// ---------- paint helpers ----------
function vgrad(ctx, y0, y1, stops) {
  const g = ctx.createLinearGradient(0, y0, 0, y1);
  stops.forEach(([p, c]) => g.addColorStop(p, c));
  return g;
}
function glow(ctx, x, y, r, color, alpha = 1) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, rgba(color, alpha));
  g.addColorStop(0.35, rgba(color, alpha * 0.35));
  g.addColorStop(1, rgba(color, 0));
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
  ctx.restore();
}
function rrect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}
function hill(ctx, baseY, amp, freq, seed, shift = 0) {
  ctx.beginPath();
  ctx.moveTo(-50, H + 600);
  for (let x = -50; x <= W + 50; x += 18) {
    ctx.lineTo(x, baseY - amp * noise1((x + shift) * freq, seed) - amp * 0.35 * noise1((x + shift) * freq * 2.7, seed + 3));
  }
  ctx.lineTo(W + 50, H + 600);
  ctx.closePath();
}

// Agent orb: soft halo, bright core, optional face.
function orb(ctx, x, y, r, color, { face = 0, blink = 0, a = 1, look = 0 } = {}) {
  if (a <= 0) return;
  glow(ctx, x, y, r * 5.5, color, 0.38 * a);
  glow(ctx, x, y, r * 2.4, color, 0.6 * a);
  ctx.save();
  ctx.globalAlpha = a;
  const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.35, r * 0.05, x, y, r);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(0.55, mix(color, '#ffffff', 0.55));
  g.addColorStop(1, color);
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
  if (face > 0) {
    ctx.globalAlpha = a * face;
    ctx.fillStyle = '#3a2540';
    const eh = r * 0.2 * (1 - blink * 0.9);
    for (const sx of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(x + sx * r * 0.32 + look * r * 0.12, y - r * 0.02, r * 0.1, Math.max(eh, r * 0.02), 0, 0, TAU);
      ctx.fill();
    }
    ctx.strokeStyle = '#3a2540'; ctx.lineWidth = r * 0.07; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(x + look * r * 0.12, y + r * 0.2, r * 0.2, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke();
    ctx.fillStyle = 'rgba(255,120,120,.35)';
    for (const sx of [-1, 1]) { ctx.beginPath(); ctx.ellipse(x + sx * r * 0.56, y + r * 0.22, r * 0.14, r * 0.09, 0, 0, TAU); ctx.fill(); }
  }
  ctx.restore();
}

// Palm tree. (x,y) is the base, h the height, lean in px at the crown.
function palm(ctx, x, y, h, lean, t, color, seed = 1, rim = null) {
  const sway = Math.sin(t * 0.9 + seed) * 0.035;
  const cx = x + lean + sway * h * 0.6, cy = y - h;
  ctx.save();
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineCap = 'round';
  const N = 14;
  for (let i = 0; i < N; i++) {
    const k0 = i / N, k1 = (i + 1) / N;
    const px = k => x + (cx - x) * k * k, py = k => y + (cy - y) * k;
    ctx.lineWidth = lerp(h * 0.05, h * 0.024, k0);
    ctx.beginPath(); ctx.moveTo(px(k0), py(k0)); ctx.lineTo(px(k1), py(k1)); ctx.stroke();
  }
  const fronds = 9;
  for (let i = 0; i < fronds; i++) {
    const base = -Math.PI * 0.5 + (i - (fronds - 1) / 2) * 0.52 + hash(i, seed) * 0.2 - 0.1;
    const ang = base + sway * (1.5 + Math.abs(i - 4) * 0.4) + Math.sin(t * 1.3 + i * 1.7 + seed) * 0.02;
    const len = h * (0.36 + hash(i, seed + 5) * 0.12);
    const droop = len * (0.35 + Math.abs(Math.cos(ang)) * 0.55);
    const tx = cx + Math.cos(ang) * len, ty = cy + Math.sin(ang) * len * 0.7 + droop;
    const mx = cx + Math.cos(ang) * len * 0.55, my = cy + Math.sin(ang) * len * 0.75 - len * 0.1;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.quadraticCurveTo(mx, my, tx, ty);
    ctx.quadraticCurveTo(mx - Math.cos(ang) * len * 0.05, my + len * 0.26, cx, cy + h * 0.02);
    ctx.fill();
    if (rim) {
      ctx.strokeStyle = rim; ctx.lineWidth = Math.max(1.5, h * 0.004);
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.quadraticCurveTo(mx, my, tx, ty); ctx.stroke();
      ctx.strokeStyle = color;
    }
  }
  ctx.beginPath(); ctx.arc(cx, cy, h * 0.03, 0, TAU); ctx.fill();
  ctx.restore();
}

// Small stylised person. (x,y) is the feet.
function person(ctx, x, y, s, shirt, skin, phase = 0, hair = '#2a1f33') {
  const bob = Math.abs(Math.sin(phase)) * 3 * s;
  ctx.save();
  ctx.translate(x, y - bob);
  ctx.fillStyle = 'rgba(20,15,50,.18)';
  ctx.beginPath(); ctx.ellipse(0, bob + 2 * s, 22 * s, 6 * s, 0, 0, TAU); ctx.fill();
  ctx.strokeStyle = mix(shirt, '#1c1838', 0.55); ctx.lineWidth = 9 * s; ctx.lineCap = 'round';
  const sw = Math.sin(phase) * 9 * s;
  ctx.beginPath(); ctx.moveTo(-6 * s, -28 * s); ctx.lineTo(-6 * s + sw, -3 * s); ctx.moveTo(6 * s, -28 * s); ctx.lineTo(6 * s - sw, -3 * s); ctx.stroke();
  ctx.fillStyle = shirt;
  rrect(ctx, -17 * s, -78 * s, 34 * s, 54 * s, 15 * s); ctx.fill();
  ctx.fillStyle = skin;
  ctx.beginPath(); ctx.arc(0, -94 * s, 14 * s, 0, TAU); ctx.fill();
  ctx.fillStyle = hair;
  ctx.beginPath(); ctx.arc(0, -98 * s, 14.5 * s, Math.PI * 1.02, Math.PI * 1.98); ctx.fill();
  ctx.restore();
}

function hut(ctx, x, y, s, roof, n, t, seed) {
  ctx.save();
  ctx.translate(x, y); ctx.scale(s, s);
  ctx.fillStyle = 'rgba(15,12,45,.22)';
  ctx.beginPath(); ctx.ellipse(8, 2, 120, 22, 0, 0, TAU); ctx.fill();
  const wall = mix('#f6e6cc', '#3d3868', n), wallSh = mix('#e2c9a6', '#2b2752', n);
  ctx.fillStyle = wall; rrect(ctx, -84, -118, 168, 120, 14); ctx.fill();
  ctx.fillStyle = wallSh; rrect(ctx, 30, -118, 54, 120, [0, 14, 14, 0]); ctx.fill();
  // door
  ctx.fillStyle = mix('#a8623f', '#231d44', n); rrect(ctx, -58, -76, 44, 78, [22, 22, 0, 0]); ctx.fill();
  // window
  const flick = 0.9 + 0.1 * Math.sin(t * 3 + seed * 9);
  ctx.fillStyle = mix('#8a6a5a', '#ffd88a', clamp(n * 1.3));
  rrect(ctx, 10, -84, 46, 46, 10); ctx.fill();
  if (n > 0.05) glow(ctx, 33, -61, 120, '#ffb45e', 0.5 * n * flick);
  // thatched roof
  ctx.fillStyle = mix(roof, '#252049', n * 0.85);
  ctx.beginPath();
  ctx.moveTo(-118, -104);
  ctx.quadraticCurveTo(-40, -150, 0, -214);
  ctx.quadraticCurveTo(40, -150, 118, -104);
  ctx.quadraticCurveTo(0, -128, -118, -104);
  ctx.fill();
  ctx.strokeStyle = mix(mix(roof, '#ffffff', 0.35).replace(/rgba\((\d+),(\d+),(\d+).*/, (m, r, g, b) => '#' + [r, g, b].map(v => (+v).toString(16).padStart(2, '0')).join('')), '#4a4480', n);
  ctx.lineWidth = 4; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(-70, -128); ctx.quadraticCurveTo(-30, -152, -4, -196); ctx.stroke();
  ctx.restore();
}

// ---------- text ----------
const SANS = '"Inter Display", Inter, sans-serif';
const SERIF = '"Bitstream Charter", Charter, Georgia, serif';
function richLine(ctx, str, x, y, size, alpha, { color = '#fffaf0', accent = '#ffd98a', weight = 600, shadow = 'rgba(12,8,36,.5)' } = {}) {
  if (alpha <= 0) return;
  const parts = str.split('*').map((s, i) => ({ s, acc: i % 2 === 1 })).filter(p => p.s);
  const font = p => (p.acc ? `italic 600 ${size * 1.06}px ${SERIF}` : `${weight} ${size}px ${SANS}`);
  let total = 0;
  parts.forEach(p => { ctx.font = font(p); p.w = ctx.measureText(p.s).width; total += p.w; });
  ctx.save();
  ctx.globalAlpha = alpha; ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
  if (shadow) { ctx.shadowColor = shadow; ctx.shadowBlur = size * 0.4; ctx.shadowOffsetY = size * 0.06; }
  let cx = x - total / 2;
  parts.forEach(p => { ctx.font = font(p); ctx.fillStyle = p.acc ? accent : color; ctx.fillText(p.s, cx, y); cx += p.w; });
  ctx.restore();
}
function caption(ctx, t, a, b, lines, y, size = 78, opts = {}) {
  lines.forEach((ln, i) => {
    const p = easeOut(prog(t, a + i * 0.25, a + i * 0.25 + 0.7));
    const out = 1 - prog(t, b - 0.45, b);
    richLine(ctx, ln, W / 2, y + i * size * 1.22 + (1 - p) * 30, size, p * out, opts);
  });
}
function label(ctx, str, x, y, size, alpha, color = '#fff6e6') {
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = alpha; ctx.fillStyle = color; ctx.textAlign = 'center';
  ctx.font = `600 ${size}px ${SANS}`;
  try { ctx.letterSpacing = `${size * 0.32}px`; } catch (e) {}
  ctx.shadowColor = 'rgba(12,8,36,.45)'; ctx.shadowBlur = 16;
  ctx.fillText(str, x + size * 0.16, y);
  ctx.restore();
}

// ---------- shared village (scenes 2, 4, 7) ----------
const pathX = y => 540 + Math.sin(y / 215 + 0.6) * 150 * ((y - 700) / 950 + 0.35);
const VILLAGE = (() => {
  const r = rng(11), items = [];
  const roofs = ['#d28a4a', '#c9743f', '#dba05a', '#b96b4a', '#cf9a52'];
  for (let row = 0; row < 8; row++) {
    const y = 830 + row * 138, s = 0.42 + row * 0.115;
    for (const side of [-1, 1]) {
      if (r() < 0.1) continue;
      const x = pathX(y) + side * (150 + r() * 120) * s * 1.55;
      items.push({ kind: 'hut', x, y: y + r() * 46, s, roof: roofs[Math.floor(r() * roofs.length)], seed: r() });
    }
    for (let k = 0; k < 2; k++) {
      const side = r() < 0.5 ? -1 : 1;
      const x = pathX(y) + side * (300 + r() * 330) * s * 1.2;
      items.push({ kind: 'palm', x, y: y + 30 + r() * 60, h: (250 + r() * 130) * s * 1.25, lean: (r() - 0.5) * 80 * s, seed: Math.floor(r() * 99) });
    }
  }
  items.sort((a, b) => a.y - b.y);
  return items;
})();
const HUTS = VILLAGE.filter(v => v.kind === 'hut');

// n: 0 day, 1 night. Draws sea band + hillside + path + huts + palms. Horizon near y=700.
function drawVillage(ctx, t, n, { people = false } = {}) {
  // sea
  ctx.fillStyle = vgrad(ctx, 610, 780, [[0, mix('#bfe6ea', '#2a2f6e', n)], [1, mix('#4fb0c4', '#151a48', n)]]);
  ctx.fillRect(-100, 610, W + 200, 200);
  for (let i = 0; i < 26; i++) {
    const y = 622 + hash(i, 4) * 110, x = hash(i, 9) * W, w = 30 + hash(i, 2) * 90;
    const a = (0.25 + 0.25 * Math.sin(t * 1.4 + i * 2.1)) * (1 - n * 0.6);
    ctx.fillStyle = `rgba(255,255,255,${a})`;
    rrect(ctx, x + Math.sin(t * 0.5 + i) * 14, y, w, 3, 2); ctx.fill();
  }
  // far headland
  ctx.fillStyle = mix('#8fc4b4', '#232a60', n);
  hill(ctx, 700, 70, 0.0032, 21); ctx.fill();
  // main hillside
  hill(ctx, 760, 46, 0.004, 5);
  ctx.fillStyle = vgrad(ctx, 700, 1920, [[0, mix('#9ed08c', '#27366a', n)], [0.45, mix('#5fae7e', '#19254f', n)], [1, mix('#2f7d68', '#0e1634', n)]]);
  ctx.fill();
  // soft light patches
  ctx.save(); ctx.globalAlpha = 0.5 * (1 - n);
  for (let i = 0; i < 7; i++) glow(ctx, 120 + hash(i, 31) * 840, 900 + hash(i, 32) * 800, 260, '#e9f5a0', 0.16);
  ctx.restore();
  // path
  ctx.beginPath();
  const pw = y => 10 + (y - 730) * 0.085;
  for (let y = 740; y <= 2000; y += 20) ctx.lineTo(pathX(y) - pw(y), y);
  for (let y = 2000; y >= 740; y -= 20) ctx.lineTo(pathX(y) + pw(y), y);
  ctx.closePath();
  ctx.fillStyle = vgrad(ctx, 740, 1920, [[0, mix('#f4e3b8', '#3a4078', n)], [1, mix('#e9c98f', '#272b5a', n)]]);
  ctx.fill();

  const walkers = [];
  if (people) {
    const shirts = ['#ff7f6a', '#ffd166', '#5cc8c2', '#f7a8c4', '#8fa8ff', '#ffffff', '#ff9f4a', '#b79cf2'];
    const skins = ['#f1c7a3', '#c98d68', '#8d5a3c', '#e3ae86', '#a8714b'];
    for (let i = 0; i < 17; i++) {
      const dir = i % 2 ? 1 : -1, speed = 26 + hash(i, 70) * 22;
      let y = 780 + ((hash(i, 71) * 1150 + dir * t * speed) % 1150 + 1150) % 1150;
      const s = 0.3 + (y - 760) / 1150 * 0.95;
      const lane = (hash(i, 72) - 0.5) * pw(y) * 1.3;
      walkers.push({ x: pathX(y) + lane, y, s, shirt: shirts[i % shirts.length], skin: skins[i % skins.length], ph: t * 6 + i });
    }
  }
  const all = VILLAGE.map(v => ({ ...v })).concat(walkers.map(w => ({ kind: 'person', ...w }))).sort((a, b) => a.y - b.y);
  for (const v of all) {
    if (v.kind === 'hut') hut(ctx, v.x, v.y, v.s, v.roof, n, t, v.seed);
    else if (v.kind === 'palm') {
      ctx.fillStyle = 'rgba(15,12,45,.18)';
      ctx.beginPath(); ctx.ellipse(v.x + v.h * 0.12, v.y, v.h * 0.2, v.h * 0.04, 0, 0, TAU); ctx.fill();
      palm(ctx, v.x, v.y, v.h, v.lean, t, mix('#2f7a5c', '#101a3c', n), v.seed, mix('#8fd68a', '#3b4d8a', n, 0.7));
    } else person(ctx, v.x, v.y, v.s, v.shirt, v.skin, v.ph);
  }
}

function stars(ctx, t, alpha, yMax = 1100, seed = 3) {
  if (alpha <= 0) return;
  ctx.save();
  for (let i = 0; i < 150; i++) {
    const x = hash(i, seed) * W, y = hash(i, seed + 1) * yMax, r = 0.8 + hash(i, seed + 2) * 1.9;
    const tw = 0.55 + 0.45 * Math.sin(t * (1 + hash(i, seed + 3) * 2) + i);
    ctx.fillStyle = `rgba(255,244,220,${alpha * tw * (0.4 + hash(i, seed + 4) * 0.6)})`;
    ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
  }
  ctx.restore();
}

const ORB_COLORS = ['#ffcf70', '#ff9d6c', '#8ee8d8', '#ffa3c7', '#a9b8ff', '#ffe29a', '#c7a6ff', '#9be7a8'];

// ---------- scene 1: dawn over the sea ----------
function scene1(ctx, t) {
  const s = prog(t, 0, 6.5), rise = easeOut(s);
  const z = lerp(1.1, 1.0, easeOut(s));
  ctx.save();
  ctx.translate(W / 2, 1060); ctx.scale(z, z); ctx.translate(-W / 2, -1060);
  ctx.fillStyle = vgrad(ctx, -100, 1070, [
    [0, mix('#141a4a', '#2c3a7c', rise)], [0.42, mix('#4a3a7e', '#8a6bb0', rise)],
    [0.72, mix('#b0607e', '#f09a94', rise)], [1, mix('#f09a6e', '#ffd9a0', rise)]]);
  ctx.fillRect(-100, -100, W + 200, 1180);
  stars(ctx, t, 0.9 * (1 - rise * 1.2), 760);
  const sunX = 610, sunY = lerp(1130, 930, rise);
  glow(ctx, sunX, sunY, 900, '#ffb070', 0.42);
  glow(ctx, sunX, sunY, 380, '#ffe2a8', 0.7);
  ctx.fillStyle = '#fff3cf'; ctx.beginPath(); ctx.arc(sunX, sunY, 92, 0, TAU); ctx.fill();
  // soft cloud bands
  for (let i = 0; i < 5; i++) {
    const y = 560 + i * 86, x = ((hash(i, 40) * 1400 + t * (6 + i * 2)) % 1500) - 250;
    ctx.fillStyle = `rgba(255,214,190,${0.16 + 0.05 * i})`;
    rrect(ctx, x, y, 420 + hash(i, 41) * 260, 22 + hash(i, 42) * 14, 20); ctx.fill();
    rrect(ctx, x + 120, y - 16, 240, 22, 20); ctx.fill();
  }
  // headland
  ctx.fillStyle = mix('#3a2f6e', '#6a5596', rise);
  ctx.beginPath(); ctx.moveTo(-100, 1062);
  for (let x = -100; x <= 470; x += 14) ctx.lineTo(x, 1062 - 120 * Math.pow(1 - (x + 100) / 570, 1.6) * (0.8 + 0.3 * noise1(x * 0.012, 8)));
  ctx.lineTo(470, 1062); ctx.fill();
  // sea
  ctx.fillStyle = vgrad(ctx, 1060, 1460, [[0, mix('#b06a86', '#f2a48c', rise)], [0.3, mix('#5a4a8e', '#7a78b8', rise)], [1, mix('#1d2460', '#2f4a8a', rise)]]);
  ctx.fillRect(-100, 1060, W + 200, 420);
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 90; i++) {
    const k = hash(i, 50), y = 1066 + k * k * 360;
    const spread = 30 + (y - 1060) * 0.75;
    const x = sunX + (hash(i, 51) - 0.5) * 2 * spread;
    const w = (14 + hash(i, 52) * 60) * (0.4 + k);
    const a = (0.5 + 0.5 * Math.sin(t * (1.6 + hash(i, 53) * 2) + i * 3.3)) * 0.55 * rise;
    ctx.fillStyle = `rgba(255,214,150,${a})`;
    rrect(ctx, x - w / 2, y, w, 3 + k * 4, 3); ctx.fill();
  }
  ctx.restore();
  // birds
  ctx.strokeStyle = 'rgba(40,28,80,.75)'; ctx.lineWidth = 3.5; ctx.lineCap = 'round';
  for (let i = 0; i < 4; i++) {
    const bx = 180 + i * 62 + t * 34, by = 800 - i * 34 + Math.sin(t + i) * 8, f = Math.sin(t * 7 + i * 1.3) * 9;
    ctx.beginPath(); ctx.moveTo(bx - 16, by - f); ctx.quadraticCurveTo(bx - 6, by - 4, bx, by); ctx.quadraticCurveTo(bx + 6, by - 4, bx + 16, by - f); ctx.stroke();
  }
  // beach
  const tide = Math.sin(t * 1.1) * 14;
  ctx.fillStyle = `rgba(255,236,214,${0.5})`;
  ctx.beginPath(); ctx.moveTo(-100, 1470 + tide);
  ctx.bezierCurveTo(260, 1380 + tide, 620, 1450 + tide, W + 100, 1352 + tide); ctx.lineTo(W + 100, 2000); ctx.lineTo(-100, 2000); ctx.fill();
  ctx.fillStyle = vgrad(ctx, 1380, 1920, [[0, mix('#6a4a7c', '#c98a80', rise)], [1, mix('#2a2050', '#5a3a66', rise)]]);
  ctx.beginPath(); ctx.moveTo(-100, 1490);
  ctx.bezierCurveTo(260, 1400, 620, 1470, W + 100, 1372); ctx.lineTo(W + 100, 2000); ctx.lineTo(-100, 2000); ctx.fill();
  // hut on the right dune
  hut(ctx, 800, 1560, 0.95, '#b96b4a', 0.85 - rise * 0.25, t, 0.4);
  hut(ctx, 560, 1640, 0.7, '#c9743f', 0.85 - rise * 0.25, t, 0.8);
  // foreground dune + palms
  ctx.fillStyle = '#1c1640';
  hill(ctx, 1800, 90, 0.004, 77); ctx.fill();
  ctx.restore();
  const fg = '#191338', rim = 'rgba(255,170,120,.55)';
  palm(ctx, 40 - (z - 1) * 600, 1940, 1020, 200, t, fg, 3, rim);
  palm(ctx, 1010 + (z - 1) * 600, 1960, 820, -190, t, fg, 8, rim);
  palm(ctx, 300 - (z - 1) * 300, 1960, 520, 70, t, fg, 5, rim);

  label(ctx, 'EDGE CITY INDIA · MANDREM, GOA', W / 2, 300, 26, easeOut(prog(t, 0.5, 1.3)) * (1 - prog(t, 5.6, 6.1)));
  caption(ctx, t, 0.9, 6.1, ['Edge City builds popup', 'villages *around the world*.'], 410, 74);
}

// ---------- scene 2: the village by day ----------
function scene2(ctx, t) {
  const dy = lerp(60, 0, easeOut(prog(t, 0, 6.5)));
  ctx.fillStyle = vgrad(ctx, 0, 720, [[0, '#6fb7e6'], [0.6, '#b7e0ee'], [1, '#ffeccb']]);
  ctx.fillRect(0, 0, W, 800);
  glow(ctx, 860, 190, 520, '#fff2c4', 0.55);
  for (let i = 0; i < 4; i++) {
    const x = ((hash(i, 60) * 1500 + t * (10 + i * 4)) % 1600) - 300, y = 150 + i * 120;
    ctx.fillStyle = 'rgba(255,255,255,.7)';
    rrect(ctx, x, y, 300, 44, 30); ctx.fill(); rrect(ctx, x + 70, y - 30, 170, 50, 30); ctx.fill();
  }
  ctx.save(); ctx.translate(0, dy);
  drawVillage(ctx, t, 0, { people: true });
  ctx.restore();
  // little question marks over a few walkers' heads region, kept abstract as floating dots
  const q = prog(t, 3.6, 4.4) * (1 - prog(t, 6.0, 6.5));
  if (q > 0) {
    for (let i = 0; i < 5; i++) {
      const x = 250 + i * 150 + Math.sin(i * 2.4) * 40, y = 1020 + (i % 2) * 210 + Math.sin(t * 2 + i) * 8;
      const p = spring(prog(t, 3.6 + i * 0.12, 4.5 + i * 0.12));
      ctx.save(); ctx.globalAlpha = q; ctx.translate(x, y); ctx.scale(p, p);
      ctx.fillStyle = 'rgba(255,255,255,.95)'; ctx.shadowColor = 'rgba(20,20,60,.25)'; ctx.shadowBlur = 18; ctx.shadowOffsetY = 6;
      ctx.beginPath(); ctx.arc(0, 0, 38, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.moveTo(-10, 32); ctx.lineTo(0, 54); ctx.lineTo(12, 30); ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.fillStyle = '#ff7f6a'; ctx.font = `700 46px ${SANS}`; ctx.textAlign = 'center'; ctx.fillText('?', 0, 17);
      ctx.restore();
    }
  }
  const dark = { color: '#1f2a5c', accent: '#e2553f', shadow: 'rgba(255,255,255,.55)' };
  caption(ctx, t, 0.4, 3.5, ['A few hundred people.', 'Three weeks together.'], 330, 70, dark);
  caption(ctx, t, 3.6, 6.6, ['So who should', 'you *meet*?'], 320, 92, dark);
}

// ---------- scene 3: an agent wakes up ----------
function scene3(ctx, t) {
  ctx.fillStyle = vgrad(ctx, 0, H, [[0, '#2a1b46'], [0.6, '#48264f'], [1, '#2c1a3c']]);
  ctx.fillRect(0, 0, W, H);
  // round skylight window
  const wx = 540, wy = 450, wr = 250;
  ctx.save();
  ctx.beginPath(); ctx.arc(wx, wy, wr, 0, TAU); ctx.clip();
  ctx.fillStyle = vgrad(ctx, wy - wr, wy + wr, [[0, '#6f8fd6'], [0.55, '#f2a9a0'], [1, '#ffd9a0']]);
  ctx.fillRect(wx - wr, wy - wr, wr * 2, wr * 2);
  glow(ctx, wx + 60, wy + 150, 260, '#fff0c0', 0.8);
  palm(ctx, wx - 230, wy + 420, 520, 150, t, '#2a2258', 4);
  ctx.restore();
  ctx.strokeStyle = '#6a3f5e'; ctx.lineWidth = 26; ctx.beginPath(); ctx.arc(wx, wy, wr, 0, TAU); ctx.stroke();
  ctx.strokeStyle = '#8a5672'; ctx.lineWidth = 6; ctx.beginPath(); ctx.arc(wx, wy, wr - 12, 0, TAU); ctx.stroke();
  ctx.strokeStyle = '#6a3f5e'; ctx.lineWidth = 12;
  ctx.beginPath(); ctx.moveTo(wx, wy - wr); ctx.lineTo(wx, wy + wr); ctx.moveTo(wx - wr, wy); ctx.lineTo(wx + wr, wy); ctx.stroke();
  // light shaft
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  const g = ctx.createLinearGradient(wx, wy, wx - 240, 1500);
  g.addColorStop(0, 'rgba(255,214,160,.30)'); g.addColorStop(1, 'rgba(255,190,150,0)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.moveTo(wx - wr * 0.9, wy - 60); ctx.lineTo(wx + wr * 0.9, wy + 60); ctx.lineTo(wx + 330, 1620); ctx.lineTo(wx - 620, 1620); ctx.fill();
  for (let i = 0; i < 46; i++) {
    const k = (hash(i, 90) + t * 0.02 * (0.5 + hash(i, 91))) % 1;
    const x = lerp(wx - 200 + hash(i, 92) * 400, wx - 520 + hash(i, 92) * 800, k) + Math.sin(t * 0.7 + i) * 14;
    const y = lerp(wy - 100, 1500, k);
    ctx.fillStyle = `rgba(255,230,190,${0.5 * Math.sin(k * Math.PI) * (0.5 + 0.5 * Math.sin(t * 2 + i * 5))})`;
    ctx.beginPath(); ctx.arc(x, y, 1.6 + hash(i, 93) * 2.4, 0, TAU); ctx.fill();
  }
  ctx.restore();
  // table
  ctx.fillStyle = vgrad(ctx, 1250, H, [[0, '#8a4f4e'], [0.12, '#6e3b48'], [1, '#3a2038']]);
  ctx.beginPath(); ctx.ellipse(540, 1250 + 900, 1100, 900, 0, 0, TAU); ctx.fill();
  ctx.strokeStyle = 'rgba(255,190,150,.45)'; ctx.lineWidth = 5;
  ctx.beginPath(); ctx.ellipse(540, 1250 + 900, 1100, 900, 0, Math.PI * 1.32, Math.PI * 1.68); ctx.stroke();
  // plant
  ctx.fillStyle = '#d0795a'; rrect(ctx, 120, 1250, 130, 120, [10, 10, 34, 34]); ctx.fill();
  ctx.fillStyle = '#3f8f72';
  for (let i = 0; i < 6; i++) {
    const a = -Math.PI / 2 + (i - 2.5) * 0.36 + Math.sin(t * 0.8 + i) * 0.03;
    ctx.save(); ctx.translate(185, 1256); ctx.rotate(a + Math.PI / 2);
    ctx.beginPath(); ctx.ellipse(0, -100, 26, 104, 0, 0, TAU); ctx.fill(); ctx.restore();
  }
  // cup with steam
  ctx.fillStyle = '#f4e3cf'; rrect(ctx, 820, 1290, 120, 96, [8, 8, 40, 40]); ctx.fill();
  ctx.strokeStyle = '#f4e3cf'; ctx.lineWidth = 12; ctx.beginPath(); ctx.arc(946, 1332, 26, -1.2, 1.2); ctx.stroke();
  ctx.strokeStyle = 'rgba(255,240,225,.35)'; ctx.lineWidth = 7; ctx.lineCap = 'round';
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    for (let k = 0; k <= 10; k++) { const yy = 1270 - k * 12; ctx.lineTo(850 + i * 30 + Math.sin(k * 0.7 + t * 2 + i) * 9, yy); }
    ctx.stroke();
  }
  // phone
  const px = 540, py = 1392;
  ctx.save(); ctx.translate(px, py); ctx.transform(1, 0, -0.25, 0.42, 0, 0);
  ctx.fillStyle = '#1b1430'; rrect(ctx, -130, -250, 260, 500, 40); ctx.fill();
  const lit = easeOut(prog(t, 0.5, 1.2));
  ctx.fillStyle = mix('#2a2146', '#ffe3a6', lit); rrect(ctx, -114, -234, 228, 468, 28); ctx.fill();
  ctx.restore();
  glow(ctx, px, py - 20, 330, '#ffc878', 0.5 * lit);

  // orb rises out of the phone
  const up = easeOut(prog(t, 1.0, 2.5));
  const oy = lerp(py - 10, 960, up) + Math.sin(t * 1.8) * 12 * up;
  const or = lerp(10, 92, spring(prog(t, 1.0, 2.6)));
  const chips = ['solar microgrids', 'ceramics', 'open science', 'long walks', 'sitar'];
  let pulse = 0;
  chips.forEach((c, i) => {
    const a0 = 3.3 + i * 0.5, k = prog(t, a0, a0 + 1.5);
    pulse += Math.max(0, 1 - Math.abs(t - (a0 + 1.5)) * 3);
    if (k <= 0 || k >= 1) return;
    const side = i % 2 ? 1 : -1;
    const sx = 540 + side * 620, sy = 700 + i * 110;
    const e = easeInOut(k);
    const x = lerp(sx, 540, e) + Math.sin(e * Math.PI) * side * -80;
    const y = lerp(sy, oy, e) - Math.sin(e * Math.PI) * 130;
    const sc = lerp(1, 0.25, easeIn(k)), al = 1 - easeIn(prog(k, 0.8, 1));
    ctx.save(); ctx.translate(x, y); ctx.scale(sc, sc); ctx.globalAlpha = al;
    ctx.font = `600 40px ${SANS}`;
    const w = ctx.measureText(c).width + 64;
    ctx.fillStyle = 'rgba(255,246,230,.95)'; ctx.shadowColor = 'rgba(255,190,120,.55)'; ctx.shadowBlur = 30;
    rrect(ctx, -w / 2, -40, w, 80, 40); ctx.fill();
    ctx.shadowColor = 'transparent'; ctx.fillStyle = '#4a2a52'; ctx.textAlign = 'center'; ctx.fillText(c, 0, 14);
    ctx.restore();
  });
  if (up > 0) {
    // trail back to the phone
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 12; i++) {
      const k = i / 12, yy = lerp(oy, py - 20, k);
      ctx.fillStyle = `rgba(255,210,130,${0.22 * (1 - k) * (1 - prog(t, 2.4, 3.4))})`;
      ctx.beginPath(); ctx.arc(540 + Math.sin(k * 6 + t * 3) * 10, yy, 16 * (1 - k) + 3, 0, TAU); ctx.fill();
    }
    ctx.restore();
    const blink = Math.max(0, 1 - Math.abs(((t * 0.45) % 1) - 0.5) * 30);
    orb(ctx, 540, oy, or * (1 + clamp(pulse) * 0.1), '#ffc869', { face: prog(t, 2.3, 2.8), blink, look: Math.sin(t * 1.3) });
  }
  caption(ctx, t, 1.3, 3.9, ['Residents can opt in', 'to their own *agent*.'], 1560, 80);
  caption(ctx, t, 4.1, 7.2, ['It learns what', 'you *care about*.'], 1560, 80);
}

// ---------- constellation shared by scenes 4 and 7 ----------
const CONST = (() => {
  const r = rng(29), pts = [];
  let guard = 0;
  while (pts.length < 17 && guard++ < 4000) {
    const x = 110 + r() * 860, y = 250 + r() * 800;
    if (pts.every(p => Math.hypot(p.x - x, p.y - y) > 170)) pts.push({ x, y });
  }
  const edges = [], seen = new Set();
  pts.forEach((p, i) => {
    pts.map((q, j) => ({ j, d: Math.hypot(p.x - q.x, p.y - q.y) })).filter(o => o.j !== i).sort((a, b) => a.d - b.d).slice(0, 2).forEach(o => {
      const key = [Math.min(i, o.j), Math.max(i, o.j)].join('-');
      if (!seen.has(key)) { seen.add(key); edges.push([i, o.j]); }
    });
  });
  let best = 0, bd = 1e9;
  edges.forEach(([a, b], i) => {
    const d = Math.hypot((pts[a].x + pts[b].x) / 2 - 540, (pts[a].y + pts[b].y) / 2 - 640);
    if (d < bd) { bd = d; best = i; }
  });
  return { pts, edges, best };
})();

// ---------- scene 4: the agents talk at night ----------
function scene4(ctx, t) {
  const cam = easeInOut(prog(t, 0.4, 3.6)) * 560;
  ctx.fillStyle = vgrad(ctx, 0, H, [[0, '#0b0f33'], [0.45, '#1c1f5c'], [0.75, '#4a3478'], [1, '#6a4480']]);
  ctx.fillRect(0, 0, W, H);
  stars(ctx, t, 0.95, 1300, 6);
  // moon
  const mx = 860, my = 250 + cam * 0.12;
  glow(ctx, mx, my, 360, '#cfd8ff', 0.3);
  ctx.fillStyle = '#f3efe0'; ctx.beginPath(); ctx.arc(mx, my, 62, 0, TAU); ctx.fill();
  ctx.fillStyle = '#12164a'; ctx.beginPath(); ctx.arc(mx + 26, my - 14, 54, 0, TAU); ctx.fill();
  ctx.save(); ctx.translate(0, cam);
  drawVillage(ctx, t, 1);
  ctx.restore();
  // dim the village a touch so the sky reads
  ctx.fillStyle = vgrad(ctx, 1150, H, [[0, 'rgba(10,12,44,0)'], [1, 'rgba(10,12,44,.55)']]);
  ctx.fillRect(0, 1150, W, H - 1150);

  const { pts, edges, best } = CONST;
  const pos = pts.map((p, i) => {
    const h = HUTS[i % HUTS.length];
    const t0 = 1.0 + hash(i, 120) * 2.0, k = prog(t, t0, t0 + 2.2), e = easeInOut(k);
    const sx = h.x + 33 * h.s, sy = h.y - 61 * h.s + cam;
    const fx = p.x + Math.sin(t * 0.8 + i * 2) * 9, fy = p.y + Math.cos(t * 0.7 + i * 1.3) * 9;
    return { x: lerp(sx, fx, e) + Math.sin(e * Math.PI) * (hash(i, 121) - 0.5) * 220, y: lerp(sy, fy, e), k, arr: t0 + 2.2 };
  });
  const spark = prog(t, 5.6, 6.3);
  ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.lineCap = 'round';
  edges.forEach(([a, b], i) => {
    const start = Math.max(pos[a].arr, pos[b].arr) + 0.1 + hash(i, 130) * 0.5;
    const d = easeOut(prog(t, start, start + 0.8));
    if (d <= 0) return;
    const A = pos[a], B = pos[b];
    const ex = lerp(A.x, B.x, d), ey = lerp(A.y, B.y, d);
    const hot = i === best ? spark : 0;
    ctx.strokeStyle = hot > 0 ? `rgba(255,214,120,${0.35 + 0.55 * hot})` : 'rgba(190,200,255,.34)';
    ctx.lineWidth = 2.5 + hot * 5;
    ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(ex, ey); ctx.stroke();
    if (d >= 1) {
      // messages travelling both ways
      for (const dir of [0, 1]) {
        const u = ((t * (0.45 + hash(i, 131) * 0.3) + hash(i, 132 + dir)) % 1);
        const k = dir ? 1 - u : u;
        const x = lerp(A.x, B.x, k), y = lerp(A.y, B.y, k);
        ctx.fillStyle = `rgba(255,240,210,${0.85 * Math.sin(u * Math.PI)})`;
        ctx.beginPath(); ctx.arc(x, y, 4.5 + hot * 3, 0, TAU); ctx.fill();
      }
    }
  });
  ctx.restore();
  pos.forEach((p, i) => {
    if (p.k <= 0) return;
    const isBest = edges[best].includes(i);
    const r = lerp(5, 15, easeOut(p.k)) * (isBest ? 1 + spark * 0.55 : 1);
    orb(ctx, p.x, p.y, r, isBest && spark > 0 ? mix(ORB_COLORS[i % 8], '#ffd060', spark).replace(/rgba\((\d+),(\d+),(\d+).*/, (m, r2, g, b) => '#' + [r2, g, b].map(v => (+v).toString(16).padStart(2, '0')).join('')) : ORB_COLORS[i % 8]);
  });
  // overlap found: rings on the bright pair
  if (spark > 0) {
    const [a, b] = edges[best];
    const cx = (pos[a].x + pos[b].x) / 2, cy = (pos[a].y + pos[b].y) / 2;
    for (let j = 0; j < 3; j++) {
      const k = ((t - 5.6) * 0.55 + j / 3) % 1;
      ctx.strokeStyle = `rgba(255,220,140,${(1 - k) * 0.6 * spark})`; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(cx, cy, 30 + k * 190, 0, TAU); ctx.stroke();
    }
    glow(ctx, cx, cy, 300, '#ffc864', 0.35 * spark);
  }
  caption(ctx, t, 0.9, 4.9, ['While you live your day,', 'it *advocates* for you.'], 1480, 76);
  caption(ctx, t, 5.2, 8.6, ['Agents negotiate,', 'looking for *overlap*.'], 1480, 84);
}

// ---------- scene 5: the morning brief ----------
function scene5(ctx, t) {
  ctx.fillStyle = vgrad(ctx, 0, H, [[0, '#ffd9a8'], [0.5, '#ffc2a6'], [1, '#f39a98']]);
  ctx.fillRect(0, 0, W, H);
  glow(ctx, 540, 180, 900, '#fff6d6', 0.8);
  for (let i = 0; i < 14; i++) {
    const x = hash(i, 140) * W + Math.sin(t * 0.3 + i) * 30, y = (hash(i, 141) * H + t * (8 + hash(i, 142) * 14)) % H;
    glow(ctx, x, H - y, 60 + hash(i, 143) * 90, '#fff2d0', 0.16);
  }
  palm(ctx, -120, 700, 640, 200, t, '#f4a996', 3);
  palm(ctx, 1200, 820, 700, -200, t, '#f4ab98', 9);

  const cy0 = 440 + (1 - easeOut(prog(t, 0, 0.9))) * 900 + Math.sin(t * 1.1) * 6;
  const cx0 = 150, cw = 780, ch = 1190;
  ctx.save();
  ctx.shadowColor = 'rgba(120,40,60,.35)'; ctx.shadowBlur = 80; ctx.shadowOffsetY = 36;
  ctx.fillStyle = '#fffaf2'; rrect(ctx, cx0, cy0, cw, ch, 56); ctx.fill();
  ctx.restore();
  // header
  orb(ctx, cx0 + 92, cy0 + 96, 36, '#ffc869', { face: 1, blink: Math.max(0, 1 - Math.abs(((t * 0.4) % 1) - 0.5) * 30) });
  ctx.fillStyle = '#2c2146'; ctx.font = `700 46px ${SANS}`; ctx.textAlign = 'left'; ctx.fillText('Your agent', cx0 + 154, cy0 + 92);
  ctx.fillStyle = '#9a8798'; ctx.font = `500 32px ${SANS}`; ctx.fillText('Morning brief · 08:00', cx0 + 154, cy0 + 136);
  ctx.fillStyle = '#f1e6da'; ctx.fillRect(cx0 + 48, cy0 + 182, cw - 96, 3);

  const block = (a, y, h, fn, fill = '#fdf0e2') => {
    const p = spring(prog(t, a, a + 0.8));
    if (p <= 0) return;
    ctx.save(); ctx.globalAlpha = clamp(p * 1.5);
    ctx.translate(cx0 + 48, cy0 + y + (1 - p) * 40);
    ctx.fillStyle = fill; rrect(ctx, 0, 0, cw - 96, h, 34); ctx.fill();
    fn(); ctx.restore();
  };
  const txt = (s, x, y, size, color, w = 500) => { ctx.fillStyle = color; ctx.font = `${w} ${size}px ${SANS}`; ctx.textAlign = 'left'; ctx.fillText(s, x, y); };
  block(1.0, 214, 110, () => txt('Good morning, Maya.', 36, 70, 44, '#2c2146', 600));
  block(1.7, 350, 290, () => {
    txt('TODAY', 36, 60, 26, '#c9705c', 700);
    [['07:30', 'Sunrise yoga, beach deck'], ['16:00', 'Open science salon']].forEach(([h, e], i) => {
      const y = 126 + i * 96;
      ctx.fillStyle = '#ffd9a8'; rrect(ctx, 36, y - 46, 132, 64, 20); ctx.fill();
      txt(h, 54, y, 34, '#8a4a2c', 700); txt(e, 192, y, 36, '#2c2146', 500);
    });
  });
  block(2.6, 666, 350, () => {
    txt('SOMEONE TO MEET', 36, 60, 26, '#3b8f84', 700);
    ctx.fillStyle = '#5cc8c2'; ctx.beginPath(); ctx.arc(86, 150, 50, 0, TAU); ctx.fill();
    ctx.fillStyle = '#c98d68'; ctx.beginPath(); ctx.arc(86, 140, 22, 0, TAU); ctx.fill();
    ctx.save(); ctx.beginPath(); ctx.arc(86, 150, 50, 0, TAU); ctx.clip();
    ctx.fillStyle = '#2f7d78'; ctx.beginPath(); ctx.ellipse(86, 212, 44, 36, 0, 0, TAU); ctx.fill(); ctx.restore();
    txt('Arjun', 160, 138, 44, '#2c2146', 700);
    txt('Also builds solar microgrids', 160, 188, 32, '#6f5f78', 500);
    const press = 1 - 0.07 * Math.sin(prog(t, 3.9, 4.3) * Math.PI), done = prog(t, 4.1, 4.3);
    ctx.save(); ctx.translate(176, 276); ctx.scale(press, press);
    ctx.fillStyle = mix('#3b8f84', '#2c2146', done); rrect(ctx, -140, -40, 280, 80, 40); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = `700 34px ${SANS}`; ctx.textAlign = 'center'; ctx.fillText(done > 0.5 ? 'Approved' : 'Approve intro', 0, 12);
    ctx.restore();
    ctx.strokeStyle = '#9cc9c1'; ctx.lineWidth = 3; rrect(ctx, 340, 236, 200, 80, 40); ctx.stroke();
    ctx.fillStyle = '#3b8f84'; ctx.font = `600 34px ${SANS}`; ctx.textAlign = 'center'; ctx.fillText('Not now', 440, 288);
  }, '#e6f6f1');
  // accepted notification
  const n = spring(prog(t, 4.7, 5.6));
  if (n > 0) {
    ctx.save(); ctx.globalAlpha = clamp(n * 1.5);
    ctx.translate(cx0 + 48, cy0 + 1034 + (1 - n) * 50);
    ctx.fillStyle = '#2c2146'; rrect(ctx, 0, 0, cw - 96, 130, 40); ctx.fill();
    ctx.fillStyle = '#7fe0b0'; ctx.beginPath(); ctx.arc(70, 65, 34, 0, TAU); ctx.fill();
    ctx.strokeStyle = '#2c2146'; ctx.lineWidth = 8; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const c = prog(t, 5.1, 5.6);
    ctx.beginPath(); ctx.moveTo(54, 66); ctx.lineTo(54 + 12 * clamp(c * 2), 66 + 12 * clamp(c * 2));
    if (c > 0.5) ctx.lineTo(66 + 22 * (c - 0.5) * 2, 78 - 26 * (c - 0.5) * 2);
    ctx.stroke();
    txt('Arjun said yes. You’re connected.', 124, 77, 32, '#fff6e6', 600);
    ctx.restore();
    glow(ctx, cx0 + 118, cy0 + 1099, 200, '#7fe0b0', 0.25 * n * (1 - prog(t, 5.6, 6.6)));
  }
  const dark = { color: '#3a1f4a', accent: '#c8452f', shadow: 'rgba(255,255,255,.5)' };
  caption(ctx, t, 0.5, 7.2, ['You approve', 'every *introduction*.'], 240, 78, dark);
}

// ---------- scene 6: the meeting ----------
function bigPerson(ctx, x, y, s, shirt, skin, hair, t, flip) {
  ctx.save(); ctx.translate(x, y); ctx.scale(flip ? -s : s, s);
  const nod = Math.sin(t * 2.2 + (flip ? 1.4 : 0)) * 0.04;
  // stool
  ctx.fillStyle = '#3a1e3e'; rrect(ctx, -70, -150, 140, 26, 12); ctx.fill();
  ctx.fillRect(-52, -130, 14, 130); ctx.fillRect(38, -130, 14, 130);
  // legs
  ctx.strokeStyle = mix(shirt, '#2a1a40', 0.6); ctx.lineWidth = 46; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath(); ctx.moveTo(-6, -170); ctx.lineTo(96, -160); ctx.lineTo(104, -24); ctx.stroke();
  // torso
  ctx.fillStyle = shirt;
  ctx.beginPath(); ctx.moveTo(-64, -160); ctx.quadraticCurveTo(-78, -420, 0, -430); ctx.quadraticCurveTo(74, -420, 62, -160); ctx.closePath(); ctx.fill();
  // arm reaching to the cup
  ctx.strokeStyle = mix(shirt, '#ffffff', 0.12); ctx.lineWidth = 36;
  ctx.beginPath(); ctx.moveTo(30, -372); ctx.quadraticCurveTo(70, -250, 150, -262 + Math.sin(t * 2.2) * 6); ctx.stroke();
  ctx.fillStyle = skin; ctx.beginPath(); ctx.arc(158, -264 + Math.sin(t * 2.2) * 6, 22, 0, TAU); ctx.fill();
  // head
  ctx.rotate(nod);
  ctx.fillStyle = skin; rrect(ctx, -18, -462, 40, 50, 14); ctx.fill();
  ctx.beginPath(); ctx.arc(6, -510, 64, 0, TAU); ctx.fill();
  ctx.fillStyle = hair;
  ctx.beginPath(); ctx.arc(0, -522, 68, Math.PI * 0.95, Math.PI * 2.08); ctx.quadraticCurveTo(10, -540, -66, -500); ctx.fill();
  ctx.fillStyle = '#2a1a33'; ctx.beginPath(); ctx.ellipse(40, -506, 5, 7, 0, 0, TAU); ctx.fill();
  ctx.strokeStyle = '#2a1a33'; ctx.lineWidth = 5; ctx.beginPath(); ctx.arc(34, -486, 16, 0.2, 1.5); ctx.stroke();
  ctx.restore();
}
function scene6(ctx, t) {
  const z = lerp(1.07, 1.0, easeOut(prog(t, 0, 6)));
  ctx.save(); ctx.translate(W / 2, 1100); ctx.scale(z, z); ctx.translate(-W / 2, -1100);
  ctx.fillStyle = vgrad(ctx, -100, 1080, [[0, '#5a4a9a'], [0.4, '#d6728e'], [0.75, '#ff9d6a'], [1, '#ffd28a']]);
  ctx.fillRect(-100, -100, W + 200, 1200);
  const sx = 760, sy = 1010;
  glow(ctx, sx, sy, 800, '#ffb86a', 0.55);
  ctx.fillStyle = '#fff0c4'; ctx.beginPath(); ctx.arc(sx, sy, 110, 0, TAU); ctx.fill();
  for (let i = 0; i < 4; i++) {
    const x = ((hash(i, 160) * 1400 + t * (8 + i * 3)) % 1500) - 250, y = 520 + i * 90;
    ctx.fillStyle = 'rgba(255,190,170,.32)'; rrect(ctx, x, y, 460, 24, 20); ctx.fill(); rrect(ctx, x + 100, y - 18, 240, 24, 20); ctx.fill();
  }
  ctx.fillStyle = vgrad(ctx, 1080, 1300, [[0, '#ffb07a'], [1, '#8a4a8a']]);
  ctx.fillRect(-100, 1080, W + 200, 240);
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 60; i++) {
    const k = hash(i, 170), y = 1086 + k * k * 200, sp = 40 + (y - 1080) * 1.1;
    const x = sx + (hash(i, 171) - 0.5) * 2 * sp, w = (16 + hash(i, 172) * 60) * (0.5 + k);
    ctx.fillStyle = `rgba(255,226,160,${(0.5 + 0.5 * Math.sin(t * 2 + i * 3)) * 0.5})`;
    rrect(ctx, x - w / 2, y, w, 4, 3); ctx.fill();
  }
  ctx.restore();
  // deck
  ctx.fillStyle = vgrad(ctx, 1290, H, [[0, '#7a3f62'], [1, '#33193c']]);
  ctx.fillRect(-100, 1290, W + 200, 800);
  ctx.strokeStyle = 'rgba(255,170,130,.18)'; ctx.lineWidth = 3;
  for (let i = 0; i < 9; i++) { ctx.beginPath(); ctx.moveTo(540 + (i - 4) * 60, 1290); ctx.lineTo(540 + (i - 4) * 300, 2000); ctx.stroke(); }
  ctx.strokeStyle = 'rgba(255,190,150,.5)'; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(-100, 1291); ctx.lineTo(W + 100, 1291); ctx.stroke();
  ctx.restore();
  palm(ctx, -10, 1500, 640, 150, t, '#2a1640', 6, 'rgba(255,170,120,.5)');
  // people + table
  bigPerson(ctx, 270, 1720, 1.0, '#3fb3ad', '#c98d68', '#241a2e', t, false);
  bigPerson(ctx, 820, 1720, 1.0, '#ff7f6a', '#f1c7a3', '#5a2e2a', t, true);
  ctx.fillStyle = '#4a2748'; rrect(ctx, 370, 1444, 340, 30, 15); ctx.fill();
  ctx.fillRect(526, 1470, 28, 260);
  rrect(ctx, 450, 1716, 180, 22, 11); ctx.fill();
  ctx.strokeStyle = 'rgba(255,190,150,.6)'; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(386, 1446); ctx.lineTo(694, 1446); ctx.stroke();
  for (const cxp of [436, 644]) {
    ctx.fillStyle = '#ffe8cf'; rrect(ctx, cxp - 26, 1398, 52, 46, [6, 6, 20, 20]); ctx.fill();
    ctx.strokeStyle = 'rgba(255,240,225,.4)'; ctx.lineWidth = 6; ctx.lineCap = 'round';
    ctx.beginPath();
    for (let k = 0; k <= 8; k++) ctx.lineTo(cxp + Math.sin(k * 0.8 + t * 2.2 + cxp) * 8, 1386 - k * 11);
    ctx.stroke();
  }
  // string lights
  for (let row = 0; row < 2; row++) {
    const y0 = 130 + row * 150, sag = 150 - row * 40;
    ctx.strokeStyle = 'rgba(40,20,60,.7)'; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(-20, y0); ctx.quadraticCurveTo(540, y0 + sag * 2, W + 20, y0 - 30); ctx.stroke();
    for (let i = 1; i < 10; i++) {
      const k = i / 10, x = lerp(lerp(-20, 540, k), lerp(540, W + 20, k), k);
      const y = lerp(lerp(y0, y0 + sag * 2, k), lerp(y0 + sag * 2, y0 - 30, k), k) + 16;
      const f = 0.8 + 0.2 * Math.sin(t * 3 + i * 2 + row);
      glow(ctx, x, y, 80, '#ffd27a', 0.55 * f);
      ctx.fillStyle = '#fff1c2'; ctx.beginPath(); ctx.arc(x, y, 10, 0, TAU); ctx.fill();
    }
  }
  // the two agents dance above
  const a = t * 1.5, rad = 86 + Math.sin(t * 0.9) * 16, ox = 540, oy = 1010 + Math.sin(t * 1.2) * 16;
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  for (let j = 1; j < 22; j++) {
    const aa = a - j * 0.07;
    for (const [ph, c] of [[0, '255,200,105'], [Math.PI, '142,232,216']]) {
      ctx.fillStyle = `rgba(${c},${0.2 * (1 - j / 22)})`;
      ctx.beginPath(); ctx.arc(ox + Math.cos(aa + ph) * rad, oy + Math.sin(aa + ph) * rad * 0.45, 22 * (1 - j / 22), 0, TAU); ctx.fill();
    }
  }
  ctx.restore();
  const blink = Math.max(0, 1 - Math.abs(((t * 0.5) % 1) - 0.5) * 30);
  const o1 = { x: ox + Math.cos(a) * rad, y: oy + Math.sin(a) * rad * 0.45 }, o2 = { x: ox - Math.cos(a) * rad, y: oy - Math.sin(a) * rad * 0.45 };
  const first = Math.sin(a) < 0 ? [o1, '#ffc869', o2, '#8ee8d8'] : [o2, '#8ee8d8', o1, '#ffc869'];
  orb(ctx, first[0].x, first[0].y, 44, first[1], { face: 1, blink });
  orb(ctx, first[2].x, first[2].y, 44, first[3], { face: 1, blink });
  caption(ctx, t, 0.6, 6.3, ['You just show up', 'for the *conversation*.'], 580, 80);
}

// ---------- scene 7: title ----------
function scene7(ctx, t) {
  const cam = lerp(420, 330, easeOut(prog(t, 0, 6)));
  ctx.fillStyle = vgrad(ctx, 0, H, [[0, '#101544'], [0.4, '#3a2f7a'], [0.62, '#b0608e'], [0.75, '#ff9d7a']]);
  ctx.fillRect(0, 0, W, H);
  stars(ctx, t, 0.9, 900, 12);
  glow(ctx, 540, 1050, 700, '#ffa878', 0.4);
  ctx.save(); ctx.translate(0, cam);
  drawVillage(ctx, t, 0.82);
  ctx.restore();
  ctx.fillStyle = vgrad(ctx, 1250, H, [[0, 'rgba(10,12,44,0)'], [0.45, 'rgba(10,12,44,.62)'], [1, 'rgba(10,12,44,.8)']]);
  ctx.fillRect(0, 1250, W, H - 1250);
  // arch of linked agents above the title
  const N = 11, pts = [];
  for (let i = 0; i < N; i++) {
    const k = i / (N - 1), ang = Math.PI * (1.08 - k * 1.16);
    const jx = (hash(i, 200) - 0.5) * 50, jy = (hash(i, 201) - 0.5) * 70;
    const fx = 540 + Math.cos(ang) * 430 + jx + Math.sin(t * 0.8 + i) * 7, fy = 520 - Math.sin(ang) * 260 + jy + Math.cos(t * 0.7 + i * 2) * 7;
    const h = HUTS[(i * 2 + 3) % HUTS.length];
    const e = easeInOut(prog(t, 0.1 + i * 0.07, 1.5 + i * 0.07));
    pts.push({ x: lerp(h.x, fx, e), y: lerp(h.y + cam - 60 * h.s, fy, e), e });
  }
  ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.lineCap = 'round';
  for (let i = 0; i < N - 1; i++) {
    const d = easeOut(prog(t, 1.5 + i * 0.09, 2.2 + i * 0.09));
    if (d <= 0) continue;
    const A = pts[i], B = pts[i + 1];
    ctx.strokeStyle = 'rgba(255,224,170,.5)'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(lerp(A.x, B.x, d), lerp(A.y, B.y, d)); ctx.stroke();
    if (d >= 1) {
      const u = (t * 0.5 + i * 0.37) % 1;
      ctx.fillStyle = `rgba(255,244,214,${Math.sin(u * Math.PI) * 0.9})`;
      ctx.beginPath(); ctx.arc(lerp(A.x, B.x, u), lerp(A.y, B.y, u), 4.5, 0, TAU); ctx.fill();
    }
  }
  ctx.restore();
  pts.forEach((p, i) => orb(ctx, p.x, p.y, lerp(6, 17, p.e), ORB_COLORS[i % 8]));

  const tp = easeOut(prog(t, 1.9, 2.9));
  glow(ctx, 540, 600, 520, '#ffb880', 0.22 * tp);
  ctx.save();
  ctx.globalAlpha = tp; ctx.textAlign = 'center';
  ctx.shadowColor = 'rgba(12,8,40,.55)'; ctx.shadowBlur = 40; ctx.shadowOffsetY = 6;
  ctx.fillStyle = '#fffaf0'; ctx.font = `700 148px ${SANS}`;
  try { ctx.letterSpacing = '-3px'; } catch (e) {}
  ctx.fillText('Agent', 540, 560 + (1 - tp) * 30);
  ctx.font = `italic 600 164px ${SERIF}`; ctx.fillStyle = '#ffd98a';
  try { ctx.letterSpacing = '0px'; } catch (e) {}
  ctx.fillText('Village', 540, 712 + (1 - tp) * 30);
  ctx.restore();
  label(ctx, 'A FIELD EXPERIMENT AT EDGE CITY INDIA', W / 2, 800, 22, easeOut(prog(t, 2.6, 3.4)));
  const a1 = easeOut(prog(t, 3.3, 4.1)), a2 = easeOut(prog(t, 3.7, 4.5));
  richLine(ctx, 'Agents find the *overlap*.', W / 2, 1560 + (1 - a1) * 24, 60, a1);
  richLine(ctx, 'People do the *meeting*.', W / 2, 1640 + (1 - a2) * 24, 60, a2);
}

// ---------- timeline ----------
const SCENES = [
  { fn: scene1, a: 0, b: 6.5 },
  { fn: scene2, a: 6.0, b: 13.0 },
  { fn: scene3, a: 12.5, b: 20.2 },
  { fn: scene4, a: 19.7, b: 28.8 },
  { fn: scene5, a: 28.3, b: 36.0 },
  { fn: scene6, a: 35.5, b: 42.3 },
  { fn: scene7, a: 41.8, b: DUR },
];

let main, mctx, buf, bctx, grain;
function makeGrain() {
  const c = document.createElement('canvas'); c.width = c.height = 512;
  const x = c.getContext('2d'), id = x.createImageData(512, 512), r = rng(99);
  for (let i = 0; i < id.data.length; i += 4) {
    const v = 128 + (r() + r() + r() - 1.5) * 90;
    id.data[i] = id.data[i + 1] = id.data[i + 2] = v; id.data[i + 3] = 255;
  }
  x.putImageData(id, 0, 0);
  return c;
}
function init(canvas) {
  main = canvas; main.width = W; main.height = H; mctx = main.getContext('2d');
  buf = document.createElement('canvas'); buf.width = W; buf.height = H; bctx = buf.getContext('2d');
  grain = makeGrain();
}
function paintScene(ctx, sc, t) {
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, W, H);
  sc.fn(ctx, t - sc.a);
  ctx.restore();
}
function draw(frame) {
  const t = frame / FPS;
  const active = SCENES.filter(s => t >= s.a && t < s.b);
  paintScene(mctx, active[0], t);
  if (active[1]) {
    paintScene(bctx, active[1], t);
    mctx.save(); mctx.globalAlpha = easeInOut(prog(t, active[1].a, active[0].b)); mctx.drawImage(buf, 0, 0); mctx.restore();
  }
  // finishing: bloom-ish lift, vignette, grain, fades
  const v = mctx.createRadialGradient(W / 2, H * 0.48, H * 0.3, W / 2, H * 0.5, H * 0.78);
  v.addColorStop(0, 'rgba(20,10,40,0)'); v.addColorStop(1, 'rgba(20,10,40,.42)');
  mctx.fillStyle = v; mctx.fillRect(0, 0, W, H);
  mctx.save(); mctx.globalCompositeOperation = 'overlay'; mctx.globalAlpha = 0.16;
  const ox = Math.floor(hash(frame, 1) * 512), oy = Math.floor(hash(frame, 2) * 512);
  for (let y = -oy; y < H; y += 512) for (let x = -ox; x < W; x += 512) mctx.drawImage(grain, x, y);
  mctx.restore();
  const fade = Math.max(1 - prog(t, 0, 0.7), prog(t, DUR - 0.9, DUR - 0.1));
  if (fade > 0) { mctx.fillStyle = `rgba(12,8,32,${fade})`; mctx.fillRect(0, 0, W, H); }
}
window.film = { init, draw, W, H, FPS, DUR, frames: Math.round(DUR * FPS) };
