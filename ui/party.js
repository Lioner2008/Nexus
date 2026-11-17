'use strict';
/* ───────────────────────── Nexus Party ─────────────────────────
 * Shared activities inside a voice room: watch parties and games for up to 8 people.
 *
 * No server support is needed: messages travel through the existing `signal` relay of the voice room.
 * The person who starts an activity is its HOST: the host owns the state (cards, scores, physics),
 * everybody else sends actions ("act") to the host and renders the state the host pushes ("st").
 *
 *   {nx:'open', id, game, host, hostName}   host -> all      an activity exists
 *   {nx:'close', id}                        host -> all      it ended
 *   {nx:'hi'}                               newcomer -> all  "is something running?"
 *   {nx:'act', id, a}                       player -> host   an action
 *   {nx:'st', id, players, s}               host -> player   the state, tailored to that person
 *
 * Games register themselves with Party.register({ id, title, create(ctx), mount(el, ctx) }) – see poker.js,
 * billiards.js, golf.js and the watch party at the bottom of this file.
 */
window.Party = (() => {
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hue = (n) => { let h = 7; for (const c of String(n || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360; };
  const avatar = (n, cls = '') => `<i class="pav ${cls}" style="--h:${hue(n)}">${esc(String(n || '?')[0])}</i>`;
  const games = new Map();
  let api = null;          // provided by social.js (see Party.attach)
  let A = null;            // the current activity
  let root = null;         // overlay element
  let shown = false;
  const uid = () => Math.random().toString(36).slice(2, 10);
  const toast = (m, k, a) => { try { (window.toast || (() => {}))(m, k, a); } catch { /* ignore */ } };

  const me = () => api.me();
  const members = () => [api.me(), ...api.others()];
  const nameOf = (conn) => members().find((m) => m.conn === conn)?.user || '?';
  const bcast = (d) => { for (const m of api.others()) api.sendTo(m.conn, d); };

  function register(mod) { games.set(mod.id, mod); }
  function attach(a) { api = a; ensureRoot(); }
  const active = () => !!A;

  /* ───────────── overlay ───────────── */

  function ensureRoot() {
    if (root) return;
    const host = $('#view-social') || document.body;
    root = document.createElement('div');
    root.id = 'party';
    root.innerHTML = `
      <div class="party-box">
        <header class="party-head">
          <b id="party-title">Watch party &amp; games</b>
          <span class="party-seats" id="party-seats"></span>
          <span class="sp"></span>
          <button class="pbtn" data-p="join" hidden>JOIN GAME</button>
          <button class="pbtn ghost" data-p="leave" hidden>LEAVE GAME</button>
          <button class="pbtn ghost" data-p="end" hidden>END</button>
          <button class="pbtn ghost" data-p="min" title="Hide (it keeps running)">HIDE</button>
        </header>
        <div class="party-body" id="party-body"></div>
      </div>`;
    host.appendChild(root);
    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-p]');
      if (b) {
        const k = b.dataset.p;
        if (k === 'min') setShown(false);
        else if (k === 'end') endActivity();
        else if (k === 'join') act({ join: 1 });
        else if (k === 'leave') act({ leave: 1 });
        return;
      }
      const s = e.target.closest('[data-start]');
      if (s) start(s.dataset.start);
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && shown && !e.target.closest('input,textarea')) setShown(false); });
  }

  function setShown(v) {
    shown = v;
    root.classList.toggle('on', v);
    if (v) { if (!A) renderPicker(); A?.view?.shown?.(true); } else A?.view?.shown?.(false);
    api?.refreshBar?.();
  }
  function toggle() {
    if (!api?.room()) { toast('Join a voice room first – then you can start a watch party or a game', 'err'); return; }
    setShown(!shown);
  }

  function renderPicker() {
    $('#party-title').textContent = 'Watch party & games';
    $('#party-seats').innerHTML = '';
    for (const b of ['join', 'leave', 'end']) $(`[data-p="${b}"]`, root).hidden = true;
    $('#party-body').innerHTML = `<div class="picker">${[...games.values()].map((g) => `
      <button class="pick" data-start="${g.id}">
        <span class="pick-ico">${g.icon}</span>
        <b>${esc(g.title)}</b>
        <small>${esc(g.desc)}</small>
        <em>${g.solo ? 'everybody in the call' : `2–${g.max} players`}</em>
      </button>`).join('')}</div>
      <p class="pick-note">Starts for everybody in this voice room. The one who starts it is the host.</p>`;
  }

  /* ───────────── activity lifecycle ───────────── */

  function start(id) {
    if (!api.room()) return;
    if (A) { toast('Something is already running in this room', 'err'); return; }
    const mod = games.get(id);
    if (!mod) return;
    A = { id: uid(), game: id, mod, host: me().conn, hostName: me().user, players: [], g: null, view: null, isHost: true, tick: 0 };
    A.g = mod.create(hostCtx());
    if (!mod.solo) seat(me().conn);
    bcast({ nx: 'open', id: A.id, game: id, host: me().conn, hostName: me().user });
    mountActivity();
    pushAll();
    if (mod.heartbeat) A.tick = setInterval(pushAll, mod.heartbeat);
    setShown(true);
  }

  function hostCtx() {
    return { me: me(), players: () => A.players, members, name: nameOf, push: pushAll, toast, end: endActivity };
  }
  function clientCtx() {
    return {
      me: me(), isHost: A.isHost, players: () => A.players, members, name: nameOf, toast,
      act, isPlayer: () => A.players.some((p) => p.conn === me().conn), mod: A.mod, openUrl: (u) => api.openUrl?.(u),
    };
  }

  function mountActivity() {
    const body = $('#party-body');
    body.innerHTML = '';
    const el = document.createElement('div');
    el.className = `act act-${A.game}`;
    body.appendChild(el);
    A.view = A.mod.mount(el, clientCtx());
    $('#party-title').textContent = A.mod.title;
    renderBar();
  }

  function renderBar() {
    if (!A) return;
    const mine = A.players.some((p) => p.conn === me().conn);
    const seatGame = !A.mod.solo;
    $('[data-p="join"]', root).hidden = !(seatGame && !mine && A.players.length < A.mod.max);
    $('[data-p="leave"]', root).hidden = !(seatGame && mine);
    $('[data-p="end"]', root).hidden = !A.isHost;
    $('#party-seats').innerHTML = seatGame ? `${A.players.map((p) => avatar(p.user)).join('')}<small>${A.players.length}/${A.mod.max}</small>` : '';
    api.refreshBar?.();
  }

  function seat(conn) {
    if (!A || A.mod.solo || A.players.length >= A.mod.max || A.players.some((p) => p.conn === conn)) return;
    const p = { conn, user: nameOf(conn) };
    A.players.push(p);
    A.g.onJoin?.(p);
  }
  function unseat(conn) {
    if (!A) return;
    const i = A.players.findIndex((p) => p.conn === conn);
    if (i < 0) return;
    A.players.splice(i, 1);
    A.g.onLeave?.(conn);
  }

  /** Host: sends every member the state as that member may see it. */
  function pushAll() {
    if (!A?.isHost) return;
    for (const m of api.others()) api.sendTo(m.conn, { nx: 'st', id: A.id, players: A.players, s: A.g.view(m.conn) });
    A.view?.update(A.g.view(me().conn), A.players);
    renderBar();
  }

  /** A player's action: the host handles it directly, everybody else sends it to the host. */
  function act(a) {
    if (!A) return;
    if (A.isHost) { hostAct(me().conn, a); return; }
    api.sendTo(A.host, { nx: 'act', id: A.id, a });
  }
  function hostAct(from, a) {
    if (!A?.isHost) return;
    if (a.join) seat(from);
    else if (a.leave) unseat(from);
    else A.g.onAct(from, a);
    pushAll();
  }

  function closeLocal(msg) {
    if (!A) return;
    clearInterval(A.tick);
    try { A.view?.destroy?.(); } catch { /* ignore */ }
    try { A.g?.destroy?.(); } catch { /* ignore */ }
    A = null;
    if (msg) toast(msg);
    if (shown) renderPicker();
    api?.refreshBar?.();
  }
  function endActivity() {
    if (!A?.isHost) return;
    bcast({ nx: 'close', id: A.id });
    closeLocal();
  }

  /* ───────────── messages from the voice room (called by social.js) ───────────── */

  function onMessage(from, user, d) {
    if (!api) return;
    switch (d.nx) {
      case 'open': {
        if (d.host !== from || (A && A.id === d.id)) break;
        const mod = games.get(d.game);
        if (!mod) break;
        if (A && A.isHost) break;                  // I started one first: ignore the other
        if (A) closeLocal();
        A = { id: d.id, game: d.game, mod, host: from, hostName: user, players: [], isHost: false, view: null };
        mountActivity();
        toast(`${user} started ${mod.title}`, '', { label: 'Open', fn: () => setShown(true) });
        break;
      }
      case 'close': if (A && A.id === d.id && from === A.host) closeLocal(`${user} ended ${A?.mod?.title || 'the activity'}`); break;
      case 'hi':
        if (A?.isHost) {
          api.sendTo(from, { nx: 'open', id: A.id, game: A.game, host: me().conn, hostName: me().user });
          api.sendTo(from, { nx: 'st', id: A.id, players: A.players, s: A.g.view(from) });
        }
        break;
      case 'act': if (A?.isHost && d.id === A.id) hostAct(from, d.a || {}); break;
      case 'st':
        if (A && !A.isHost && d.id === A.id && from === A.host) { A.players = d.players || []; A.view?.update(d.s, A.players); renderBar(); }
        break;
      default: break;
    }
  }

  /** I just joined a voice room: ask whether something is running. */
  function hello() { if (api?.others().length) bcast({ nx: 'hi' }); }
  function memberJoined(conn) {
    if (!A?.isHost) return;
    api.sendTo(conn, { nx: 'open', id: A.id, game: A.game, host: me().conn, hostName: me().user });
    api.sendTo(conn, { nx: 'st', id: A.id, players: A.players, s: A.g.view(conn) });
  }
  function memberLeft(conn) {
    if (!A) return;
    if (A.host === conn) { closeLocal('The host left – the activity ended'); return; }
    if (A.isHost) { unseat(conn); pushAll(); }
  }
  function reset() { if (A?.isHost) bcast({ nx: 'close', id: A.id }); closeLocal(); setShown(false); }

  return { debug: () => A, register, attach, toggle, active, isOpen: () => shown, onMessage, hello, memberJoined, memberLeft, reset, esc, avatar, hue, games };
})();

/* ═════════════════════════ Watch party ═════════════════════════
 * Everybody sees the same video. Controls (play, pause, seek, new video) are shared: the host keeps the
 * timeline, so latecomers join at the right position.
 *   YouTube            synchronized through the IFrame API (the default)
 *   direct video link  .mp4 / .webm / .m3u8 … synchronized with a <video> element
 *   any other website  shown in a frame for everybody (same address; sites that forbid framing stay blank)
 */
(() => {
  const esc = Party.esc;
  const SITES_KEY = 'nexus.party.sites';
  const loadSites = () => { try { return JSON.parse(localStorage.getItem(SITES_KEY) || '[]'); } catch { return []; } };
  const saveSites = (l) => { try { localStorage.setItem(SITES_KEY, JSON.stringify(l.slice(0, 24))); } catch { /* ignore */ } };

  /** Understands a YouTube link or id, a direct video link, Vimeo, or any web address. */
  function parseSource(input) {
    let s = String(input || '').trim();
    if (!s) return null;
    if (/^[\w-]{11}$/.test(s)) return { type: 'yt', id: s };
    if (!/^[a-z]+:\/\//i.test(s)) s = `https://${s}`;
    let u;
    try { u = new URL(s); } catch { return null; }
    if (!/^https?:$/.test(u.protocol)) return null;
    const host = u.hostname.replace(/^www\.|^m\./, '');
    if (host === 'youtu.be') return { type: 'yt', id: u.pathname.slice(1, 12) };
    if (/(^|\.)youtube(-nocookie)?\.com$/.test(host)) {
      const id = u.searchParams.get('v') || (u.pathname.match(/\/(embed|shorts|live)\/([\w-]{11})/) || [])[2];
      if (id) return { type: 'yt', id };
      if (host === 'youtube.com' && u.pathname === '/') return null;
    }
    const vimeo = host === 'vimeo.com' && u.pathname.match(/^\/(\d+)/);
    if (vimeo) return { type: 'web', url: `https://player.vimeo.com/video/${vimeo[1]}`, name: 'Vimeo' };
    if (/\.(mp4|webm|ogv|mov|m4v|m3u8|mp3|ogg|wav)(\?|#|$)/i.test(u.pathname)) return { type: 'video', url: u.href };
    return { type: 'web', url: u.href, name: host };
  }
  const sameSrc = (a, b) => !!a && !!b && a.type === b.type && (a.id || a.url) === (b.id || b.url);

  let ytReady = null;
  function loadYT() {
    if (window.YT?.Player) return Promise.resolve();
    if (ytReady) return ytReady;
    ytReady = new Promise((res, rej) => {
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { try { prev?.(); } catch { /* ignore */ } res(); };
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.onerror = () => { ytReady = null; rej(new Error('YouTube could not be loaded (offline?)')); };
      document.head.appendChild(s);
    });
    return ytReady;
  }

  Party.register({
    id: 'watch', title: 'Watch party', solo: true, max: 8, heartbeat: 5000,
    desc: 'Watch YouTube (or any website or video link) together, in sync.',
    icon: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="12" rx="2"/><path d="M10 9l5 2.5-5 2.5zM8 21h8M12 17v4"/></svg>',

    /* host: owns the timeline */
    create(ctx) {
      const t = { src: null, playing: false, pos: 0, at: Date.now(), rev: 0 };
      const now = () => t.pos + (t.playing ? (Date.now() - t.at) / 1000 : 0);
      return {
        onAct(from, a) {
          if (a.src) { t.src = a.src; t.pos = 0; t.playing = true; t.at = Date.now(); t.rev++; ctx.toast(`${ctx.name(from)} opened ${a.src.name || a.src.type}`); }
          else if (a.ctl && t.src) { t.pos = Math.max(0, +a.ctl.pos || 0); t.playing = !!a.ctl.playing; t.at = Date.now(); t.rev++; }
        },
        view() { return { src: t.src, playing: t.playing, pos: now(), rev: t.rev }; },
      };
    },

    /* everybody: the player */
    mount(el, ctx) {
      el.innerHTML = `
        <form class="wp-bar">
          <input class="wp-url" placeholder="YouTube link, video link or any website address…" spellcheck="false">
          <button class="pbtn">PLAY FOR EVERYONE</button>
          <button class="pbtn ghost" type="button" data-save title="Remember this website">☆ SAVE SITE</button>
        </form>
        <div class="wp-sites"></div>
        <div class="wp-stage"><div class="wp-empty"><b>Nothing playing yet</b><span>Paste a YouTube link above, or pick a saved website.<br>Anybody in the call can start, pause and skip – everyone stays in sync.</span></div></div>
        <div class="wp-note" hidden></div>`;
      const stage = el.querySelector('.wp-stage');
      const input = el.querySelector('.wp-url');
      const note = el.querySelector('.wp-note');
      const sitesEl = el.querySelector('.wp-sites');
      let cur = null;                 // the source currently shown
      let player = null;              // {kind, get(), seek(), play(), pause(), destroy()}
      let want = null;                // the latest state from the host
      let quiet = 0;                  // ignore my own events caused by applying the host's state
      let lastKnown = { pos: 0, playing: false, at: Date.now() };
      let poll = 0;
      const hush = (ms = 900) => { quiet = Date.now() + ms; };
      const expected = () => lastKnown.pos + (lastKnown.playing ? (Date.now() - lastKnown.at) / 1000 : 0);

      const renderSites = () => {
        const l = loadSites();
        const base = [{ name: 'YouTube', url: 'https://www.youtube.com/' }, ...l];
        sitesEl.innerHTML = base.map((s, i) => `<span class="wp-site"><button type="button" data-site="${esc(s.url)}">${esc(s.name || s.url)}</button>${i ? `<button type="button" class="x" data-del="${i - 1}" title="Remove">×</button>` : ''}</span>`).join('');
      };
      renderSites();

      const openSrc = (src) => {
        if (!src) { note.hidden = false; note.textContent = 'This address does not look right.'; return; }
        ctx.act({ src });
      };
      el.querySelector('.wp-bar').addEventListener('submit', (e) => {
        e.preventDefault();
        const v = input.value.trim();
        if (!v) return;
        const src = parseSource(v);
        openSrc(src);
      });
      el.querySelector('[data-save]').addEventListener('click', () => {
        const src = parseSource(input.value) || (cur && cur.type === 'web' ? cur : null);
        const url = src?.url || (src?.type === 'yt' ? `https://www.youtube.com/watch?v=${src.id}` : '');
        if (!url) { toast0('Type or paste a website address first'); return; }
        const l = loadSites();
        if (!l.some((s) => s.url === url)) { l.push({ name: src.name || new URL(url).hostname.replace(/^www\./, ''), url }); saveSites(l); renderSites(); }
        toast0('Website saved');
      });
      const toast0 = (m) => ctx.toast(m);
      sitesEl.addEventListener('click', (e) => {
        const del = e.target.closest('[data-del]');
        if (del) { const l = loadSites(); l.splice(Number(del.dataset.del), 1); saveSites(l); renderSites(); return; }
        const b = e.target.closest('[data-site]');
        if (!b) return;
        const url = b.dataset.site;
        if (url === 'https://www.youtube.com/') { input.focus(); input.placeholder = 'Paste a YouTube link here…'; return; }
        openSrc(parseSource(url));
      });

      const killPlayer = () => { clearInterval(poll); try { player?.destroy(); } catch { /* ignore */ } player = null; stage.innerHTML = ''; note.hidden = true; };

      async function load(src) {
        killPlayer();
        cur = src;
        if (!src) { stage.innerHTML = '<div class="wp-empty"><b>Nothing playing yet</b></div>'; return; }
        if (src.type === 'yt') {
          const holder = document.createElement('div');
          holder.id = `ytp-${Math.random().toString(36).slice(2, 8)}`;
          stage.appendChild(holder);
          try { await loadYT(); } catch (e) { note.hidden = false; note.textContent = e.message; return; }
          if (cur !== src) return;
          let ready = false;
          const yt = new window.YT.Player(holder.id, {
            width: '100%', height: '100%', videoId: src.id,
            playerVars: { playsinline: 1, rel: 0, enablejsapi: 1, origin: location.origin, autoplay: 0 },
            events: {
              onReady: () => { ready = true; apply(); },
              onError: (e) => { note.hidden = false; note.textContent = `YouTube refused to play this here (error ${e.data}). Some videos cannot be embedded.`; },
              onStateChange: (e) => {
                if (!ready || Date.now() < quiet) return;
                if (e.data === 1 || e.data === 2) {
                  const pos = yt.getCurrentTime();
                  lastKnown = { pos, playing: e.data === 1, at: Date.now() };
                  ctx.act({ ctl: { playing: e.data === 1, pos } });
                }
              },
            },
          });
          player = {
            get: () => (ready ? { pos: yt.getCurrentTime(), playing: yt.getPlayerState() === 1 } : null),
            seek: (p) => { hush(); yt.seekTo(p, true); },
            play: () => { hush(); yt.playVideo(); },
            pause: () => { hush(); yt.pauseVideo(); },
            destroy: () => { try { yt.destroy(); } catch { /* ignore */ } },
          };
          // somebody dragged the progress bar: YouTube sends no event for that, so compare with the timeline
          poll = setInterval(() => {
            if (!ready || Date.now() < quiet) return;
            const g = player.get();
            if (g && Math.abs(g.pos - expected()) > 2.2 && (g.playing || lastKnown.playing === g.playing)) {
              lastKnown = { pos: g.pos, playing: g.playing, at: Date.now() };
              ctx.act({ ctl: { playing: g.playing, pos: g.pos } });
            }
          }, 500);
        } else if (src.type === 'video') {
          const v = document.createElement('video');
          v.controls = true; v.playsInline = true; v.src = src.url; v.className = 'wp-video';
          stage.appendChild(v);
          const ev = (play) => () => {
            if (Date.now() < quiet) return;
            lastKnown = { pos: v.currentTime, playing: play ?? !v.paused, at: Date.now() };
            ctx.act({ ctl: { playing: lastKnown.playing, pos: v.currentTime } });
          };
          v.addEventListener('play', ev(true));
          v.addEventListener('pause', ev(false));
          v.addEventListener('seeked', ev());
          v.addEventListener('error', () => { note.hidden = false; note.textContent = 'This video link cannot be played.'; });
          v.addEventListener('loadedmetadata', () => apply());
          player = {
            get: () => ({ pos: v.currentTime, playing: !v.paused }),
            seek: (p) => { hush(); v.currentTime = p; },
            play: () => { hush(); v.play().catch(() => { note.hidden = false; note.textContent = 'Click the video once to allow playback.'; }); },
            pause: () => { hush(); v.pause(); },
            destroy: () => { v.pause(); v.removeAttribute('src'); v.load(); },
          };
        } else {
          const f = document.createElement('iframe');
          f.src = src.url; f.className = 'wp-frame';
          f.allow = 'autoplay; fullscreen; encrypted-media; picture-in-picture; clipboard-write';
          f.setAttribute('allowfullscreen', '');
          stage.appendChild(f);
          note.hidden = false;
          note.innerHTML = `Everybody sees <b>${esc(src.name || src.url)}</b>. Playback inside a website cannot be synchronized. If the page stays blank the site does not allow being shown here – <button type="button" class="link" data-ext>open it in your browser</button>.`;
          note.querySelector('[data-ext]').onclick = () => ctx.openUrl(src.url);
        }
        input.value = src.type === 'yt' ? `https://www.youtube.com/watch?v=${src.id}` : src.url;
      }

      function apply() {
        if (!want || !player) return;
        const g = player.get();
        if (!g) return;
        const target = want.pos + (want.playing ? 0.12 : 0);
        lastKnown = { pos: want.pos, playing: want.playing, at: Date.now() };
        if (Math.abs(g.pos - target) > 1.3) player.seek(target);
        if (want.playing && !g.playing) player.play();
        else if (!want.playing && g.playing) player.pause();
      }

      return {
        update(s) {
          want = s;
          if (!sameSrc(s.src, cur)) load(s.src); else apply();
        },
        destroy() { killPlayer(); },
      };
    },
  });
})();
