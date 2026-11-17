'use strict';
/* ───────────────────────── Poker: Texas Hold'em for 2–8 players ─────────────────────────
 * The host deals and judges (hole cards are only sent to their owner until showdown).
 * 1000 chips each, blinds 10/20 that double every 8 hands, side pots, 45 s per decision. */
(() => {
  const esc = Party.esc;
  const SUITS = ['♣', '♦', '♥', '♠'];
  const RANK = '23456789TJQKA';
  const rankOf = (c) => c % 13;
  const suitOf = (c) => Math.floor(c / 13);
  const HAND_NAMES = ['High card', 'Pair', 'Two pair', 'Three of a kind', 'Straight', 'Flush', 'Full house', 'Four of a kind', 'Straight flush'];
  const START_CHIPS = 1000;
  const TURN_MS = 45000;

  /* ── hand evaluation: compares arrays [category, kickers…] ── */
  function eval5(cs) {
    const r = cs.map(rankOf).sort((a, b) => b - a);
    const flush = cs.every((c) => suitOf(c) === suitOf(cs[0]));
    const uniq = new Set(r);
    let straight = -1;
    if (uniq.size === 5) {
      if (r[0] - r[4] === 4) straight = r[0];
      else if (r[0] === 12 && r[1] === 3) straight = 3; // A-2-3-4-5
    }
    const counts = {};
    for (const x of r) counts[x] = (counts[x] || 0) + 1;
    const groups = Object.entries(counts).map(([k, v]) => [v, +k]).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
    if (straight >= 0 && flush) return [8, straight];
    if (groups[0][0] === 4) return [7, groups[0][1], groups[1][1]];
    if (groups[0][0] === 3 && groups[1][0] === 2) return [6, groups[0][1], groups[1][1]];
    if (flush) return [5, ...r];
    if (straight >= 0) return [4, straight];
    if (groups[0][0] === 3) return [3, groups[0][1], groups[1][1], groups[2][1]];
    if (groups[0][0] === 2 && groups[1][0] === 2) return [2, groups[0][1], groups[1][1], groups[2][1]];
    if (groups[0][0] === 2) return [1, groups[0][1], ...groups.slice(1).map((g) => g[1])];
    return [0, ...r];
  }
  const cmp = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] || 0) - (b[i] || 0); if (d) return d; } return 0; };
  function bestHand(cards) {
    let best = null;
    const pick = (start, chosen) => {
      if (chosen.length === 5) { const v = eval5(chosen); if (!best || cmp(v, best) > 0) best = v; return; }
      for (let i = start; i < cards.length; i++) { chosen.push(cards[i]); pick(i + 1, chosen); chosen.pop(); }
    };
    pick(0, []);
    return best;
  }

  const shuffle = (arr) => {
    const a = arr.slice();
    const buf = new Uint32Array(a.length);
    crypto.getRandomValues(buf);
    for (let i = a.length - 1; i > 0; i--) { const j = buf[i] % (i + 1); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  };

  /* ───────────── host ───────────── */

  function create(ctx) {
    const g = {
      phase: 'lobby', seats: [], button: -1, deck: [], board: [], currentBet: 0, minRaise: 20, toAct: -1, sb: 10, bb: 20,
      hand: 0, log: [], deadline: 0, result: null, winner: '', street: '',
    };
    const timers = new Set();
    const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); };
    const log = (m) => { g.log.push(m); if (g.log.length > 30) g.log.shift(); };
    const n = () => g.seats.length;
    const canAct = (s) => !s.folded && !s.allIn && s.chips > 0 && !s.gone;
    const nextIdx = (from, pred) => { for (let i = 1; i <= n(); i++) { const j = (((from + i) % n()) + n()) % n(); if (pred(g.seats[j])) return j; } return -1; };
    const pot = () => g.seats.reduce((a, s) => a + s.total, 0);

    function post(i, amt) {
      const s = g.seats[i];
      const a = Math.min(amt, s.chips);
      s.chips -= a; s.bet += a; s.total += a;
      if (s.chips === 0) s.allIn = true;
    }

    function startHand() {
      g.seats = g.seats.filter((s) => !s.gone);
      const live = g.seats.filter((s) => s.chips > 0);
      if (live.length < 2) {
        g.phase = 'over'; g.winner = live[0]?.user || ''; g.toAct = -1;
        if (g.winner) log(`${g.winner} wins the game!`);
        ctx.push();
        return;
      }
      g.hand++;
      if (g.hand > 1 && (g.hand - 1) % 8 === 0) { g.sb *= 2; g.bb *= 2; log(`Blinds are now ${g.sb}/${g.bb}`); }
      g.phase = 'hand'; g.street = 'preflop'; g.board = []; g.result = null;
      g.deck = shuffle([...Array(52).keys()]);
      for (const s of g.seats) {
        Object.assign(s, { bet: 0, total: 0, folded: s.chips <= 0, allIn: false, hole: [], acted: false, show: false, last: '', val: null });
      }
      g.button = g.button < 0 ? g.seats.findIndex((s) => s.chips > 0) : nextIdx(g.button, (s) => s.chips > 0);
      const headsUp = live.length === 2;
      const sbIdx = headsUp ? g.button : nextIdx(g.button, (s) => !s.folded);
      const bbIdx = nextIdx(sbIdx, (s) => !s.folded);
      for (let r = 0; r < 2; r++) for (const s of g.seats) if (!s.folded) s.hole.push(g.deck.pop());
      post(sbIdx, g.sb); post(bbIdx, g.bb);
      g.currentBet = Math.max(g.seats[sbIdx].bet, g.seats[bbIdx].bet);
      g.minRaise = g.bb;
      log(`— Hand ${g.hand} · dealer ${g.seats[g.button].user}`);
      g.toAct = headsUp ? sbIdx : nextIdx(bbIdx, canAct);
      const first = g.toAct >= 0 ? g.seats[g.toAct] : null;
      if (!first || !canAct(first) || (first.acted && first.bet >= g.currentBet)) { afterAct(); return; }
      g.deadline = Date.now() + TURN_MS;
    }

    function afterAct() {
      const alive = g.seats.filter((s) => !s.folded);
      if (alive.length === 1) { awardUncontested(alive[0]); return; }
      for (let i = 1; i <= n(); i++) {
        const j = (g.toAct + i + n()) % n();
        const s = g.seats[j];
        if (canAct(s) && (!s.acted || s.bet < g.currentBet)) { g.toAct = j; g.deadline = Date.now() + TURN_MS; return; }
      }
      nextStreet();
    }

    function nextStreet() {
      for (const s of g.seats) { s.bet = 0; s.acted = false; }
      g.currentBet = 0; g.minRaise = g.bb;
      if (g.street === 'preflop') { g.board.push(g.deck.pop(), g.deck.pop(), g.deck.pop()); g.street = 'flop'; }
      else if (g.street === 'flop') { g.board.push(g.deck.pop()); g.street = 'turn'; }
      else if (g.street === 'turn') { g.board.push(g.deck.pop()); g.street = 'river'; }
      else { showdown(); return; }
      const bettors = g.seats.filter(canAct);
      if (bettors.length < 2) {            // everybody else is all-in: run the board out
        g.toAct = -1;
        later(nextStreet, window.__PARTY_FAST ? 150 : 1300);
      } else {
        g.toAct = nextIdx(g.button, canAct);
        g.deadline = Date.now() + TURN_MS;
      }
      ctx.push();
    }

    function finishHand() {
      g.phase = 'between'; g.toAct = -1;
      for (const s of g.seats) s.bet = 0;
      later(() => { if (g.phase === 'between') { startHand(); ctx.push(); } }, window.__PARTY_FAST ? 500 : 7500);
      ctx.push();
    }

    function awardUncontested(w) {
      const amount = pot();
      w.chips += amount;
      g.result = { pots: [{ amount, winners: [w.user], hand: 'everyone else folded' }] };
      log(`${w.user} wins ${amount}`);
      finishHand();
    }

    function showdown() {
      g.street = 'showdown';
      const alive = g.seats.filter((s) => !s.folded);
      for (const s of alive) { s.show = true; s.val = bestHand([...s.hole, ...g.board]); }
      const levels = [...new Set(g.seats.filter((s) => s.total > 0).map((s) => s.total))].sort((a, b) => a - b);
      const pots = [];
      let prev = 0;
      for (const lv of levels) {
        let amount = 0;
        for (const s of g.seats) amount += Math.max(0, Math.min(s.total, lv) - prev);
        prev = lv;
        const elig = alive.filter((s) => s.total >= lv);
        if (!elig.length || !amount) continue;
        let top = elig[0].val;
        for (const s of elig) if (cmp(s.val, top) > 0) top = s.val;
        const winners = elig.filter((s) => cmp(s.val, top) === 0);
        const share = Math.floor(amount / winners.length);
        let rest = amount - share * winners.length;
        for (const s of winners) s.chips += share;
        // odd chips go to the winner closest left of the dealer
        const ordered = winners.slice().sort((a, b) => ((g.seats.indexOf(a) - g.button + n()) % n()) - ((g.seats.indexOf(b) - g.button + n()) % n()));
        for (let i = 0; rest > 0; i = (i + 1) % ordered.length, rest--) ordered[i].chips++;
        pots.push({ amount, winners: winners.map((s) => s.user), hand: HAND_NAMES[top[0]] });
        log(`${winners.map((s) => s.user).join(' & ')} win${winners.length > 1 ? '' : 's'} ${amount} with ${HAND_NAMES[top[0]]}`);
      }
      g.result = { pots };
      finishHand();
    }

    function act(from, a) {
      if (a.start) {
        if (from === ctx.me.conn && (g.phase === 'lobby' || g.phase === 'over') && g.seats.length >= 2) {
          if (g.phase === 'over') { for (const s of g.seats) s.chips = START_CHIPS; g.sb = 10; g.bb = 20; g.hand = 0; g.button = -1; }
          startHand();
        }
        return;
      }
      if (g.phase !== 'hand' || g.toAct < 0) return;
      const idx = g.seats.findIndex((s) => s.conn === from);
      if (idx !== g.toAct) return;
      const s = g.seats[idx];
      const toCall = g.currentBet - s.bet;
      const pay = (amt) => { const x = Math.min(amt, s.chips); s.chips -= x; s.bet += x; s.total += x; if (s.chips === 0) s.allIn = true; };
      let type = a.type;
      if (type === 'allin') type = 'raise', a = { to: s.bet + s.chips };
      if (type === 'raise' && s.bet + s.chips <= g.currentBet) type = 'call';
      if (type === 'check' && toCall > 0) return;
      if (type === 'fold') { s.folded = true; s.last = 'Fold'; log(`${s.user} folds`); }
      else if (type === 'check') { s.last = 'Check'; }
      else if (type === 'call') { const paid = Math.min(toCall, s.chips); pay(toCall); s.last = s.allIn ? 'All-in' : 'Call'; log(`${s.user} ${s.allIn ? 'is all-in with' : 'calls'} ${paid}`); }
      else if (type === 'raise') {
        const minTo = g.currentBet + g.minRaise;
        const maxTo = s.bet + s.chips;
        const to = Math.min(Math.max(Math.floor(+a.to || 0), minTo), maxTo);
        const raiseBy = to - g.currentBet;
        const full = raiseBy >= g.minRaise;
        pay(to - s.bet);
        if (full) g.minRaise = raiseBy;
        g.currentBet = Math.max(g.currentBet, s.bet);
        if (full) for (const o of g.seats) if (o !== s && canAct(o)) o.acted = false;
        s.last = s.allIn ? 'All-in' : `${toCall ? 'Raise' : 'Bet'} ${s.bet}`;
        log(`${s.user} ${s.allIn ? 'goes all-in with' : toCall ? 'raises to' : 'bets'} ${s.bet}`);
      } else return;
      s.acted = true;
      afterAct();
    }

    const tick = setInterval(() => {
      if (g.phase === 'hand' && g.toAct >= 0 && Date.now() > g.deadline) {
        const s = g.seats[g.toAct];
        act(s.conn, { type: g.currentBet - s.bet > 0 ? 'fold' : 'check' });
        ctx.push();
      }
    }, 1000);

    return {
      onJoin(p) {
        const s = { conn: p.conn, user: p.user, chips: START_CHIPS, bet: 0, total: 0, folded: true, allIn: false, hole: [], acted: false, show: false, last: '', val: null };
        g.seats.push(s);
        log(`${p.user} sits down`);
        if (g.phase === 'over') g.phase = 'lobby';
      },
      onLeave(conn) {
        const i = g.seats.findIndex((s) => s.conn === conn);
        if (i < 0) return;
        const s = g.seats[i];
        log(`${s.user} left`);
        if (g.phase === 'hand' && !s.folded) {
          s.folded = true; s.gone = true; s.last = 'Left';
          if (g.toAct === i) afterAct(); else if (g.seats.filter((x) => !x.folded).length === 1) afterAct();
        } else if (g.phase === 'hand') {
          s.gone = true;
        } else {
          g.seats.splice(i, 1);
          if (g.button >= g.seats.length) g.button = g.seats.length - 1;
        }
      },
      onAct: act,
      _g: g,
      view(conn) {
        return {
          phase: g.phase, hand: g.hand, sb: g.sb, bb: g.bb, street: g.street, board: g.board, pot: pot(),
          button: g.seats[g.button]?.conn || 0, toAct: g.toAct >= 0 ? g.seats[g.toAct]?.conn : 0,
          currentBet: g.currentBet, minRaise: g.minRaise, left: g.toAct >= 0 ? Math.max(0, g.deadline - Date.now()) : 0,
          seats: g.seats.map((s) => ({
            conn: s.conn, user: s.user, chips: s.chips, bet: s.bet, folded: s.folded, allIn: s.allIn, last: s.last, gone: !!s.gone,
            hole: s.conn === conn || s.show ? s.hole : (!s.folded && s.hole.length ? [-1, -1] : []),
            hand: s.show && s.val ? HAND_NAMES[s.val[0]] : '',
          })),
          result: g.result, log: g.log.slice(-9), winner: g.winner,
        };
      },
      destroy() { clearInterval(tick); for (const t of timers) clearTimeout(t); },
    };
  }

  /* ───────────── view ───────────── */

  const card = (c, small) => {
    if (c < 0) return `<div class="pc back ${small ? 'sm' : ''}"></div>`;
    const red = suitOf(c) === 1 || suitOf(c) === 2;
    return `<div class="pc ${red ? 'red' : ''} ${small ? 'sm' : ''}"><b>${RANK[rankOf(c)] === 'T' ? '10' : RANK[rankOf(c)]}</b><i>${SUITS[suitOf(c)]}</i></div>`;
  };
  const fmt = (n) => Number(n).toLocaleString('en-US');

  function mount(el, ctx) {
    el.innerHTML = `<div class="pk"><div class="pk-felt" id="pk-felt"></div><div class="pk-side"><div class="pk-log" id="pk-log"></div><div class="pk-act" id="pk-act"></div></div></div>`;
    const felt = el.querySelector('#pk-felt');
    const logEl = el.querySelector('#pk-log');
    const actEl = el.querySelector('#pk-act');
    let S = null;
    let raiseTo = 0;
    let seenTurn = '';
    let recvAt = Date.now();
    let timerEl = null;

    const me = ctx.me.conn;
    const timer = setInterval(() => {
      if (!timerEl || !S?.toAct) return;
      timerEl.textContent = `${Math.max(0, Math.ceil((S.left - (Date.now() - recvAt)) / 1000))}s`;
    }, 250);

    function render() {
      const s = S;
      const n = s.seats.length;
      const myIdx = Math.max(0, s.seats.findIndex((x) => x.conn === me));
      const seatsHTML = s.seats.map((p, i) => {
        const th = ((90 + (i - myIdx) * (360 / n)) * Math.PI) / 180;
        const x = 50 + 41 * Math.cos(th), y = 50 + 37 * Math.sin(th);
        const bx = 50 + 24 * Math.cos(th), by = 50 + 22 * Math.sin(th);
        const turn = s.toAct === p.conn && s.phase === 'hand';
        const win = s.result?.pots.some((pt) => pt.winners.includes(p.user));
        return `<div class="pk-seat ${turn ? 'turn' : ''} ${p.folded ? 'folded' : ''} ${p.conn === me ? 'me' : ''} ${win ? 'win' : ''}" style="left:${x}%;top:${y}%">
            <div class="pk-cards">${p.hole.map((c) => card(c, true)).join('')}</div>
            <div class="pk-name">${Party.avatar(p.user)}<span>${esc(p.user)}${p.conn === s.button && s.phase !== 'lobby' ? ' <u>D</u>' : ''}</span></div>
            <div class="pk-chips">${p.chips <= 0 && !p.allIn && s.phase !== 'lobby' ? 'out' : fmt(p.chips)}</div>
            <div class="pk-last">${esc(p.hand || p.last)}${turn ? ` <em id="pk-timer">${Math.ceil(s.left / 1000)}s</em>` : ''}</div>
          </div>
          ${p.bet > 0 ? `<div class="pk-bet" style="left:${bx}%;top:${by}%">${fmt(p.bet)}</div>` : ''}`;
      }).join('');
      let centre = '';
      if (s.phase === 'lobby') {
        centre = `<div class="pk-msg"><b>Texas Hold'em</b><span>${n} player${n === 1 ? '' : 's'} at the table · 1000 chips each · blinds ${s.sb}/${s.bb}</span>
          ${ctx.isHost ? `<button class="pbtn" data-start ${n < 2 ? 'disabled' : ''}>${n < 2 ? 'WAITING FOR PLAYERS…' : 'DEAL!'}</button>` : '<span>Waiting for the host to deal…</span>'}</div>`;
      } else if (s.phase === 'over') {
        centre = `<div class="pk-msg"><b>${esc(s.winner || 'Nobody')} wins the game!</b>${ctx.isHost ? '<button class="pbtn" data-start>PLAY AGAIN</button>' : ''}</div>`;
      } else {
        centre = `<div class="pk-board">${[0, 1, 2, 3, 4].map((i) => (s.board[i] != null ? card(s.board[i]) : '<div class="pc empty"></div>')).join('')}</div>
          <div class="pk-pot">Pot <b>${fmt(s.pot)}</b> · ${s.street ? esc(s.street) : ''} · blinds ${s.sb}/${s.bb}</div>
          ${s.result ? `<div class="pk-result">${s.result.pots.map((pt) => `<div><b>${esc(pt.winners.join(' & '))}</b> win ${fmt(pt.amount)} <small>${esc(pt.hand)}</small></div>`).join('')}</div>` : ''}`;
      }
      felt.innerHTML = `<div class="pk-table">${centre}</div>${seatsHTML}`;
      timerEl = felt.querySelector('#pk-timer');
      logEl.innerHTML = s.log.map((l) => `<div>${esc(l)}</div>`).join('');
      logEl.scrollTop = logEl.scrollHeight;
      renderActions();
    }

    function renderActions() {
      const s = S;
      const mine = s.seats.find((x) => x.conn === me);
      if (!mine || s.phase !== 'hand' || s.toAct !== me) {
        actEl.innerHTML = mine && s.phase === 'hand' && !mine.folded ? '<div class="pk-wait">Waiting for the others…</div>' : '';
        return;
      }
      const toCall = Math.max(0, s.currentBet - mine.bet);
      const minTo = s.currentBet + s.minRaise;
      const maxTo = mine.bet + mine.chips;
      const key = `${s.hand}:${s.street}:${s.currentBet}`;
      if (key !== seenTurn) { seenTurn = key; raiseTo = Math.min(minTo, maxTo); }
      raiseTo = Math.min(Math.max(raiseTo, Math.min(minTo, maxTo)), maxTo);
      const canRaise = maxTo > s.currentBet;
      actEl.innerHTML = `
        <div class="pk-btns">
          <button class="pbtn red" data-a="fold">FOLD</button>
          ${toCall > 0 ? `<button class="pbtn" data-a="call">CALL ${fmt(Math.min(toCall, mine.chips))}</button>` : '<button class="pbtn" data-a="check">CHECK</button>'}
        </div>
        ${canRaise ? `<div class="pk-raise">
          <input type="range" min="${Math.min(minTo, maxTo)}" max="${maxTo}" step="${Math.max(1, Math.floor(s.bb / 2))}" value="${raiseTo}" id="pk-rng">
          <button class="pbtn" data-a="raise">${s.currentBet ? 'RAISE TO' : 'BET'} <span id="pk-rv">${fmt(raiseTo)}</span></button>
          <button class="pbtn ghost" data-a="allin">ALL-IN ${fmt(maxTo)}</button>
        </div>` : (mine.chips > toCall ? '' : '')}`;
    }

    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-start]')) { ctx.act({ start: 1 }); return; }
      const b = e.target.closest('[data-a]');
      if (!b) return;
      const t = b.dataset.a;
      ctx.act(t === 'raise' ? { type: 'raise', to: raiseTo } : { type: t });
    });
    el.addEventListener('input', (e) => {
      if (e.target.id !== 'pk-rng') return;
      raiseTo = Number(e.target.value);
      const v = el.querySelector('#pk-rv');
      if (v) v.textContent = fmt(raiseTo);
    });

    return {
      debug: () => S,
      update(s) { S = s; recvAt = Date.now(); render(); },
      destroy() { clearInterval(timer); },
    };
  }

  Party.register({
    id: 'poker', title: "Texas Hold'em", min: 2, max: 8,
    desc: 'Poker with chips, blinds and side pots. Hole cards stay hidden until showdown.',
    icon: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="10" height="15" rx="2"/><path d="M15 7l5 1.6-3 11.4-4-1.2M7 9c-1.2 1.4-1.8 2-1.8 2.8a1.2 1.2 0 0 0 2.2.6 1.2 1.2 0 0 0 2.2-.6C9.6 11 9 10.4 7 9z"/></svg>',
    create, mount, test: { bestHand, cmp, HAND_NAMES },
  });
})();
