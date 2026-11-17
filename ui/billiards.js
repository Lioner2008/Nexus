'use strict';
/* ───────────────────────── Billiards: rotation pool for 1–8 players ─────────────────────────
 * One cue ball, fifteen numbered balls. You shoot in turn; every ball you pocket scores its number and you
 * keep shooting. Pocket the cue ball and you lose 3 points and the turn. Most points when the table is clear wins.
 * The host simulates the table and streams the balls to everybody. Aim: drag back from anywhere (like a slingshot). */
(() => {
  const esc = Party.esc;
  const W = 1000, H = 500, R = 11, M = 44;                       // table, ball radius, rail margin (drawing only)
  const POCKETS = [
    { x: 0, y: 0, r: 25, mouth: 40 }, { x: W, y: 0, r: 25, mouth: 40 }, { x: 0, y: H, r: 25, mouth: 40 }, { x: W, y: H, r: 25, mouth: 40 },
    { x: W / 2, y: -3, r: 23, mouth: 34 }, { x: W / 2, y: H + 3, r: 23, mouth: 34 },
  ];
  const COLORS = ['#f5f5f0', '#f4c20d', '#1f5fbf', '#d6322e', '#6b2f9e', '#ee7a1c', '#1f8a4c', '#7a1f2b', '#141414'];
  const CUE0 = { x: 250, y: 250 };
  const FIXED = 1 / 240;

  /* ── physics (host only) ── */
  function physicsStep(balls, dt, pocketed) {
    for (const b of balls) {
      if (!b.alive) continue;
      b.x += b.vx * dt; b.y += b.vy * dt;
      const sp = Math.hypot(b.vx, b.vy);
      if (sp > 0) {
        const ns = sp - (0.32 * sp + 22) * dt;
        if (ns < 7) { b.vx = 0; b.vy = 0; } else { b.vx *= ns / sp; b.vy *= ns / sp; }
      }
    }
    for (let i = 0; i < balls.length; i++) {
      const a = balls[i];
      if (!a.alive) continue;
      for (let j = i + 1; j < balls.length; j++) {
        const b = balls[j];
        if (!b.alive) continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const d2 = dx * dx + dy * dy;
        if (d2 >= 4 * R * R || d2 === 0) continue;
        const d = Math.sqrt(d2), nx = dx / d, ny = dy / d;
        const push = (2 * R - d) / 2;
        a.x -= nx * push; a.y -= ny * push; b.x += nx * push; b.y += ny * push;
        const rel = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
        if (rel > 0) {
          const imp = (rel * (1 + 0.96)) / 2;
          a.vx -= imp * nx; a.vy -= imp * ny; b.vx += imp * nx; b.vy += imp * ny;
        }
      }
    }
    for (let i = 0; i < balls.length; i++) {
      const b = balls[i];
      if (!b.alive) continue;
      let nearMouth = false;
      for (const p of POCKETS) {
        const d = Math.hypot(b.x - p.x, b.y - p.y);
        if (d < p.r) { b.alive = false; b.vx = 0; b.vy = 0; pocketed.push(i); break; }
        if (d < p.mouth) nearMouth = true;
      }
      if (!b.alive || nearMouth) continue;
      if (b.x < R) { b.x = R; b.vx = Math.abs(b.vx) * 0.78; } else if (b.x > W - R) { b.x = W - R; b.vx = -Math.abs(b.vx) * 0.78; }
      if (b.y < R) { b.y = R; b.vy = Math.abs(b.vy) * 0.78; } else if (b.y > H - R) { b.y = H - R; b.vy = -Math.abs(b.vy) * 0.78; }
    }
  }
  const anyMoving = (balls) => balls.some((b) => b.alive && (b.vx || b.vy));

  function rack() {
    const nums = [...Array(15).keys()].map((i) => i + 1);
    for (let i = nums.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [nums[i], nums[j]] = [nums[j], nums[i]]; }
    const balls = [{ x: CUE0.x, y: CUE0.y, vx: 0, vy: 0, alive: true }];
    let k = 0;
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c <= r; c++) {
        balls[nums[k]] = { x: 690 + r * (2 * R * 0.866 + 0.6), y: H / 2 + (c - r / 2) * (2 * R + 0.6), vx: 0, vy: 0, alive: true };
        k++;
      }
    }
    return balls;
  }

  /* ───────────── host ───────────── */

  function create(ctx) {
    const g = { phase: 'lobby', seats: [], turn: '', balls: rack(), moving: false, pocketed: [], text: 'Waiting for the host to start…', winners: [] };
    let lastPush = 0;
    const loop = { acc: 0, last: performance.now() };

    const turnIdx = () => g.seats.findIndex((s) => s.conn === g.turn);
    const nextTurn = () => {
      const i = turnIdx();
      g.turn = g.seats.length ? g.seats[(i + 1) % g.seats.length].conn : '';
    };

    function respotCue() {
      const c = g.balls[0];
      c.alive = true; c.vx = 0; c.vy = 0;
      for (let x = CUE0.x; x > 30; x -= 6) {
        c.x = x; c.y = CUE0.y;
        if (!g.balls.some((b, i) => i && b.alive && Math.hypot(b.x - c.x, b.y - c.y) < 2 * R + 1)) return;
      }
    }

    function endShot() {
      g.moving = false;
      const s = g.seats[turnIdx()];
      const objs = g.pocketed.filter((i) => i > 0);
      const scratch = g.pocketed.includes(0);
      const gain = objs.reduce((a, b) => a + b, 0);
      g.pocketed = [];
      if (s) {
        s.score += gain - (scratch ? 3 : 0);
        g.text = `${s.user}: ${objs.length ? `pocketed ${objs.join(', ')} (+${gain})` : 'no ball'}${scratch ? ' · scratch −3' : ''}`;
      }
      if (scratch) respotCue();
      if (!g.balls.some((b, i) => i && b.alive)) {
        g.phase = 'over';
        const top = Math.max(...g.seats.map((x) => x.score));
        g.winners = g.seats.filter((x) => x.score === top).map((x) => x.user);
        g.text = `${g.winners.join(' & ')} win${g.winners.length > 1 ? '' : 's'}!`;
      } else if (scratch || !objs.length) nextTurn();
      ctx.push();
    }

    const timer = setInterval(() => {
      const now = performance.now();
      loop.acc += Math.min(1, (now - loop.last) / 1000);   // real time, even when the window is in the background and timers are slow
      loop.last = now;
      if (!g.moving) { loop.acc = 0; return; }
      while (loop.acc >= FIXED) { physicsStep(g.balls, FIXED, g.pocketed); loop.acc -= FIXED; }
      if (!anyMoving(g.balls)) { endShot(); return; }
      if (now - lastPush > 33) { lastPush = now; ctx.push(); }
    }, 8);

    return {
      _g: g,
      onJoin(p) { g.seats.push({ conn: p.conn, user: p.user, score: 0 }); if (!g.turn) g.turn = p.conn; },
      onLeave(conn) {
        const i = g.seats.findIndex((s) => s.conn === conn);
        if (i < 0) return;
        const wasTurn = g.turn === conn;
        g.seats.splice(i, 1);
        if (wasTurn) { g.turn = g.seats.length ? g.seats[i % g.seats.length].conn : ''; if (g.moving) g.moving = true; }
        if (!g.seats.length) g.phase = 'lobby';
      },
      onAct(from, a) {
        if (a.start) {
          if (from === ctx.me.conn && g.phase !== 'play' && g.seats.length >= 1) {
            g.balls = rack(); g.phase = 'play'; g.pocketed = []; g.moving = false; g.winners = [];
            for (const s of g.seats) s.score = 0;
            g.turn = g.seats[0].conn;
            g.text = `${g.seats[0].user} breaks`;
          }
          return;
        }
        if (a.shot && g.phase === 'play' && !g.moving && from === g.turn && g.balls[0].alive) {
          const ang = +a.shot.a, p = Math.min(1, Math.max(0, +a.shot.p));
          if (!Number.isFinite(ang) || !Number.isFinite(p) || p < 0.02) return;
          const sp = 90 + 1750 * p;
          g.balls[0].vx = Math.cos(ang) * sp; g.balls[0].vy = Math.sin(ang) * sp;
          g.moving = true; g.pocketed = []; loop.acc = 0; loop.last = performance.now();
        }
      },
      view() {
        return {
          phase: g.phase, turn: g.turn, moving: g.moving, text: g.text, winners: g.winners,
          seats: g.seats.map((s) => ({ conn: s.conn, user: s.user, score: s.score })),
          balls: g.balls.flatMap((b) => (b.alive ? [Math.round(b.x * 10) / 10, Math.round(b.y * 10) / 10] : [-1000, -1000])),
        };
      },
      destroy() { clearInterval(timer); },
    };
  }

  /* ───────────── view ───────────── */

  const numColor = (n) => (n === 0 ? COLORS[0] : n <= 8 ? COLORS[n] : COLORS[n - 8]);

  function drawBall(c, x, y, n) {
    c.save();
    c.translate(x, y);
    c.beginPath(); c.arc(1.5, 2.5, R, 0, 7); c.fillStyle = 'rgba(0,0,0,.28)'; c.fill();
    c.beginPath(); c.arc(0, 0, R, 0, 7); c.clip();
    c.fillStyle = n > 8 ? '#f5f5f0' : numColor(n); c.fillRect(-R, -R, 2 * R, 2 * R);
    if (n > 8) { c.fillStyle = numColor(n); c.fillRect(-R, -R * 0.55, 2 * R, R * 1.1); }
    if (n > 0) {
      c.beginPath(); c.arc(0, 0, R * 0.48, 0, 7); c.fillStyle = '#fff'; c.fill();
      c.fillStyle = '#111'; c.font = 'bold 8px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(String(n), 0, 0.5);
    }
    const g = c.createRadialGradient(-R * 0.4, -R * 0.45, 0.5, -R * 0.2, -R * 0.2, R * 1.3);
    g.addColorStop(0, 'rgba(255,255,255,.55)'); g.addColorStop(0.35, 'rgba(255,255,255,0)'); g.addColorStop(1, 'rgba(0,0,0,.3)');
    c.fillStyle = g; c.fillRect(-R, -R, 2 * R, 2 * R);
    c.restore();
  }

  /** First thing the cue ball would hit in direction (dx,dy): a ball or a cushion. */
  function rayHit(from, dx, dy, pos) {
    let best = { t: 1e9, ball: -1 };
    for (let i = 1; i < pos.length; i++) {
      const b = pos[i];
      if (!b) continue;
      const fx = b.x - from.x, fy = b.y - from.y;
      const t = fx * dx + fy * dy;
      if (t < 0) continue;
      const d2 = fx * fx + fy * fy - t * t;
      if (d2 > 4 * R * R) continue;
      const th = t - Math.sqrt(4 * R * R - d2);
      if (th > 0 && th < best.t) best = { t: th, ball: i };
    }
    const wall = (p, d, lo, hi) => (d > 0 ? (hi - p) / d : d < 0 ? (lo - p) / d : 1e9);
    const tw = Math.min(wall(from.x, dx, R, W - R), wall(from.y, dy, R, H - R));
    if (tw < best.t) best = { t: tw, ball: -1 };
    return best;
  }

  function mount(el, ctx) {
    el.innerHTML = `<div class="bl"><div class="bl-hud" id="bl-hud"></div>
      <canvas class="bl-cv" width="${W + 2 * M}" height="${H + 2 * M}"></canvas>
      <div class="bl-text" id="bl-text"></div></div>`;
    const cv = el.querySelector('canvas');
    const c = cv.getContext('2d');
    const hud = el.querySelector('#bl-hud');
    const text = el.querySelector('#bl-text');
    let S = null;
    const disp = [];          // smoothed ball positions
    const tgt = [];
    let aim = null;           // {x,y} pointer in table coordinates while dragging
    let raf = 0, run = true, dirty = true;
    const me = ctx.me.conn;

    const toTable = (e) => {
      const r = cv.getBoundingClientRect();
      return { x: ((e.clientX - r.left) / r.width) * cv.width - M, y: ((e.clientY - r.top) / r.height) * cv.height - M };
    };
    const myTurn = () => S && S.phase === 'play' && S.turn === me && !S.moving && tgt[0];

    cv.addEventListener('pointerdown', (e) => { if (myTurn()) { aim = toTable(e); try { cv.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ } dirty = true; } });
    cv.addEventListener('pointermove', (e) => { if (aim) { aim = toTable(e); dirty = true; } });
    const release = () => {
      if (!aim || !myTurn()) { aim = null; return; }
      const cue = tgt[0];
      const dx = cue.x - aim.x, dy = cue.y - aim.y;   // pull back: the shot goes the other way
      const p = Math.min(1, Math.hypot(dx, dy) / 230);
      aim = null; dirty = true;
      if (p > 0.04) ctx.act({ shot: { a: Math.atan2(dy, dx), p } });
    };
    cv.addEventListener('pointerup', release);
    cv.addEventListener('pointercancel', () => { aim = null; dirty = true; });
    el.addEventListener('click', (e) => { if (e.target.closest('[data-start]')) ctx.act({ start: 1 }); });

    function drawTable() {
      c.clearRect(0, 0, cv.width, cv.height);
      // rails
      const g = c.createLinearGradient(0, 0, 0, cv.height);
      g.addColorStop(0, '#6b3f22'); g.addColorStop(1, '#4a2915');
      c.fillStyle = g;
      c.beginPath(); c.roundRect(0, 0, cv.width, cv.height, 26); c.fill();
      c.fillStyle = '#1b6a43'; c.fillRect(M, M, W, H);
      const felt = c.createRadialGradient(M + W / 2, M + H / 2, 60, M + W / 2, M + H / 2, W * 0.62);
      felt.addColorStop(0, 'rgba(255,255,255,.1)'); felt.addColorStop(1, 'rgba(0,0,0,.28)');
      c.fillStyle = felt; c.fillRect(M, M, W, H);
      c.strokeStyle = 'rgba(255,255,255,.12)'; c.lineWidth = 2;
      c.beginPath(); c.moveTo(M + 250, M); c.lineTo(M + 250, M + H); c.stroke();
      c.beginPath(); c.arc(M + 250, M + H / 2, 3, 0, 7); c.fillStyle = 'rgba(255,255,255,.3)'; c.fill();
      for (const p of POCKETS) {
        c.beginPath(); c.arc(M + p.x, M + p.y, p.r + 3, 0, 7); c.fillStyle = '#0a0a0a'; c.fill();
      }
    }

    function frame() {
      raf = requestAnimationFrame(frame);
      if (!run || !S) return;
      let moved = dirty;
      for (let i = 0; i < tgt.length; i++) {
        const t = tgt[i];
        if (!t) { disp[i] = null; continue; }
        const d = disp[i];
        if (!d) { disp[i] = { x: t.x, y: t.y }; moved = true; continue; }
        const k = S.moving ? 0.55 : 1;
        if (Math.abs(t.x - d.x) > 0.05 || Math.abs(t.y - d.y) > 0.05) { d.x += (t.x - d.x) * k; d.y += (t.y - d.y) * k; moved = true; }
      }
      if (!moved) return;
      dirty = false;
      drawTable();
      c.save(); c.translate(M, M);
      const cue = disp[0];
      // aim helper
      if (aim && cue && myTurn()) {
        const dx = cue.x - aim.x, dy = cue.y - aim.y;
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len, uy = dy / len;
        const p = Math.min(1, len / 230);
        const hit = rayHit(cue, ux, uy, disp);
        c.setLineDash([7, 7]); c.strokeStyle = 'rgba(255,255,255,.75)'; c.lineWidth = 2;
        c.beginPath(); c.moveTo(cue.x, cue.y); c.lineTo(cue.x + ux * hit.t, cue.y + uy * hit.t); c.stroke();
        c.setLineDash([]);
        const gx = cue.x + ux * hit.t, gy = cue.y + uy * hit.t;
        c.beginPath(); c.arc(gx, gy, R, 0, 7); c.strokeStyle = 'rgba(255,255,255,.8)'; c.stroke();
        if (hit.ball > 0) {
          const o = disp[hit.ball];
          const nx = (o.x - gx) / (2 * R), ny = (o.y - gy) / (2 * R);
          c.strokeStyle = 'rgba(255,220,80,.9)'; c.beginPath(); c.moveTo(o.x, o.y); c.lineTo(o.x + nx * 70, o.y + ny * 70); c.stroke();
        }
        // cue stick pulled back
        const back = 16 + p * 90;
        c.lineCap = 'round';
        c.strokeStyle = '#d8b56a'; c.lineWidth = 6;
        c.beginPath(); c.moveTo(cue.x - ux * back, cue.y - uy * back); c.lineTo(cue.x - ux * (back + 230), cue.y - uy * (back + 230)); c.stroke();
        c.strokeStyle = '#2a1608'; c.lineWidth = 7;
        c.beginPath(); c.moveTo(cue.x - ux * (back + 170), cue.y - uy * (back + 170)); c.lineTo(cue.x - ux * (back + 230), cue.y - uy * (back + 230)); c.stroke();
        // power bar
        c.fillStyle = 'rgba(0,0,0,.45)'; c.fillRect(20, H - 28, 200, 10);
        c.fillStyle = `hsl(${120 - p * 120} 85% 55%)`; c.fillRect(20, H - 28, 200 * p, 10);
      }
      for (let i = disp.length - 1; i >= 0; i--) if (disp[i]) drawBall(c, disp[i].x, disp[i].y, i);
      if (S.phase === 'play' && S.turn === me && !S.moving && cue && !aim) {
        c.strokeStyle = 'rgba(200,255,46,.9)'; c.lineWidth = 2; c.setLineDash([4, 5]);
        c.beginPath(); c.arc(cue.x, cue.y, R + 6, 0, 7); c.stroke(); c.setLineDash([]);
      }
      c.restore();
    }
    raf = requestAnimationFrame(frame);

    return {
      debug: () => ({ S, tgt }),
      update(s) {
        S = s;
        for (let i = 0; i < 16; i++) { const x = s.balls[i * 2], y = s.balls[i * 2 + 1]; tgt[i] = x < -500 ? null : { x, y }; }
        dirty = true;
        hud.innerHTML = `<div class="bl-players">${s.seats.map((p) => `<span class="bl-p ${s.turn === p.conn && s.phase === 'play' ? 'turn' : ''}">${Party.avatar(p.user)}<b>${esc(p.user)}</b><em>${p.score}</em></span>`).join('') || '<span class="bl-p">Nobody at the table yet</span>'}</div>
          ${s.phase !== 'play' && ctx.isHost ? `<button class="pbtn" data-start>${s.phase === 'over' ? 'NEW RACK' : 'BREAK!'}</button>` : ''}`;
        const mine = s.turn === me;
        text.textContent = s.phase === 'lobby' ? (ctx.isHost ? 'Press BREAK when everybody joined (JOIN GAME at the top).' : 'Waiting for the host to start. Press JOIN GAME to play.')
          : s.phase === 'over' ? s.text
            : s.moving ? s.text : mine ? 'Your shot – drag back from anywhere, the longer the pull the harder the shot.' : `${esc((s.seats.find((p) => p.conn === s.turn) || {}).user || '')}'s turn · ${s.text}`;
      },
      shown(v) { run = v; dirty = true; },
      destroy() { cancelAnimationFrame(raf); },
    };
  }

  Party.register({
    id: 'billiards', title: 'Billiards', min: 1, max: 8,
    desc: 'Rotation pool: every pocketed ball scores its number, most points wins.',
    icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.2"/><path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2"/></svg>',
    create, mount,
  });
})();
