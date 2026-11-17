'use strict';
/* ───────────────────────── Mini golf: 6 holes for 1–8 players ─────────────────────────
 * Everybody plays at the same time with their own ball (balls do not hit each other). Fewest strokes in total wins.
 * The host simulates every ball and streams the positions. Aim: drag back from anywhere (slingshot), release to putt. */
(() => {
  const esc = Party.esc;
  const W = 800, H = 500, BR = 7, CUPR = 12, WALL = 3, MAX_STROKES = 7, FIXED = 1 / 240;
  const box = (x, y, w, h) => [[x, y, x + w, y], [x + w, y, x + w, y + h], [x + w, y + h, x, y + h], [x, y + h, x, y]];
  const BORDER = box(20, 20, 760, 460);

  /* walls are line segments; "bar" is a rotating windmill blade; "sand" slows the ball down */
  const HOLES = [
    { par: 2, tee: [90, 250], cup: [705, 250], walls: [], sand: [] },
    { par: 3, tee: [90, 410], cup: [705, 110], walls: box(380, 150, 40, 330), sand: [] },
    { par: 3, tee: [90, 250], cup: [710, 250], walls: [...box(250, 90, 36, 130), ...box(250, 280, 36, 130), ...box(480, 190, 36, 120)], sand: [] },
    { par: 3, tee: [90, 250], cup: [710, 250], walls: [...box(385, 20, 30, 195), ...box(385, 285, 30, 195)], sand: [[250, 20, 300, 460]] },
    { par: 3, tee: [90, 250], cup: [710, 250], walls: [...box(385, 20, 30, 120), ...box(385, 360, 30, 120)], sand: [], bar: { cx: 400, cy: 250, len: 92, speed: 1.7 } },
    { par: 4, tee: [75, 425], cup: [715, 425], walls: [...box(185, 20, 30, 330), ...box(385, 150, 30, 330), ...box(585, 20, 30, 330)], sand: [[620, 300, 160, 100]] },
  ];

  const barSeg = (h, t) => { const b = h.bar; const a = b.speed * t; const dx = Math.cos(a) * b.len, dy = Math.sin(a) * b.len; return [b.cx - dx, b.cy - dy, b.cx + dx, b.cy + dy]; };
  const holeWalls = (h, t) => [...BORDER, ...h.walls, ...(h.bar ? [barSeg(h, t)] : [])];
  const inSand = (h, b) => h.sand.some(([x, y, w, ht]) => b.x > x && b.x < x + w && b.y > y && b.y < y + ht);

  function collide(b, segs) {
    for (const [x1, y1, x2, y2] of segs) {
      const dx = x2 - x1, dy = y2 - y1;
      const l2 = dx * dx + dy * dy;
      let t = ((b.x - x1) * dx + (b.y - y1) * dy) / l2;
      t = Math.max(0, Math.min(1, t));
      const px = x1 + dx * t, py = y1 + dy * t;
      let ex = b.x - px, ey = b.y - py;
      let d = Math.hypot(ex, ey);
      if (d < BR + WALL) {
        if (d === 0) { ex = 1; ey = 0; d = 1; }
        const nx = ex / d, ny = ey / d;
        b.x = px + nx * (BR + WALL); b.y = py + ny * (BR + WALL);
        const vn = b.vx * nx + b.vy * ny;
        if (vn < 0) { b.vx -= 1.72 * vn * nx; b.vy -= 1.72 * vn * ny; }
      }
    }
  }

  /* ───────────── host ───────────── */

  function create(ctx) {
    const g = { phase: 'lobby', hole: 0, players: [], t0: performance.now(), text: '' };
    let lastPush = 0;
    const timers = new Set();
    const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); };
    const now = () => (performance.now() - g.t0) / 1000;

    const resetBall = (p) => { const h = HOLES[g.hole]; Object.assign(p, { x: h.tee[0], y: h.tee[1], vx: 0, vy: 0, strokes: 0, done: false, moving: false }); };

    function beginHole() {
      g.phase = 'play'; g.t0 = performance.now();
      for (const p of g.players) resetBall(p);
      g.text = `Hole ${g.hole + 1} · par ${HOLES[g.hole].par}`;
      ctx.push();
    }

    function checkHoleEnd() {
      if (g.phase !== 'play' || g.players.some((p) => !p.done)) return;
      g.phase = 'between';
      for (const p of g.players) { p.scores[g.hole] = p.strokes; p.total = p.scores.reduce((a, b) => a + (b || 0), 0); }
      g.text = `Hole ${g.hole + 1} done`;
      later(() => {
        if (g.hole + 1 >= HOLES.length) {
          g.phase = 'over';
          const best = Math.min(...g.players.map((p) => p.total));
          g.text = `${g.players.filter((p) => p.total === best).map((p) => p.user).join(' & ')} win${g.players.filter((p) => p.total === best).length > 1 ? '' : 's'}!`;
          ctx.push();
        } else { g.hole++; beginHole(); }
      }, window.__PARTY_FAST ? 400 : 3800);
      ctx.push();
    }

    let lastTick = performance.now();
    const timer = setInterval(() => {
      const clock = performance.now();
      const moving = g.phase === 'play' ? g.players.filter((p) => p.moving) : [];
      if (!moving.length) { lastTick = clock; return; }
      const h = HOLES[g.hole];
      const steps = Math.min(240, Math.max(1, Math.round((clock - lastTick) / 1000 / FIXED)));   // real time, also when the window is in the background
      lastTick = clock;
      const tNow = now();
      const segs = holeWalls(h, tNow);
      for (let n = 0; n < steps; n++) {
        for (const p of moving) {
          if (!p.moving) continue;
          p.x += p.vx * FIXED; p.y += p.vy * FIXED;
          const sp = Math.hypot(p.vx, p.vy);
          const sand = inSand(h, p);
          const ns = sp - ((sand ? 2.6 : 0.6) * sp + (sand ? 90 : 30)) * FIXED;
          if (ns < 7) { p.vx = 0; p.vy = 0; } else { p.vx *= ns / sp; p.vy *= ns / sp; }
          collide(p, segs);
          const dc = Math.hypot(p.x - h.cup[0], p.y - h.cup[1]);
          if (dc < CUPR && Math.hypot(p.vx, p.vy) < 480) {
            p.x = h.cup[0]; p.y = h.cup[1]; p.vx = 0; p.vy = 0; p.moving = false; p.done = true; p.sunk = true;
            g.text = `${p.user} sank it in ${p.strokes}!`;
          } else if (!p.vx && !p.vy) {
            p.moving = false;
            if (p.strokes >= MAX_STROKES) { p.done = true; p.sunk = false; }
          }
        }
      }
      if (performance.now() - lastPush > 33 || moving.some((p) => !p.moving)) { lastPush = performance.now(); ctx.push(); }
      checkHoleEnd();
    }, 20);

    return {
      _g: g,
      onJoin(p) {
        const q = { conn: p.conn, user: p.user, x: 0, y: 0, vx: 0, vy: 0, strokes: 0, done: false, moving: false, sunk: false, total: 0, scores: [] };
        for (let i = 0; i < g.hole; i++) q.scores[i] = HOLES[i].par + 2;     // missed holes count as par + 2
        q.total = q.scores.reduce((a, b) => a + b, 0);
        resetBall(q);
        g.players.push(q);
      },
      onLeave(conn) {
        const i = g.players.findIndex((p) => p.conn === conn);
        if (i < 0) return;
        g.players.splice(i, 1);
        if (!g.players.length) g.phase = 'lobby';
        else checkHoleEnd();
      },
      onAct(from, a) {
        if (a.start) {
          if (from === ctx.me.conn && g.phase !== 'play' && g.phase !== 'between' && g.players.length) {
            g.hole = 0;
            for (const p of g.players) { p.scores = []; p.total = 0; p.sunk = false; }
            beginHole();
          }
          return;
        }
        if (a.skip) {
          if (from === ctx.me.conn && g.phase === 'play') {
            for (const p of g.players) if (!p.done) { p.strokes = Math.max(p.strokes, MAX_STROKES); p.done = true; p.moving = false; p.vx = p.vy = 0; }
            checkHoleEnd();
          }
          return;
        }
        const p = g.players.find((q) => q.conn === from);
        if (!a.shot || !p || g.phase !== 'play' || p.done || p.moving) return;
        const ang = +a.shot.a, pw = Math.min(1, Math.max(0, +a.shot.p));
        if (!Number.isFinite(ang) || !Number.isFinite(pw) || pw < 0.02) return;
        const sp = 60 + 720 * pw;
        p.vx = Math.cos(ang) * sp; p.vy = Math.sin(ang) * sp;
        p.strokes++; p.moving = true;
      },
      view() {
        return {
          phase: g.phase, hole: g.hole, holes: HOLES.length, par: HOLES[g.hole].par, t: now(), text: g.text,
          players: g.players.map((p) => ({ conn: p.conn, user: p.user, strokes: p.strokes, done: p.done, sunk: p.sunk, total: p.total, scores: p.scores, x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, moving: p.moving })),
        };
      },
      destroy() { clearInterval(timer); for (const t of timers) clearTimeout(t); },
    };
  }

  /* ───────────── view ───────────── */

  function mount(el, ctx) {
    el.innerHTML = `<div class="gf"><div class="gf-hud" id="gf-hud"></div>
      <canvas class="gf-cv" width="${W}" height="${H}"></canvas>
      <div class="gf-text" id="gf-text"></div><div class="gf-board" id="gf-board" hidden></div></div>`;
    const cv = el.querySelector('canvas');
    const c = cv.getContext('2d');
    const hud = el.querySelector('#gf-hud');
    const text = el.querySelector('#gf-text');
    const board = el.querySelector('#gf-board');
    const me = ctx.me.conn;
    let S = null;
    let recvAt = Date.now();
    let aim = null;
    let raf = 0, run = true;
    const disp = new Map();

    const toField = (e) => { const r = cv.getBoundingClientRect(); return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H }; };
    const mine = () => S?.players.find((p) => p.conn === me);
    const canPutt = () => { const p = mine(); return S && S.phase === 'play' && p && !p.done && !p.moving; };

    cv.addEventListener('pointerdown', (e) => { if (canPutt()) { aim = toField(e); try { cv.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ } } });
    cv.addEventListener('pointermove', (e) => { if (aim) aim = toField(e); });
    cv.addEventListener('pointerup', () => {
      const p = mine();
      if (!aim || !canPutt()) { aim = null; return; }
      const dx = p.x - aim.x, dy = p.y - aim.y;
      const pw = Math.min(1, Math.hypot(dx, dy) / 210);
      aim = null;
      if (pw > 0.04) ctx.act({ shot: { a: Math.atan2(dy, dx), p: pw } });
    });
    cv.addEventListener('pointercancel', () => { aim = null; });
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-start]')) ctx.act({ start: 1 });
      if (e.target.closest('[data-skip]')) ctx.act({ skip: 1 });
    });

    function draw() {
      raf = requestAnimationFrame(draw);
      if (!run || !S) return;
      const h = HOLES[S.hole];
      const t = S.t + (Date.now() - recvAt) / 1000;
      c.clearRect(0, 0, W, H);
      const bg = c.createLinearGradient(0, 0, 0, H);
      bg.addColorStop(0, '#16301f'); bg.addColorStop(1, '#0d1f14');
      c.fillStyle = bg; c.fillRect(0, 0, W, H);
      c.fillStyle = '#2f9a52'; c.fillRect(20, 20, 760, 460);
      for (let i = 0; i < 760; i += 40) { c.fillStyle = i % 80 ? 'rgba(255,255,255,.035)' : 'rgba(0,0,0,.035)'; c.fillRect(20 + i, 20, 40, 460); }
      for (const [x, y, w, ht] of h.sand) { c.fillStyle = '#e3cf8a'; c.fillRect(x, y, w, ht); c.fillStyle = 'rgba(160,120,40,.25)'; for (let k = 0; k < w * ht / 700; k++) c.fillRect(x + ((k * 53) % w), y + ((k * 97) % ht), 2, 2); }
      // tee + cup
      c.beginPath(); c.arc(h.tee[0], h.tee[1], 12, 0, 7); c.fillStyle = 'rgba(255,255,255,.14)'; c.fill();
      c.beginPath(); c.arc(h.cup[0], h.cup[1], CUPR, 0, 7); c.fillStyle = '#050805'; c.fill();
      c.strokeStyle = '#d8d8d8'; c.lineWidth = 2; c.beginPath(); c.moveTo(h.cup[0], h.cup[1]); c.lineTo(h.cup[0], h.cup[1] - 46); c.stroke();
      c.fillStyle = '#ff4d4d'; c.beginPath(); c.moveTo(h.cup[0], h.cup[1] - 46); c.lineTo(h.cup[0] + 22, h.cup[1] - 38); c.lineTo(h.cup[0], h.cup[1] - 30); c.fill();
      // walls
      c.lineCap = 'round'; c.lineWidth = WALL * 2 + 2;
      for (const [x1, y1, x2, y2] of holeWalls(h, t)) {
        c.strokeStyle = '#6a3f1f'; c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke();
      }
      c.lineWidth = 2;
      for (const [x1, y1, x2, y2] of holeWalls(h, t)) { c.strokeStyle = '#9a6a3a'; c.beginPath(); c.moveTo(x1, y1 - 1); c.lineTo(x2, y2 - 1); c.stroke(); }
      if (h.bar) { c.beginPath(); c.arc(h.bar.cx, h.bar.cy, 9, 0, 7); c.fillStyle = '#c9a15a'; c.fill(); }
      // balls
      for (const p of S.players) {
        let d = disp.get(p.conn);
        if (!d) { d = { x: p.x, y: p.y }; disp.set(p.conn, d); }
        const k = p.moving ? 0.55 : 1;
        d.x += (p.x - d.x) * k; d.y += (p.y - d.y) * k;
        if (p.sunk && p.done) continue;
        c.beginPath(); c.arc(d.x + 1.5, d.y + 2.5, BR, 0, 7); c.fillStyle = 'rgba(0,0,0,.3)'; c.fill();
        c.beginPath(); c.arc(d.x, d.y, BR, 0, 7); c.fillStyle = `hsl(${Party.hue(p.user)} 75% ${p.conn === me ? 62 : 55}%)`; c.fill();
        c.lineWidth = p.conn === me ? 2.4 : 1.2; c.strokeStyle = p.conn === me ? '#fff' : 'rgba(0,0,0,.45)'; c.stroke();
        if (p.done && !p.sunk) { c.fillStyle = 'rgba(0,0,0,.45)'; c.fill(); }
        c.fillStyle = '#fff'; c.font = '600 11px sans-serif'; c.textAlign = 'center'; c.fillText(p.user, d.x, d.y - 13);
      }
      // aim
      const p = mine();
      if (aim && p && canPutt()) {
        const dx = p.x - aim.x, dy = p.y - aim.y, len = Math.hypot(dx, dy) || 1;
        const pw = Math.min(1, len / 210);
        const ux = dx / len, uy = dy / len;
        c.setLineDash([6, 7]); c.strokeStyle = 'rgba(255,255,255,.85)'; c.lineWidth = 2;
        c.beginPath(); c.moveTo(p.x, p.y); c.lineTo(p.x + ux * (40 + pw * 260), p.y + uy * (40 + pw * 260)); c.stroke(); c.setLineDash([]);
        c.strokeStyle = '#d8b56a'; c.lineWidth = 5; c.beginPath(); c.moveTo(p.x - ux * (14 + pw * 70), p.y - uy * (14 + pw * 70)); c.lineTo(p.x - ux * (14 + pw * 70 + 90), p.y - uy * (14 + pw * 70 + 90)); c.stroke();
        c.fillStyle = 'rgba(0,0,0,.5)'; c.fillRect(30, H - 36, 180, 10); c.fillStyle = `hsl(${120 - pw * 120} 85% 55%)`; c.fillRect(30, H - 36, 180 * pw, 10);
      } else if (p && canPutt()) {
        c.beginPath(); c.arc(p.x, p.y, BR + 7, 0, 7); c.strokeStyle = 'rgba(200,255,46,.85)'; c.lineWidth = 2; c.setLineDash([4, 4]); c.stroke(); c.setLineDash([]);
      }
    }
    raf = requestAnimationFrame(draw);

    const renderBoard = (s) => {
      const rows = s.players.slice().sort((a, b) => a.total - b.total);
      board.hidden = s.phase !== 'over' && s.phase !== 'between';
      if (board.hidden) return;
      board.innerHTML = `<table><tr><th></th>${Array.from({ length: s.holes }, (_, i) => `<th>${i + 1}</th>`).join('')}<th>Σ</th></tr>
        <tr class="par"><td>Par</td>${HOLES.map((h) => `<td>${h.par}</td>`).join('')}<td>${HOLES.reduce((a, h) => a + h.par, 0)}</td></tr>
        ${rows.map((p) => `<tr class="${p.conn === me ? 'me' : ''}"><td>${esc(p.user)}</td>${HOLES.map((_, i) => `<td>${p.scores[i] ?? ''}</td>`).join('')}<td><b>${p.total}</b></td></tr>`).join('')}</table>`;
    };

    return {
      debug: () => S,
      update(s) {
        S = s; recvAt = Date.now();
        hud.innerHTML = `<div class="gf-hole">${s.phase === 'lobby' ? 'Mini golf' : `Hole ${s.hole + 1}/${s.holes} · Par ${s.par}`}</div>
          <div class="gf-players">${s.players.map((p) => `<span class="gf-p ${p.done ? 'done' : ''} ${p.conn === me ? 'me' : ''}"><i style="--h:${Party.hue(p.user)}"></i><b>${esc(p.user)}</b><em>${p.strokes}${p.done && p.sunk ? ' ✓' : ''}</em></span>`).join('') || '<span class="gf-p">Nobody yet</span>'}</div>
          ${ctx.isHost && s.phase !== 'play' && s.phase !== 'between' ? `<button class="pbtn" data-start>${s.phase === 'over' ? 'PLAY AGAIN' : 'START'}</button>` : ''}
          ${ctx.isHost && s.phase === 'play' ? '<button class="pbtn ghost" data-skip title="Finish this hole for everybody who is not done">SKIP HOLE</button>' : ''}`;
        const p = s.players.find((q) => q.conn === me);
        text.textContent = s.phase === 'lobby' ? (ctx.isHost ? 'Press START when everybody joined (JOIN GAME at the top).' : 'Waiting for the host. Press JOIN GAME to play.')
          : s.phase === 'over' || s.phase === 'between' ? s.text
            : !p ? 'You are watching – press JOIN GAME to play the next round.'
              : p.done ? (p.sunk ? `In the hole with ${p.strokes}! Waiting for the others…` : 'Too many strokes – waiting for the others…')
                : p.moving ? s.text : 'Drag back from anywhere and let go to putt – the longer the pull, the harder the putt.';
        renderBoard(s);
      },
      shown(v) { run = v; },
      destroy() { cancelAnimationFrame(raf); },
    };
  }

  Party.register({
    id: 'golf', title: 'Mini golf', min: 1, max: 8,
    desc: 'Six holes, everybody putts at the same time. Fewest strokes wins.',
    icon: '<svg viewBox="0 0 24 24"><path d="M8 21V4l9 3.5L8 11"/><circle cx="14" cy="19" r="1.6"/><path d="M4 21h16"/></svg>',
    create, mount, holes: HOLES,
  });
})();
