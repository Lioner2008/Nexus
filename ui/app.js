'use strict';
/* ───────────────────────── Nexus · frontend ───────────────────────── */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

const PLATFORMS = {
  steam:     { name: 'Steam',           short: 'ST', color: '#66c0f4', hint: 'Steam libraries · appmanifest files' },
  epic:      { name: 'Epic Games',      short: 'EP', color: '#e7ecf1', hint: 'ProgramData\\Epic\\EpicGamesLauncher\\Manifests' },
  gog:       { name: 'GOG',             short: 'GG', color: '#b57bff', hint: 'Registry · GOG.com\\Games' },
  ubisoft:   { name: 'Ubisoft Connect', short: 'UB', color: '#4aa8ff', hint: 'Registry · Ubisoft\\Launcher\\Installs' },
  ea:        { name: 'EA app',          short: 'EA', color: '#ff6a5a', hint: 'Program Files\\EA Games' },
  battlenet: { name: 'Battle.net',      short: 'BN', color: '#3d9cff', hint: 'Registry · Blizzard Entertainment' },
  rsi:       { name: 'RSI Launcher',    short: 'RS', color: '#5ec8ff', hint: 'Roberts Space Industries\\StarCitizen\\LIVE' },
};

/* ───────────────────────── themes ───────────────────────── */

const THEMES = {
  neon:   { name: 'Neon',   acc: [200, 255, 46],  ink: '#0a0f03' },
  cyan:   { name: 'Cyan',   acc: [34, 211, 238],  ink: '#021014' },
  ember:  { name: 'Ember',  acc: [255, 138, 43],  ink: '#140800' },
  violet: { name: 'Violet', acc: [167, 139, 250], ink: '#0d0720' },
  rose:   { name: 'Rose',   acc: [255, 77, 125],  ink: '#17020a' },
  mono:   { name: 'Mono',   acc: [236, 239, 243], ink: '#0b0d10' },
  azure:  { name: 'Azure',  acc: [59, 130, 246],  ink: '#ffffff', hidden: true }, // default accent of the clear theme
};
const DARK_TEXT = { text: [238, 242, 246], mut: [135, 147, 160], dim: [96, 107, 118], fg: [255, 255, 255] };
const TONES = {
  black:    { ...DARK_TEXT, bg: [7, 9, 11],   bg2: [11, 15, 19], panel: [16, 21, 26], panel2: [22, 29, 36], line: [30, 38, 46], line2: [43, 54, 64] },
  slate:    { ...DARK_TEXT, bg: [15, 17, 21], bg2: [19, 22, 27], panel: [25, 28, 34], panel2: [32, 36, 43], line: [40, 45, 53], line2: [55, 62, 72] },
  midnight: { ...DARK_TEXT, bg: [6, 9, 20],   bg2: [10, 14, 28], panel: [15, 20, 38], panel2: [21, 27, 50], line: [30, 38, 66], line2: [44, 54, 90] },
  clear:    { light: true, text: [17, 24, 32], mut: [84, 96, 110], dim: [118, 130, 144], fg: [17, 24, 32],
              bg: [243, 246, 250], bg2: [234, 238, 244], panel: [255, 255, 255], panel2: [240, 243, 248], line: [220, 226, 234], line2: [196, 204, 215] },
};
const toHex = (c) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
function hexToRgb(h) {
  const m = /^#?([0-9a-f]{6})$/i.exec(h || '');
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function applyTheme(s) {
  const root = document.documentElement;
  const custom = s.theme === 'custom' ? hexToRgb(s.accent) : null;
  const t = THEMES[s.theme] || THEMES.neon;
  const acc = custom || t.acc;
  const ink = custom ? (0.299 * acc[0] + 0.587 * acc[1] + 0.114 * acc[2] > 150 ? '#0a0d10' : '#ffffff') : t.ink;
  const tone = TONES[s.bgTone] || TONES.black;
  const set = (k, v) => root.style.setProperty(k, v);
  set('--acc-rgb', acc.join(' '));
  set('--acc-ink', ink);
  // on the clear theme accent colored text needs to be darker to stay readable
  set('--acc-t', tone.light ? `rgb(${acc.map((v) => Math.round(v * 0.55)).join(' ')})` : 'var(--acc)');
  set('--bg-rgb', tone.bg.join(' '));
  for (const k of ['bg', 'bg2', 'panel', 'panel2', 'line', 'line2', 'text', 'mut', 'dim']) set(`--${k}`, toHex(tone[k]));
  set('--fg-rgb', tone.fg.join(' '));
  root.classList.toggle('light', !!tone.light);
  root.classList.toggle('no-motion', !!s.noMotion);
}// apply the last used theme immediately, before the backend has answered
try { applyTheme(JSON.parse(store.get('themeCache', '{}'))); } catch { /* defaults */ }

const IC = {
  play: '<svg viewBox="0 0 24 24"><path d="M7 4.5v15a1 1 0 0 0 1.5.9l12-7.5a1 1 0 0 0 0-1.8l-12-7.5A1 1 0 0 0 7 4.5z"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M7 11l5 5 5-5M5 20h14"/></svg>',
  heart: '<svg viewBox="0 0 24 24"><path d="M12 21s-7.5-4.6-9.5-9.2C1 8 3.2 4.5 6.7 4.5c2 0 3.5 1 5.3 3 1.8-2 3.3-3 5.3-3 3.5 0 5.7 3.5 4.2 7.3C19.5 16.4 12 21 12 21z"/></svg>',
  chat: '<svg viewBox="0 0 24 24"><path d="M4 5h16v11H9l-5 4z"/></svg>',
  clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  check: '<svg class="check" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
};

/* ───────────────────────── backend bridge (Tauri or browser mock) ───────────────────────── */

const T = window.__TAURI__;
const api = T
  ? { invoke: T.core.invoke, listen: T.event.listen, src: T.core.convertFileSrc, win: T.window.getCurrentWindow() }
  : makeMock();

/* ───────────────────────── state ───────────────────────── */

const S = {
  games: [], byId: new Map(), art: {}, genres: {},
  settings: {
    sgdbKey: '', steamKey: '', favorites: [], lastPlayed: {},
    theme: 'neon', accent: '#c8ff2e', bgTone: 'black', noMotion: false,
    skipStartupScan: false, minimizeOnLaunch: false, rsiPath: '',
    micId: '', speakerId: '', camId: '', internetMode: false, inviteCode: '',
    socialServer: '', socialUser: '', socialToken: '', tsApiKey: '', tsAddress: '', noLocalServer: false,
  },
  view: 'all', platform: null, install: 'all', genre: 'ALL', q: '', sort: 'recent',
  selected: null, scanning: false,
};
let favSet = new Set();
let cardEls = new Map();
const loadedCovers = new Set();
const grid = $('#grid');
const scroller = $('#scroller');

const hue = (g) => { let h = 7; for (const c of g.name) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360; };
const lastPlayed = (g) => S.settings.lastPlayed[g.id] || 0;
const fmtPlay = (m) => (m < 60 ? `${m}m` : `${(m / 60).toFixed(m < 600 ? 1 : 0)}h`);
const fmtSize = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);
function ago(ts) {
  const d = Math.floor((Date.now() / 1000 - ts) / 86400);
  if (d <= 0) return 'today';
  if (d === 1) return 'yesterday';
  if (d < 30) return `${d} days ago`;
  return `${Math.floor(d / 30)} mo ago`;
}

function setGames(list) {
  S.games = list;
  S.byId = new Map(list.map((g) => [g.id, g]));
}

let saveT = 0;
function saveSettings() {
  clearTimeout(saveT);
  saveT = setTimeout(() => api.invoke('save_settings', { settings: S.settings }), 300);
}

/* ───────────────────────── filtering & sorting ───────────────────────── */

function filtered(skipGenre) {
  const q = S.q.trim().toLowerCase();
  return S.games.filter((g) => {
    if (S.view === 'fav' && !favSet.has(g.id)) return false;
    if (S.view === 'recent' && !lastPlayed(g)) return false;
    if (S.platform && g.platform !== S.platform) return false;
    if (S.install === 'installed' && !g.installed) return false;
    if (S.install === 'missing' && g.installed) return false;
    if (q && !g.name.toLowerCase().includes(q)) return false;
    if (!skipGenre && S.genre !== 'ALL' && !(S.genres[g.id] || []).includes(S.genre)) return false;
    return true;
  });
}

function sortGames(list) {
  const byName = (x, y) => x.name.localeCompare(y.name);
  const cmp = {
    recent: (x, y) => (y.installed - x.installed) || (lastPlayed(y) - lastPlayed(x)) || byName(x, y),
    az: byName,
    played: (x, y) => ((y.playtimeMin || 0) - (x.playtimeMin || 0)) || (lastPlayed(y) - lastPlayed(x)) || byName(x, y),
    platform: (x, y) => x.platform.localeCompare(y.platform) || byName(x, y),
  }[S.sort];
  return [...list].sort(cmp);
}

/* ───────────────────────── rendering: sidebar & chips ───────────────────────── */

function setCount(el, n) {
  const from = Number(el.dataset.v ?? 0);
  el.dataset.v = n;
  if (from === n) { el.textContent = n; return; }
  const t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / 600);
    el.textContent = Math.round(from + (n - from) * (1 - Math.pow(1 - k, 3)));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function renderNav() {
  setCount($('#c-all'), S.games.length);
  setCount($('#c-fav'), S.games.filter((g) => favSet.has(g.id)).length);
  setCount($('#c-recent'), S.games.filter((g) => lastPlayed(g)).length);
  const host = $('#platforms');
  if (!host.children.length) {
    host.innerHTML = Object.entries(PLATFORMS).map(([id, p]) =>
      `<button class="nav-item" data-platform="${id}"><i class="pl-ico">${p.short}</i><span>${p.name}</span><em data-v="0">0</em></button>`).join('');
  }
  for (const b of $$('.nav-item[data-platform]')) {
    const id = b.dataset.platform;
    const n = S.games.filter((g) => g.platform === id).length;
    b.classList.toggle('on', S.platform === id);
    b.classList.toggle('zero', n === 0);
    setCount($('em', b), n);
  }
  for (const b of $$('.nav-item[data-view]')) {
    b.classList.toggle('on', b.dataset.view === S.view && !(b.dataset.view === 'all' && S.platform));
  }
  const inst = S.games.filter((g) => g.installed).length;
  $('#foot-stat').textContent = S.scanning ? 'Scanning…' : `${S.games.length} games · ${inst} installed`;
}

function slide(c) {
  const on = $('.on', c);
  const ind = $('.ind', c);
  if (!on || !ind || !on.offsetWidth) return;
  ind.style.setProperty('--x', `${on.offsetLeft}px`);
  ind.style.setProperty('--w', `${on.offsetWidth}px`);
}

function renderChips() {
  const chips = $('#chips');
  const list = filtered(true);
  const counts = new Map();
  for (const g of list) for (const t of S.genres[g.id] || []) counts.set(t, (counts.get(t) || 0) + 1);
  if (S.genre !== 'ALL' && !counts.has(S.genre)) S.genre = 'ALL';
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 18);
  $$('.chip', chips).forEach((c) => c.remove());
  chips.insertAdjacentHTML('beforeend',
    `<button class="chip ${S.genre === 'ALL' ? 'on' : ''}" data-g="ALL">All<sup>${list.length}</sup></button>` +
    top.map(([t, n]) => `<button class="chip ${t === S.genre ? 'on' : ''}" data-g="${esc(t)}">${esc(t)}<sup>${n}</sup></button>`).join(''));
  slide(chips);
}

/* ───────────────────────── rendering: grid ───────────────────────── */

function cardHTML(g, i) {
  const a = S.art[g.id] || {};
  const p = PLATFORMS[g.platform] || { name: g.platform };
  const genre = (S.genres[g.id] || [])[0];
  const meta = g.installed
    ? `<i class="dot"></i>${esc(p.name)}${genre ? ' · ' + esc(genre) : ''}`
    : `${esc(p.name)} · Not installed`;
  const cover = a.cover
    ? `<img class="cover ${loadedCovers.has(g.id) ? 'loaded' : ''}" src="${esc(api.src(a.cover))}" alt="" draggable="false">`
    : '';
  return `<article class="card ${g.installed ? '' : 'missing'} ${S.selected === g.id ? 'sel' : ''}" data-id="${esc(g.id)}" style="--i:${Math.min(i, 26)};--h:${hue(g)}">
    <div class="card-art">
      <div class="gen"><b>${esc(g.name)}</b><small>${esc(p.name)}</small></div>
      ${cover}
      <div class="glare"></div>
      ${favSet.has(g.id) ? `<span class="fav-badge">${IC.heart}</span>` : ''}
      ${g.installed ? '' : `<span class="dl-badge">${IC.download}</span>`}
      <button class="card-play" data-act="play" aria-label="${g.installed ? 'Play' : 'Install'}">${g.installed ? IC.play : IC.download}</button>
    </div>
    <div class="card-info"><b title="${esc(g.name)}">${esc(g.name)}</b><span>${meta}</span></div>
  </article>`;
}

const coverObserver = new IntersectionObserver((entries) => {
  for (const en of entries) {
    if (!en.isIntersecting) continue;
    coverObserver.unobserve(en.target);
    enqueueArt(en.target.dataset.id, true);
  }
}, { root: scroller, rootMargin: '320px' });

function renderGrid(still) {
  const list = sortGames(filtered(false));
  grid.classList.toggle('still', !!still);
  grid.innerHTML = list.map(cardHTML).join('');
  cardEls = new Map($$('.card', grid).map((el) => [el.dataset.id, el]));
  $('#empty').hidden = list.length > 0;
  coverObserver.disconnect();
  for (const g of list) {
    const a = S.art[g.id];
    if (!(a && (a.cover || a.coverTried))) coverObserver.observe(cardEls.get(g.id));
  }
}

function applyCover(id) {
  const el = cardEls.get(id);
  const a = S.art[id];
  if (!el || !a?.cover || $('.cover', el)) return;
  const art = $('.card-art', el);
  const img = document.createElement('img');
  img.className = 'cover';
  img.draggable = false;
  art.insertBefore(img, $('.glare', art));
  img.src = api.src(a.cover);
}

grid.addEventListener('load', (e) => {
  if (e.target.classList?.contains('cover')) {
    e.target.classList.add('loaded');
    loadedCovers.add(e.target.closest('.card').dataset.id);
  }
}, true);

grid.addEventListener('click', (e) => {
  const card = e.target.closest('.card');
  if (!card) return;
  const g = S.byId.get(card.dataset.id);
  if (e.target.closest('[data-act="play"]')) { selectGame(g.id); play(g); return; }
  selectGame(g.id, true);
});
grid.addEventListener('dblclick', (e) => {
  const card = e.target.closest('.card');
  if (card) play(S.byId.get(card.dataset.id));
});

let tiltRaf = 0;
grid.addEventListener('pointermove', (e) => {
  const art = e.target.closest?.('.card-art');
  if (!art) return;
  const r = art.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width;
  const y = (e.clientY - r.top) / r.height;
  cancelAnimationFrame(tiltRaf);
  tiltRaf = requestAnimationFrame(() => {
    art.style.setProperty('--ry', `${(x - 0.5) * 12}deg`);
    art.style.setProperty('--rx', `${(0.5 - y) * 12}deg`);
    art.style.setProperty('--gx', `${x * 100}%`);
    art.style.setProperty('--gy', `${y * 100}%`);
  });
});
grid.addEventListener('pointerout', (e) => {
  const art = e.target.closest?.('.card-art');
  if (art && !art.contains(e.relatedTarget)) {
    art.style.setProperty('--rx', '0deg');
    art.style.setProperty('--ry', '0deg');
  }
});

/* ───────────────────────── hero ───────────────────────── */

let heroKey = '';
let heroShown = null;

function selectGame(id, scrollUp) {
  S.selected = id;
  $$('.card.sel', grid).forEach((c) => c.classList.remove('sel'));
  cardEls.get(id)?.classList.add('sel');
  renderHero();
  ensureExtras(id);
  if (scrollUp && scroller.scrollTop > 40) scroller.scrollTo({ top: 0 });
}

function setHeroBg(g) {
  const a = S.art[g.id] || {};
  const key = `${g.id}|${a.hero || a.cover || ''}`;
  if (key === heroKey) return;
  heroKey = key;
  const bg = $('#hero-bg');
  const n = document.createElement('div');
  if (a.hero) {
    n.className = 'hbg';
    n.innerHTML = `<img src="${esc(api.src(a.hero))}" alt="" draggable="false">`;
  } else if (a.cover) {
    n.className = 'hbg blur';
    n.innerHTML = `<img src="${esc(api.src(a.cover))}" alt="" draggable="false">`;
  } else {
    n.className = 'hbg gen';
    n.style.setProperty('--h', hue(g));
  }
  const old = [...bg.children];
  bg.appendChild(n);
  const show = () => {
    requestAnimationFrame(() => n.classList.add('in'));
    setTimeout(() => old.forEach((o) => o.remove()), 800);
  };
  const img = $('img', n);
  if (img && !img.complete) {
    img.addEventListener('load', show, { once: true });
    img.addEventListener('error', show, { once: true });
  } else show();
}

function retrigger(el) {
  for (const c of el.children) {
    c.style.animation = 'none';
    void c.offsetWidth;
    c.style.animation = '';
  }
}

function renderHero() {
  let g = S.byId.get(S.selected);
  if (!g && S.games.length) {
    g = sortGames(S.games.filter((x) => x.installed))[0] || sortGames(S.games)[0];
    S.selected = g.id;
    cardEls.get(g.id)?.classList.add('sel');
  }
  const body = $('#hero-body');
  const play = $('#btn-play');
  if (!g) {
    $('#hero-status').innerHTML = '';
    $('#hero-title').hidden = false;
    $('#hero-title').textContent = 'No games yet';
    $('#hero-logo').hidden = true;
    $('#hero-meta').innerHTML = '<span class="pill">Run a scan to find your games</span>';
    $('#hero-credit').textContent = '';
    play.disabled = true;
    $('.bp-label', play).textContent = 'PLAY';
    $('#btn-fav').disabled = true;
    $('#btn-folder').disabled = true;
    return;
  }
  const a = S.art[g.id] || {};
  const p = PLATFORMS[g.platform] || { name: g.platform, color: '#fff' };
  const status = $('#hero-status');
  status.className = `hero-status ${g.installed ? '' : 'missing'}`;
  status.innerHTML = (a.icon ? `<img class="hero-icon" src="${esc(api.src(a.icon))}" alt="">` : '') + `<i class="dot"></i>${g.installed ? 'Installed' : 'Not installed'}`;
  $('#hero-title').textContent = g.name;
  $('#hero-title').hidden = !!a.logo;
  const logo = $('#hero-logo');
  logo.hidden = !a.logo;
  if (a.logo) logo.src = api.src(a.logo);

  const pills = [`<span class="pill"><i style="--c:${p.color}"></i>${esc(p.name)}</span>`];
  for (const t of (S.genres[g.id] || []).slice(0, 3)) pills.push(`<span class="pill">${esc(t)}</span>`);
  if (g.playtimeMin) pills.push(`<span class="pill">${fmtPlay(g.playtimeMin)} played</span>`);
  const lp = lastPlayed(g);
  if (lp) pills.push(`<span class="pill">Last played ${ago(lp)}</span>`);
  if (g.installed && g.sizeBytes) pills.push(`<span class="pill">${fmtSize(g.sizeBytes)}</span>`);
  $('#hero-meta').innerHTML = pills.join('');

  play.disabled = !g.installed && !g.installUri;
  play.classList.toggle('install', !g.installed);
  $('.bp-label', play).innerHTML = g.installed ? `${IC.play}PLAY` : `${IC.download}INSTALL`;
  $('#btn-fav').classList.toggle('on', favSet.has(g.id));
  $('#btn-fav').disabled = false;
  $('#btn-folder').disabled = !(g.installed && g.installPath);
  $('#hero-credit').textContent = a.hero || a.cover ? 'Artwork · SteamGridDB' : '';

  setHeroBg(g);
  if (heroShown !== g.id) { heroShown = g.id; retrigger(body); }
}

async function ensureExtras(id) {
  const g = S.byId.get(id);
  if (!g || !S.settings.sgdbKey || S.art[id]?.extrasTried) return;
  try {
    const art = await api.invoke('fetch_extras', { id, name: g.name, steamAppid: g.steamAppid ?? null });
    S.art[id] = { ...S.art[id], ...art };
    applyCover(id);
    if (S.selected === id) renderHero();
    updateArtRow();
  } catch { /* offline or invalid key – the generated art stays */ }
}

$('#hero').addEventListener('pointermove', (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  const bg = $('#hero-bg');
  bg.style.setProperty('--px', `${-((e.clientX - r.left) / r.width - 0.5) * 18}px`);
  bg.style.setProperty('--py', `${-((e.clientY - r.top) / r.height - 0.5) * 12}px`);
});
$('#hero').addEventListener('pointerleave', () => {
  const bg = $('#hero-bg');
  bg.style.setProperty('--px', '0px');
  bg.style.setProperty('--py', '0px');
});

/* ───────────────────────── actions ───────────────────────── */

async function play(g) {
  if (!g) return;
  const btn = $('#btn-play');
  if (g.installed) {
    btn.classList.remove('busy');
    void btn.offsetWidth;
    btn.classList.add('busy');
    setTimeout(() => btn.classList.remove('busy'), 2500);
    try {
      const ts = await api.invoke('launch_game', { game: g });
      S.settings.lastPlayed[g.id] = ts;
      toast(`Launching ${g.name}…`);
      renderNav();
      if (S.selected === g.id) renderHero();
      if (S.settings.minimizeOnLaunch) setTimeout(() => api.win.minimize(), 900);
    } catch (e) { toast(String(e), 'err'); }
  } else if (g.installUri) {
    try {
      await api.invoke('install_game', { game: g });
      toast(`Opening ${PLATFORMS[g.platform]?.name ?? 'launcher'} to install ${g.name}`);
    } catch (e) { toast(String(e), 'err'); }
  } else {
    toast(`Install ${g.name} from its launcher`, 'err');
  }
}

function toggleFav(id) {
  if (favSet.has(id)) favSet.delete(id); else favSet.add(id);
  S.settings.favorites = [...favSet];
  saveSettings();
  renderNav();
  renderGrid(true);
  renderHero();
  const b = $('#btn-fav');
  b.classList.remove('pop');
  void b.offsetWidth;
  b.classList.add('pop');
}

$('#btn-play').addEventListener('click', () => play(S.byId.get(S.selected)));
$('#btn-fav').addEventListener('click', () => S.selected && toggleFav(S.selected));
$('#btn-folder').addEventListener('click', () => {
  const g = S.byId.get(S.selected);
  if (g?.installPath) api.invoke('open_folder', { path: g.installPath }).catch((e) => toast(String(e), 'err'));
});

/* ───────────────────────── artwork queue (SteamGridDB) ───────────────────────── */

const artQ = [];
const artPending = new Set();
let artActive = 0;
let artDead = false;

function enqueueArt(id, front) {
  if (!S.settings.sgdbKey || artDead || !S.byId.has(id)) return;
  const a = S.art[id];
  if (a && (a.cover || a.coverTried)) return;
  if (artPending.has(id)) return;
  artPending.add(id);
  if (front) artQ.unshift(id); else artQ.push(id);
  pumpArt();
}

function pumpArt() {
  while (artActive < 3 && artQ.length) {
    const id = artQ.shift();
    artActive++;
    fetchCover(id).finally(() => { artActive--; artPending.delete(id); pumpArt(); });
  }
}

async function fetchCover(id) {
  const g = S.byId.get(id);
  if (!g) return;
  try {
    const path = await api.invoke('fetch_cover', { id, name: g.name, steamAppid: g.steamAppid ?? null });
    S.art[id] = { ...(S.art[id] || {}), cover: path || undefined, coverTried: true };
    if (path) {
      applyCover(id);
      if (S.selected === id) renderHero();
    }
  } catch (e) {
    if (/API key/i.test(String(e))) { artDead = true; toast('SteamGridDB: invalid API key', 'err'); }
  }
  updateArtRow();
}

/* ───────────────────────── scan view ───────────────────────── */

let scanChain = Promise.resolve();

function buildScanRows() {
  const rowHTML = (id, p, i) => `<div class="row" data-p="${id}" style="--i:${i}"><i class="pl-ico">${p.short}</i><div><div class="row-name">${p.name}</div><div class="row-path">${esc(p.hint)}</div></div><div class="row-state">Waiting</div><div class="row-bar"><i></i></div></div>`;
  $('#scan-rows').innerHTML =
    Object.entries(PLATFORMS).map(([id, p], i) => rowHTML(id, p, i)).join('') +
    `<div class="row art" data-p="art" style="--i:6"><i class="pl-ico" data-icon="star">★</i><div><div class="row-name">Artwork from SteamGridDB</div><div class="row-path">Covers, heroes, logos and icons matched for every game</div></div><div class="row-state">Waiting</div><div class="row-bar"><i></i></div></div>`;
}

async function onProgress({ platform, state, count }) {
  const row = $(`.row[data-p="${platform}"]`);
  if (!row) return;
  const st = $('.row-state', row);
  if (state === 'running') {
    row.className = 'row run';
    st.textContent = 'Scanning…';
    await sleep(240);
  } else {
    await sleep(420);
    row.className = `row ${count ? 'done' : 'none'}`;
    st.innerHTML = count ? `${IC.check}<span>${count} ${count === 1 ? 'game' : 'games'}</span>` : 'Not found';
  }
}

function updateArtRow() {
  const row = $('.row[data-p="art"]');
  if (!row) return;
  const st = $('.row-state', row);
  if (!S.settings.sgdbKey) {
    row.className = 'row art none';
    st.innerHTML = '<button data-open-settings>Add API key</button>';
    return;
  }
  const total = S.games.length;
  const covered = S.games.filter((g) => S.art[g.id]?.cover).length;
  const tried = S.games.filter((g) => S.art[g.id]?.coverTried || S.art[g.id]?.cover).length;
  const finished = total > 0 && tried >= total;
  row.className = `row art ${finished ? 'done' : 'run'}`;
  row.style.setProperty('--p', total ? tried / total : 0);
  st.innerHTML = `${finished ? IC.check : ''}<span>${covered} of ${total} matched</span>`;
}

function showView(name) {
  $('#view-library').classList.toggle('on', name === 'library');
  $('#view-scan').classList.toggle('on', name === 'scan');
  $('#view-social').classList.toggle('on', name === 'social');
  $('#nav').classList.toggle('in-social', name === 'social');
  if (name === 'social') Social.onShow();
  if (name === 'library') setTimeout(() => { slide($('#seg-install')); slide($('#chips')); }, 80);
}

async function runScan(overlay) {
  if (S.scanning) return;
  S.scanning = true;
  $('#btn-rescan').classList.add('spin');
  renderNav();
  if (overlay) {
    buildScanRows();
    updateArtRow();
    $('#radar').classList.remove('done');
    $('#btn-open').disabled = true;
    showView('scan');
  }
  try {
    const games = await api.invoke('scan_library');
    await scanChain;
    setGames(games);
    if (!S.byId.has(S.selected)) S.selected = null;
    refresh(true);
    renderHero();
    api.invoke('start_enrich');
    sortGames(games).forEach((g) => enqueueArt(g.id, false));
  } catch (e) {
    toast(`Scan failed: ${e}`, 'err');
  } finally {
    S.scanning = false;
    $('#btn-rescan').classList.remove('spin');
    $('#radar').classList.add('done');
    $('#btn-open').disabled = false;
    renderNav();
    updateArtRow();
  }
}

/* ───────────────────────── glue ───────────────────────── */

function refresh(still) {
  renderNav();
  renderChips();
  renderGrid(still);
}

let chipT = 0;
function onGenres({ id, genres }) {
  S.genres[id] = genres;
  clearTimeout(chipT);
  chipT = setTimeout(() => {
    renderChips();
    if (S.selected && S.byId.get(S.selected)) renderHero();
  }, 500);
}

// toolbar
let searchT = 0;
$('#q').addEventListener('input', (e) => {
  clearTimeout(searchT);
  searchT = setTimeout(() => { S.q = e.target.value; renderChips(); renderGrid(true); }, 110);
});
$('#q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const first = sortGames(filtered(false))[0];
    if (first) { selectGame(first.id, true); e.target.blur(); }
  }
  if (e.key === 'Escape') { e.target.value = ''; S.q = ''; renderChips(); renderGrid(true); e.target.blur(); }
});

$('#seg-install').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  S.install = b.dataset.v;
  store.set('install', S.install);
  $$('#seg-install button').forEach((x) => x.classList.toggle('on', x === b));
  slide($('#seg-install'));
  refresh(false);
});

$('#chips').addEventListener('click', (e) => {
  const b = e.target.closest('.chip');
  if (!b) return;
  S.genre = b.dataset.g;
  $$('.chip').forEach((x) => x.classList.toggle('on', x === b));
  slide($('#chips'));
  renderGrid(false);
});

$('#sort').addEventListener('change', (e) => { S.sort = e.target.value; store.set('sort', S.sort); renderGrid(false); });
$('#zoom').addEventListener('input', (e) => {
  document.documentElement.style.setProperty('--card', `${e.target.value}px`);
  store.set('card', e.target.value);
});

$('#nav').addEventListener('click', (e) => {
  const b = e.target.closest('.nav-item');
  if (!b) return;
  if (b.hasAttribute('data-social')) { showView('social'); return; }
  showView('library');
  if (b.dataset.platform) {
    S.platform = S.platform === b.dataset.platform ? null : b.dataset.platform;
  } else {
    S.view = b.dataset.view;
    S.platform = null;
  }
  refresh(false);
  scroller.scrollTo({ top: 0 });
});

$('#btn-rescan').addEventListener('click', () => runScan(true));
$('#btn-scan2').addEventListener('click', () => runScan(true));
$('#btn-open').addEventListener('click', () => showView('library'));
$('#btn-back').addEventListener('click', () => showView('library'));

// window controls
$('#w-min').addEventListener('click', () => api.win.minimize());
$('#w-max').addEventListener('click', () => api.win.toggleMaximize());
$('#w-close').addEventListener('click', () => api.win.close());
window.addEventListener('resize', () => { slide($('#seg-install')); slide($('#chips')); });

// ambient spotlight
window.addEventListener('pointermove', (e) => {
  document.body.style.setProperty('--mx', `${e.clientX}px`);
  document.body.style.setProperty('--my', `${e.clientY}px`);
}, { passive: true });

// keyboard
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); showView('library'); $('#q').focus(); $('#q').select(); }
  if (e.key === 'Escape' && $('#settings').classList.contains('on')) closeSettings();
});

// external links + generic delegated buttons
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-ext]');
  if (a) { e.preventDefault(); api.invoke('open_url', { url: a.href }); return; }
  if (e.target.closest('[data-open-settings]')) openSettings();
});

/* ───────────────────────── settings ───────────────────────── */

const settingsEl = $('#settings');
const THEME_KEYS = ['theme', 'accent', 'bgTone', 'noMotion', 'skipStartupScan', 'minimizeOnLaunch'];
let draft = {};

function renderThemeGrid() {
  const cur = draft.theme || 'neon';
  const accent = draft.accent || '#c8ff2e';
  $('#theme-grid').innerHTML =
    Object.entries(THEMES).filter(([, t]) => !t.hidden).map(([id, t]) =>
      `<button class="theme ${cur === id ? 'on' : ''}" data-theme="${id}" style="--sw:${toHex(t.acc)}"><i></i>${t.name}</button>`).join('') +
    `<button class="theme clear ${draft.bgTone === 'clear' ? 'on' : ''}" data-preset="clear"><i></i>Clear</button>` +
    `<label class="theme custom ${cur === 'custom' ? 'on' : ''}" style="--sw:${accent}"><i></i>Custom<input type="color" value="${accent}" aria-label="Custom accent color"></label>`;
}

function syncBgTone() {
  $$('#bg-tone button').forEach((b) => b.classList.toggle('on', b.dataset.v === (draft.bgTone || 'black')));
}

function openSettings() {
  draft = { ...S.settings };
  $('#set-sgdb').value = S.settings.sgdbKey;
  $('#set-steam').value = S.settings.steamKey;
  $('#set-rsi').value = S.settings.rsiPath || '';
  $('#set-motion').checked = !S.settings.noMotion;
  $('#set-startup-scan').checked = !S.settings.skipStartupScan;
  $('#set-minimize').checked = !!S.settings.minimizeOnLaunch;
  $('#set-local-server').checked = !S.settings.noLocalServer;
  Social.fillDevices();
  Social.netRefresh();
  renderThemeGrid();
  syncBgTone();
  const m = $('#set-sgdb-msg');
  m.className = '';
  m.textContent = 'Free – log in on steamgriddb.com, open Preferences → API.';
  settingsEl.classList.add('on');
  settingsEl.setAttribute('aria-hidden', 'false');
}
function closeSettings() {
  Social.stopDeviceTest();
  applyTheme(S.settings); // drop an unsaved theme preview
  settingsEl.classList.remove('on');
  settingsEl.setAttribute('aria-hidden', 'true');
}
$('#btn-settings').addEventListener('click', openSettings);
$('#set-close').addEventListener('click', closeSettings);
settingsEl.addEventListener('mousedown', (e) => { if (e.target === settingsEl) closeSettings(); });

// live preview while the dialog is open
$('#theme-grid').addEventListener('click', (e) => {
  const preset = e.target.closest('button[data-preset]');
  if (preset) {
    // "Clear" = light surfaces with a blue accent (unless the user already picked a color)
    draft.bgTone = 'clear';
    if (!draft.theme || draft.theme === 'neon' || draft.theme === 'mono') draft.theme = 'azure';
    applyTheme(draft);
    renderThemeGrid();
    syncBgTone();
    return;
  }
  const b = e.target.closest('button[data-theme]');
  if (!b) return;
  draft.theme = b.dataset.theme;
  applyTheme(draft);
  renderThemeGrid();
});
$('#theme-grid').addEventListener('input', (e) => {
  if (e.target.type !== 'color') return;
  draft.theme = 'custom';
  draft.accent = e.target.value;
  applyTheme(draft);
  $$('#theme-grid .theme').forEach((x) => x.classList.toggle('on', x.classList.contains('custom')));
  $('#theme-grid .custom').style.setProperty('--sw', e.target.value);
});
$('#bg-tone').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  draft.bgTone = b.dataset.v;
  applyTheme(draft);
  syncBgTone();
  renderThemeGrid();
});
$('#set-motion').addEventListener('change', (e) => { draft.noMotion = !e.target.checked; applyTheme(draft); });
$('#set-startup-scan').addEventListener('change', (e) => { draft.skipStartupScan = !e.target.checked; });
$('#set-minimize').addEventListener('change', (e) => { draft.minimizeOnLaunch = e.target.checked; });

$('#set-test').addEventListener('click', async () => {
  const m = $('#set-sgdb-msg');
  m.className = '';
  m.textContent = 'Testing…';
  try {
    m.textContent = await api.invoke('test_sgdb_key', { key: $('#set-sgdb').value.trim() });
    m.className = 'ok';
  } catch (e) { m.textContent = String(e); m.className = 'err'; }
});

$('#set-clear-art').addEventListener('click', async () => {
  const n = await api.invoke('clear_art_cache');
  S.art = {};
  artQ.length = 0;
  artPending.clear();
  heroKey = '';
  renderGrid(true);
  renderHero();
  updateArtRow();
  toast(`Artwork cache cleared (${n} files). Covers reload as you scroll.`);
});
$('#set-open-data').addEventListener('click', () => api.invoke('open_data_folder').catch((e) => toast(String(e), 'err')));

$('#set-save').addEventListener('click', async () => {
  const old = { ...S.settings };
  const next = { ...S.settings };
  for (const k of THEME_KEYS) next[k] = draft[k];
  next.sgdbKey = $('#set-sgdb').value.trim();
  next.steamKey = $('#set-steam').value.trim();
  next.rsiPath = $('#set-rsi').value.trim();
  next.noLocalServer = !$('#set-local-server').checked;
  next.micId = $('#dev-mic').value;
  next.speakerId = $('#dev-spk').value;
  next.camId = $('#dev-cam').value;
  S.settings = next;
  store.set('themeCache', JSON.stringify({ theme: next.theme, accent: next.accent, bgTone: next.bgTone, noMotion: next.noMotion }));
  applyTheme(next);
  await api.invoke('save_settings', { settings: next });
  closeSettings();
  toast('Settings saved');
  Social.applyDevices();
  if (next.steamKey !== old.steamKey || next.rsiPath !== old.rsiPath) { runScan(true); return; }
  if (next.sgdbKey !== old.sgdbKey) {
    artDead = false;
    sortGames(S.games).forEach((g) => enqueueArt(g.id, false));
    ensureExtras(S.selected);
    updateArtRow();
  }
});
/* ───────────────────────── artwork picker (per game) ───────────────────────── */

const artUI = { game: null, kind: 'cover', cache: new Map(), busy: false };
const ART_NAMES = { cover: 'Cover', hero: 'Banner', logo: 'Logo', icon: 'Icon' };

function openArt(id) {
  const g = S.byId.get(id);
  if (!g) return;
  artUI.game = g;
  artUI.kind = 'cover';
  $('#art-title').textContent = `ARTWORK · ${g.name.toUpperCase()}`;
  $('#art-url').value = '';
  $$('#art-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.k === 'cover'));
  $('#art-modal').classList.add('on');
  $('#art-modal').setAttribute('aria-hidden', 'false');
  setTimeout(() => slide($('#art-tabs')), 60);
  loadArtOptions();
}
function closeArt() {
  $('#art-modal').classList.remove('on');
  $('#art-modal').setAttribute('aria-hidden', 'true');
}

function artCurrent() {
  const a = S.art[artUI.game?.id] || {};
  return { path: a[artUI.kind], custom: !!a[`${artUI.kind}Custom`] };
}

async function loadArtOptions() {
  const g = artUI.game;
  const k = artUI.kind;
  const grid = $('#art-grid');
  const msg = $('#art-msg');
  grid.dataset.k = k;
  msg.className = 'art-msg';
  msg.textContent = '';
  const cur = artCurrent();
  $('#art-reset').disabled = !cur.custom;
  grid.innerHTML = Array.from({ length: k === 'icon' ? 16 : 8 }, () => '<div class="art-skel"></div>').join('');
  try {
    const key = `${g.id}|${k}`;
    let opts = artUI.cache.get(key);
    if (!opts) {
      opts = await api.invoke('list_art_options', { id: g.id, name: g.name, steamAppid: g.steamAppid ?? null, kind: k });
      artUI.cache.set(key, opts);
    }
    if (artUI.game !== g || artUI.kind !== k) return; // user switched tab meanwhile
    const current = cur.path
      ? `<button class="art-opt cur" data-keep="1" title="Current ${ART_NAMES[k].toLowerCase()}${cur.custom ? ' (your choice)' : ''}"><img src="${esc(api.src(cur.path))}" alt=""><span>${cur.custom ? 'Yours' : 'Current'}</span></button>`
      : '';
    grid.innerHTML = current + opts.map((o, i) =>
      `<button class="art-opt" style="--i:${Math.min(i, 20)}" data-url="${esc(o.url)}" title="${esc([o.style, o.author && `by ${o.author}`].filter(Boolean).join(' · '))}"><img src="${esc(o.thumb)}" loading="lazy" alt=""><span>${o.width}×${o.height}</span></button>`).join('');
    if (!opts.length) {
      msg.textContent = 'Nothing found on SteamGridDB for this game. Use a file or an image link instead.';
    }
  } catch (e) {
    grid.innerHTML = current_(cur);
    msg.className = 'art-msg err';
    msg.textContent = String(e);
  }
}
// shows only the current image when SteamGridDB can't be reached
function current_(cur) {
  return cur.path ? `<button class="art-opt cur" data-keep="1"><img src="${esc(api.src(cur.path))}" alt=""><span>${cur.custom ? 'Yours' : 'Current'}</span></button>` : '';
}

async function applyArt(source, btn) {
  if (artUI.busy) return;
  const g = artUI.game;
  const k = artUI.kind;
  artUI.busy = true;
  btn?.classList.add('busy');
  try {
    const art = await api.invoke('set_art', { id: g.id, kind: k, source });
    afterArtChange(g.id, art, k);
    toast(`${ART_NAMES[k]} updated for ${g.name}`);
    loadArtOptions();
  } catch (e) {
    toast(String(e), 'err');
  } finally {
    artUI.busy = false;
    btn?.classList.remove('busy');
  }
}

function afterArtChange(id, art, kind) {
  S.art[id] = { ...(S.art[id] || {}), ...art };
  if (kind === 'cover') {
    $('.cover', cardEls.get(id) || document.createElement('i'))?.remove();
    applyCover(id);
  }
  if (S.selected === id) renderHero();
  updateArtRow();
}

$('#btn-art').addEventListener('click', () => S.selected && openArt(S.selected));
$('#art-close').addEventListener('click', closeArt);
$('#art-modal').addEventListener('mousedown', (e) => { if (e.target.id === 'art-modal') closeArt(); });
$('#art-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  artUI.kind = b.dataset.k;
  $$('#art-tabs button').forEach((x) => x.classList.toggle('on', x === b));
  slide($('#art-tabs'));
  loadArtOptions();
});
$('#art-grid').addEventListener('click', (e) => {
  const b = e.target.closest('.art-opt');
  if (b?.dataset.url) applyArt(b.dataset.url, b);
});
$('#art-url-go').addEventListener('click', () => {
  const v = $('#art-url').value.trim();
  if (v) applyArt(v);
});
$('#art-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#art-url-go').click(); });
$('#art-file').addEventListener('click', async () => {
  try {
    const dlg = window.__TAURI__?.dialog;
    if (!dlg) { toast('File chooser is only available in the desktop app', 'err'); return; }
    const picked = await dlg.open({ multiple: false, filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }] });
    const path = Array.isArray(picked) ? picked[0] : picked;
    if (path) applyArt(path);
  } catch (e) { toast(String(e), 'err'); }
});
$('#art-reset').addEventListener('click', async () => {
  const g = artUI.game;
  const k = artUI.kind;
  try {
    const art = await api.invoke('reset_art', { id: g.id, kind: k });
    afterArtChange(g.id, art, k);
    if (k === 'cover') enqueueArt(g.id, true); else ensureExtras(g.id);
    toast(`${ART_NAMES[k]} reset to automatic`);
    loadArtOptions();
  } catch (e) { toast(String(e), 'err'); }
});

// right click on a card opens the picker for that game
grid.addEventListener('contextmenu', (e) => {
  const card = e.target.closest('.card');
  if (!card) return;
  e.preventDefault();
  selectGame(card.dataset.id);
  openArt(card.dataset.id);
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('#art-modal').classList.contains('on')) closeArt();
});
/* ───────────────────────── toasts ───────────────────────── */

function toast(msg, kind = '', action) {
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button>${esc(action.label)}</button>` : ''}`;
  const dismiss = () => { t.classList.add('out'); setTimeout(() => t.remove(), 360); };
  if (action) $('button', t).onclick = () => { action.fn(); dismiss(); };
  $('#toasts').append(t);
  setTimeout(dismiss, action ? 7500 : 3600);
}

/* ───────────────────────── boot ───────────────────────── */

function buildSplash() {
  $('#splash-word').innerHTML = [...'NEXUS'].map((c, i) => `<span style="--i:${i}">${c}</span>`).join('');
}

/** Intro: a network of nodes that drifts in and locks into a ring around the logo. Returns a stop function. */
function startSplashCanvas(speed) {
  const cv = $('#splash-canvas');
  const ctx = cv.getContext('2d');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  let w = 0;
  let h = 0;
  const resize = () => {
    w = window.innerWidth; h = window.innerHeight;
    cv.width = w * dpr; cv.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();
  window.addEventListener('resize', resize);
  const rgb = getComputedStyle(document.documentElement).getPropertyValue('--acc-rgb').trim().split(/\s+/).join(',');
  const scale = () => Math.min(w, h) / 800 + 0.4;
  const N = 72;
  const nodes = Array.from({ length: N }, (_, i) => {
    const a = (i / N) * Math.PI * 2 + Math.random() * 0.6;
    const far = Math.max(w, h) * (0.55 + Math.random() * 0.45);
    return {
      sx: w / 2 + Math.cos(a) * far, sy: h / 2 + Math.sin(a) * far, a,
      ring: 70 + (i % 3) * 78 + Math.random() * 34, ph: Math.random() * 6.28, sp: 0.4 + Math.random() * 0.6,
    };
  });
  const T = 1.6 * speed;
  const t0 = performance.now();
  let raf = 0;
  let alive = true;
  const frame = (now) => {
    if (!alive) return;
    const t = (now - t0) / 1000;
    const k = Math.min(1, t / T);
    const e = 1 - Math.pow(1 - k, 3);
    ctx.clearRect(0, 0, w, h);
    const sc = scale();
    const pts = nodes.map((n) => {
      const ang = n.a + t * 0.18 * n.sp;
      const r = n.ring * sc * (1 + 0.06 * Math.sin(t * 1.3 + n.ph));
      const tx = w / 2 + Math.cos(ang) * r;
      const ty = h / 2 + Math.sin(ang) * r * 0.78;
      return { x: n.sx + (tx - n.sx) * e, y: n.sy + (ty - n.sy) * e };
    });
    const maxd = 150 * sc;
    ctx.lineWidth = 1;
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        const dx = pts[i].x - pts[j].x;
        const dy = pts[i].y - pts[j].y;
        const d2 = dx * dx + dy * dy;
        if (d2 < maxd * maxd) {
          ctx.strokeStyle = `rgba(${rgb},${(1 - Math.sqrt(d2) / maxd) * 0.55 * e})`;
          ctx.beginPath(); ctx.moveTo(pts[i].x, pts[i].y); ctx.lineTo(pts[j].x, pts[j].y); ctx.stroke();
        }
      }
    }
    ctx.fillStyle = `rgba(${rgb},${0.45 + 0.55 * e})`;
    for (const p of pts) { ctx.beginPath(); ctx.arc(p.x, p.y, 2.1, 0, 6.283); ctx.fill(); }
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  return () => { alive = false; cancelAnimationFrame(raf); window.removeEventListener('resize', resize); };
}
function restorePrefs() {
  S.sort = store.get('sort', 'recent');
  S.install = store.get('install', 'all');
  const card = store.get('card', '176');
  $('#sort').value = S.sort;
  $('#zoom').value = card;
  document.documentElement.style.setProperty('--card', `${card}px`);
  $$('#seg-install button').forEach((x) => x.classList.toggle('on', x.dataset.v === S.install));
  $$('[data-icon]').forEach((el) => { if (IC[el.dataset.icon]) el.innerHTML = IC[el.dataset.icon]; });
}

async function boot() {
  const splash = $('#splash');
  const returning = store.get('introSeen', '') === '1';
  const reduced = document.documentElement.classList.contains('no-motion') || matchMedia('(prefers-reduced-motion: reduce)').matches;
  const speed = returning ? 0.55 : 1;
  const minTime = reduced ? 350 : returning ? 1900 : 3400;
  splash.style.setProperty('--s', speed);
  const progress = (pct, label) => {
    $('#splash-fill').style.setProperty('--p', `${pct}%`);
    if (label) $('#splash-status').textContent = label;
  };
  buildSplash();
  const stopCanvas = reduced ? () => {} : startSplashCanvas(speed);
  const t0 = performance.now();
  progress(12, 'Starting');
  restorePrefs();
  await api.listen('scan-progress', (e) => { scanChain = scanChain.then(() => onProgress(e.payload)); });
  await api.listen('genres-updated', (e) => onGenres(e.payload));

  progress(34, 'Loading library');
  const b = await api.invoke('bootstrap');
  S.settings = { ...S.settings, ...b.settings };
  if (!S.settings.theme) S.settings.theme = 'neon';
  if (!S.settings.bgTone) S.settings.bgTone = 'black';
  applyTheme(S.settings);
  favSet = new Set(S.settings.favorites || []);
  S.art = b.art || {};
  S.genres = b.genres || {};
  setGames(b.library || []);
  progress(66, 'Preparing games');
  Social.init();
  refresh(true);
  renderHero();

  const hasLibrary = S.games.length > 0;
  if (!hasLibrary) { buildScanRows(); updateArtRow(); showView('scan'); }
  $$('.nav-item').forEach((el, i) => el.style.setProperty('--n', i));

  await sleep(Math.max(0, minTime * 0.7 - (performance.now() - t0)));
  progress(100, 'Ready');
  await sleep(Math.max(0, minTime - (performance.now() - t0)));

  // reveal: the intro zooms away while the interface builds up behind it
  document.body.classList.add('entered');
  if (hasLibrary) renderGrid(false);
  splash.classList.add('out');
  setTimeout(stopCanvas, 1000);
  store.set('introSeen', '1');
  slide($('#seg-install'));
  slide($('#chips'));
  if (hasLibrary && S.settings.skipStartupScan) {
    api.invoke('start_enrich');
    sortGames(S.games).forEach((g) => enqueueArt(g.id, false));
  } else runScan(!hasLibrary);

  if (!S.settings.sgdbKey) {
    setTimeout(() => toast('Add a free SteamGridDB key to load cover art', '', { label: 'Open settings', fn: openSettings }), 3200);
  }
}
boot().catch((e) => { console.error(e); toast(`Startup error: ${e}`, 'err'); $('#splash').classList.add('out'); });

/* ───────────────────────── browser mock (UI preview without Rust) ───────────────────────── */

function makeMock() {
  const subs = {};
  const emit = (n, p) => (subs[n] || []).forEach((f) => f({ payload: p }));
  const demo = [
    ['Neon Drift', 'steam', 1, ['Racing', 'Indie']], ['Ashen Crown', 'epic', 1, ['Action', 'RPG']],
    ['Void Runners', 'gog', 1, ['Action', 'Indie']], ['Ironhold', 'gog', 0, ['Strategy']],
    ['Deep Signal', 'epic', 1, ['Adventure']], ['Pixel Harbor', 'steam', 1, ['Indie', 'Simulation']],
    ['Redline Apex', 'ubisoft', 1, ['Racing', 'Sports']], ['Hollow Saints', 'steam', 0, ['Action', 'Adventure']],
    ['Orbit Colony', 'gog', 1, ['Strategy', 'Simulation']], ['Frostline', 'battlenet', 1, ['Strategy']],
    ['Mossheart', 'steam', 0, ['Adventure', 'Indie']], ['Tidebreaker', 'epic', 0, ['RPG', 'Action']],
    ['Cinder Vale', 'ea', 1, ['Adventure']], ['Night Courier', 'steam', 1, ['Indie']],
    ['Gravity Well', 'steam', 0, ['Simulation']], ['Static Bloom', 'epic', 1, ['Indie', 'Adventure']],
    ['Rust Kingdom', 'steam', 1, ['Strategy', 'RPG']], ['Skyline Rush', 'ubisoft', 0, ['Racing']],
    ['Star Citizen', 'rsi', 1, ['Simulation', 'Action', 'MMO']],
  ];
  const games = demo.map(([name, platform, inst], i) => ({
    id: `${platform}:${i}`, name, platform, installed: !!inst, installPath: `C:\\Games\\${name}`,
    launchUri: 'x://', installUri: 'x://i', steamAppid: null, sizeBytes: (8 + i * 3) * 1e9, playtimeMin: inst ? i * 95 : null,
  }));
  let settings = { sgdbKey: '', steamKey: '', favorites: [], lastPlayed: {} };
  return {
    src: (p) => p,
    win: { minimize() {}, toggleMaximize() {}, close() {} },
    listen: async (n, f) => { (subs[n] ||= []).push(f); return () => {}; },
    async invoke(cmd, args) {
      switch (cmd) {
        case 'bootstrap': return { settings, library: [], art: {}, genres: {} };
        case 'scan_library':
          for (const p of Object.keys(PLATFORMS)) {
            emit('scan-progress', { platform: p, state: 'running', count: 0 });
            await sleep(250);
            emit('scan-progress', { platform: p, state: 'done', count: games.filter((g) => g.platform === p).length });
          }
          return games;
        case 'start_enrich':
          games.forEach((g, i) => setTimeout(() => emit('genres-updated', { id: g.id, genres: demo[i][3] }), 700 + i * 140));
          return null;
        case 'save_settings': settings = args.settings; return null;
        case 'launch_game': return Math.floor(Date.now() / 1000);
        case 'fetch_cover': return null;
        case 'fetch_extras': return {};
        case 'test_sgdb_key': return 'Key works (mock)';
        case 'clear_art_cache': return 0;
        case 'server_status': return { running: true, address: '127.0.0.1:7777', hasBinary: true, internet: false };
        case 'list_art_options': return [];
        case 'set_art': return {};
        case 'reset_art': return {};
        case 'open_data_folder': return null;
        default: return null;
      }
    },
  };
}
