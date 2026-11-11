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

/* ───────────────────────── state ─────────────────────────
 * The library itself (games, artwork, genres, favorites, sorting, filtering, the HTML of every
 * card and of the header) lives in Rust. This file only keeps what is on screen right now. */

const S = {
  settings: {
    sgdbKey: '', steamKey: '', favorites: [], lastPlayed: {},
    theme: 'neon', accent: '#c8ff2e', bgTone: 'black', noMotion: false,
    skipStartupScan: false, minimizeOnLaunch: false, rsiPath: '',
    micId: '', speakerId: '', camId: '', internetMode: false, inviteCode: '',
    noUpdateCheck: false, noAutoInstall: false, skipVersion: '', noCallSounds: false, noAutoWatch: false, sounds: [], peerVolumes: {}, sfxVolume: null,
    socialServer: '', socialUser: '', socialToken: '', tsApiKey: '', tsAddress: '', noLocalServer: false,
  },
  view: 'all', platform: null, install: 'all', genre: 'ALL', q: '', sort: 'recent',
  selected: null, scanning: false,
  // current library view from Rust
  ids: [], cards: [], index: new Map(), counts: { all: 0, fav: 0, recent: 0, installed: 0, platforms: {}, covered: 0, tried: 0 },
  hero: null,
};
const loadedCovers = new Set();
const grid = $('#grid');
const scroller = $('#scroller');

let saveT = 0;
function saveSettings() {
  clearTimeout(saveT);
  saveT = setTimeout(() => api.invoke('save_settings', { settings: S.settings }).then((s) => { if (s) S.settings = { ...S.settings, ...s }; }), 300);
}

const query = () => ({ view: S.view, platform: S.platform, install: S.install, genre: S.genre, q: S.q, sort: S.sort });

/** Asks Rust for the library view. `grid`: false keeps the cards on screen (counters/chips only). */
let viewSeq = 0;
async function refresh(still, opts = {}) {
  const seq = ++viewSeq;
  const v = await api.invoke('library_view', { query: query() });
  if (seq !== viewSeq) return; // a newer request is on its way
  S.counts = v.counts;
  S.genre = v.genre;
  renderNav();
  renderChips(v.chips);
  updateArtRow();
  const same = v.ids.length === S.ids.length && v.ids.every((id, i) => id === S.ids[i]);
  if (opts.grid === false && same) {
    S.cards = v.cards; // fresh HTML (e.g. a new genre) for cards mounted later
    return;
  }
  if (opts.grid === false) return;
  S.ids = v.ids;
  S.cards = v.cards;
  S.index = new Map(v.ids.map((id, i) => [id, i]));
  renderGrid(still);
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
  const c = S.counts;
  setCount($('#c-all'), c.all);
  setCount($('#c-fav'), c.fav);
  setCount($('#c-recent'), c.recent);
  const host = $('#platforms');
  if (!host.children.length) {
    host.innerHTML = Object.entries(PLATFORMS).map(([id, p]) =>
      `<button class="nav-item" data-platform="${id}"><i class="pl-ico">${p.short}</i><span>${p.name}</span><em data-v="0">0</em></button>`).join('');
  }
  for (const b of $$('.nav-item[data-platform]')) {
    const id = b.dataset.platform;
    const n = c.platforms[id] || 0;
    b.classList.toggle('on', S.platform === id);
    b.classList.toggle('zero', n === 0);
    setCount($('em', b), n);
  }
  for (const b of $$('.nav-item[data-view]')) {
    b.classList.toggle('on', b.dataset.view === S.view && !(b.dataset.view === 'all' && S.platform));
  }
  $('#foot-stat').textContent = S.scanning ? 'Scanning…' : `${c.all} games · ${c.installed} installed`;
}

function slide(c) {
  const on = $('.on', c);
  const ind = $('.ind', c);
  if (!on || !ind || !on.offsetWidth) return;
  ind.style.setProperty('--x', `${on.offsetLeft}px`);
  ind.style.setProperty('--w', `${on.offsetWidth}px`);
}

function renderChips(html) {
  const chips = $('#chips');
  $$('.chip', chips).forEach((c) => c.remove());
  chips.insertAdjacentHTML('beforeend', html);
  slide(chips);
}

/* ───────────────────────── rendering: grid (virtual) ─────────────────────────
 * Only the rows on screen (plus a few above and below) exist in the page. Cards that scroll out
 * are removed together with their cover image, so the web view never holds hundreds of decoded
 * covers at once – that used to grow to several GB with a big library. */

const VG = { start: 0, end: -1, cols: 1, rowH: 300, padTop: 10, els: new Map(), raf: 0, firstRow: 0 };
const ROW_GAP = 26;
const COL_GAP = 20;
const OVERSCAN = 2;
const tpl = document.createElement('template');

function measure() {
  const cs = getComputedStyle(grid);
  const inner = grid.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const card = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--card')) || 176;
  VG.cols = Math.max(1, Math.floor((inner + COL_GAP) / (card + COL_GAP)));
  const cw = (inner - (VG.cols - 1) * COL_GAP) / VG.cols;
  const sample = grid.querySelector('.card');
  const h = sample ? sample.offsetHeight : cw * 1.5 + 58;
  VG.rowH = Math.max(40, h) + ROW_GAP;
}

function makeCard(i, still) {
  tpl.innerHTML = S.cards[i];
  const el = tpl.content.firstElementChild;
  const id = S.ids[i];
  if (id === S.selected) el.classList.add('sel');
  if (still) el.classList.add('na');
  const cover = $('.cover', el);
  if (cover && loadedCovers.has(id)) cover.classList.add('loaded');
  return el;
}

/** Mounts the cards of the visible rows. `fresh`: rebuild everything (new filter or sorting). */
function mountVisible(fresh) {
  const n = S.ids.length;
  if (!n) {
    grid.replaceChildren();
    VG.els = new Map();
    grid.style.paddingTop = '';
    grid.style.paddingBottom = '';
    return;
  }
  const rows = Math.ceil(n / VG.cols);
  const top = grid.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop + VG.padTop;
  const y0 = scroller.scrollTop - top;
  const y1 = y0 + scroller.clientHeight;
  const firstRow = Math.max(0, Math.min(rows - 1, Math.floor(y0 / VG.rowH) - OVERSCAN));
  const lastRow = Math.max(firstRow, Math.min(rows - 1, Math.ceil(y1 / VG.rowH) + OVERSCAN));
  const start = firstRow * VG.cols;
  const end = Math.min(n, (lastRow + 1) * VG.cols) - 1;
  if (!fresh && start === VG.start && end === VG.end) return;

  const keep = new Map();
  const want = [];
  for (let i = start; i <= end; i++) {
    const id = S.ids[i];
    let el = fresh ? null : VG.els.get(id);
    if (!el) el = makeCard(i, !fresh);
    keep.set(id, el);
    want.push(el);
  }
  // remove what scrolled away, then insert the new cards around the ones that stay
  for (const [id, el] of VG.els) if (keep.get(id) !== el) el.remove();
  let cursor = grid.firstElementChild;
  for (const el of want) {
    if (el === cursor) cursor = cursor.nextElementSibling;
    else grid.insertBefore(el, cursor);
  }
  while (cursor) { const nx = cursor.nextElementSibling; cursor.remove(); cursor = nx; }

  VG.els = keep;
  VG.start = start;
  VG.end = end;
  VG.firstRow = firstRow;
  grid.style.paddingTop = `${VG.padTop + firstRow * VG.rowH}px`;
  grid.style.paddingBottom = `${48 + Math.max(0, rows - lastRow - 1) * VG.rowH}px`;
  reportVisible();
}

let visT = 0;
function reportVisible() {
  clearTimeout(visT);
  visT = setTimeout(() => {
    const ids = S.ids.slice(VG.start, VG.end + 1);
    if (ids.length) api.invoke('art_visible', { ids }).catch(() => {});
  }, 120);
}

function renderGrid(still) {
  grid.classList.toggle('still', !!still);
  $('#empty').hidden = S.ids.length > 0;
  grid.replaceChildren();
  VG.els = new Map();
  VG.start = 0; VG.end = -1;
  measure();
  mountVisible(true);
  // the real card height is known once one card is in the page
  const before = [VG.rowH, VG.cols];
  measure();
  if (Math.abs(before[0] - VG.rowH) > 1 || before[1] !== VG.cols) { VG.start = -1; mountVisible(false); }
}

function onScrollOrResize(remeasure) {
  if (VG.raf) return;
  VG.raf = requestAnimationFrame(() => {
    VG.raf = 0;
    if (remeasure) { measure(); VG.start = -1; }
    mountVisible(false);
  });
}
scroller.addEventListener('scroll', () => onScrollOrResize(false), { passive: true });
new ResizeObserver(() => onScrollOrResize(true)).observe(scroller);

function cardEl(id) { return VG.els.get(id); }

function applyCover(id, url) {
  const el = cardEl(id);
  if (!el || !url || $('.cover', el)) return;
  const art = $('.card-art', el);
  const img = document.createElement('img');
  img.className = 'cover';
  img.draggable = false;
  img.loading = 'lazy';
  img.decoding = 'async';
  art.insertBefore(img, $('.glare', art));
  img.src = url;
}

/** New HTML for one card (cover, favorite …): stored for later and patched in when it is on screen. */
function updateCard(id, html, cover) {
  const i = S.index.get(id);
  if (i !== undefined && html) S.cards[i] = html;
  if (cover) applyCover(id, cover);
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
  const id = card.dataset.id;
  if (e.target.closest('[data-act="play"]')) { selectGame(id); play(id); return; }
  selectGame(id, true);
});
grid.addEventListener('dblclick', (e) => {
  const card = e.target.closest('.card');
  if (card) play(card.dataset.id);
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
  cardEl(id)?.classList.add('sel');
  renderHero();
  if (scrollUp && scroller.scrollTop > 40) scroller.scrollTo({ top: 0 });
}

function setHeroBg(h) {
  const key = `${h.id}|${h.bgUrl || ''}`;
  if (key === heroKey) return;
  heroKey = key;
  const bg = $('#hero-bg');
  const n = document.createElement('div');
  if (h.bgKind === 'hero') {
    n.className = 'hbg';
    n.innerHTML = `<img src="${esc(h.bgUrl)}" alt="" draggable="false">`;
  } else if (h.bgKind === 'blur') {
    n.className = 'hbg blur';
    n.innerHTML = `<img src="${esc(h.bgUrl)}" alt="" draggable="false">`;
  } else {
    n.className = 'hbg gen';
    n.style.setProperty('--h', h.hue);
  }
  const old = [...bg.children];
  bg.appendChild(n);
  const show = () => {
    requestAnimationFrame(() => n.classList.add('in'));
    setTimeout(() => old.forEach((o) => { $('img', o)?.removeAttribute('src'); o.remove(); }), 800);
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

let heroSeq = 0;
async function renderHero() {
  const seq = ++heroSeq;
  const h = await api.invoke('hero_view', { id: S.selected });
  if (seq !== heroSeq) return;
  applyHero(h);
}

function applyHero(h) {
  S.hero = h;
  const body = $('#hero-body');
  const play = $('#btn-play');
  if (!h) {
    S.selected = null;
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
  if (S.selected !== h.id) {
    S.selected = h.id;
    $$('.card.sel', grid).forEach((c) => c.classList.remove('sel'));
    cardEl(h.id)?.classList.add('sel');
  }
  const status = $('#hero-status');
  status.className = `hero-status ${h.installed ? '' : 'missing'}`;
  status.innerHTML = h.statusHtml;
  $('#hero-title').textContent = h.name;
  $('#hero-title').hidden = !!h.logo;
  const logo = $('#hero-logo');
  logo.hidden = !h.logo;
  if (h.logo) logo.src = h.logo; else logo.removeAttribute('src');
  $('#hero-meta').innerHTML = h.metaHtml;

  play.disabled = !h.canPlay;
  play.classList.toggle('install', !h.installed);
  $('.bp-label', play).innerHTML = h.installed ? `${IC.play}PLAY` : `${IC.download}INSTALL`;
  $('#btn-fav').classList.toggle('on', h.fav);
  $('#btn-fav').disabled = false;
  $('#btn-folder').disabled = !h.folder;
  $('#hero-credit').textContent = h.credit;

  setHeroBg(h);
  if (heroShown !== h.id) { heroShown = h.id; retrigger(body); }
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

/** Rust decides: start the game when it is installed, otherwise open its launcher to install it. */
async function play(id) {
  if (!id) return;
  const btn = $('#btn-play');
  const busy = () => {
    btn.classList.remove('busy');
    void btn.offsetWidth;
    btn.classList.add('busy');
    setTimeout(() => btn.classList.remove('busy'), 2500);
  };
  if (S.hero?.id === id && S.hero.installed) busy();
  try {
    const r = await api.invoke('play_game', { id });
    toast(r.message);
    if (!r.launched) return;
    S.settings.lastPlayed[id] = r.ts;
    refresh(true, { grid: false });
    if (S.selected === id) renderHero();
    if (r.minimize) setTimeout(() => api.win.minimize(), 900);
  } catch (e) { toast(String(e), 'err'); }
}

async function toggleFav(id) {
  const on = await api.invoke('toggle_favorite', { id });
  const favs = new Set(S.settings.favorites || []);
  if (on) favs.add(id); else favs.delete(id);
  S.settings.favorites = [...favs];
  await refresh(true);
  renderHero();
  const b = $('#btn-fav');
  b.classList.remove('pop');
  void b.offsetWidth;
  b.classList.add('pop');
}

$('#btn-play').addEventListener('click', () => play(S.selected));
$('#btn-fav').addEventListener('click', () => S.selected && toggleFav(S.selected));
$('#btn-folder').addEventListener('click', () => {
  if (S.selected) api.invoke('open_game_folder', { id: S.selected }).catch((e) => toast(String(e), 'err'));
});

/* ───────────────────────── artwork (downloaded by Rust in the background) ───────────────────────── */

function onArtUpdated({ id, cover, card, covered, tried, total }) {
  S.counts.covered = covered;
  S.counts.tried = tried;
  S.counts.all = total;
  updateCard(id, card, cover);
  if (S.selected === id) renderHero();
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
  const { all: total, covered, tried } = S.counts;
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
  if (name === 'library') setTimeout(() => { slide($('#seg-install')); slide($('#chips')); onScrollOrResize(true); }, 80);
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
    await api.invoke('scan_library'); // also starts genre lookups and cover downloads in Rust
    await scanChain;
    await refresh(true);
    renderHero();
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

let chipT = 0;
function onGenres() {
  clearTimeout(chipT);
  chipT = setTimeout(() => {
    refresh(true, { grid: false });
    if (S.selected) renderHero();
  }, 500);
}

// toolbar
let searchT = 0;
$('#q').addEventListener('input', (e) => {
  clearTimeout(searchT);
  searchT = setTimeout(() => { S.q = e.target.value; refresh(true); }, 110);
});
$('#q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const first = S.ids[0];
    if (first) { selectGame(first, true); e.target.blur(); }
  }
  if (e.key === 'Escape') { e.target.value = ''; S.q = ''; refresh(true); e.target.blur(); }
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
  refresh(false);
});

$('#sort').addEventListener('change', (e) => { S.sort = e.target.value; store.set('sort', S.sort); refresh(false); });
$('#zoom').addEventListener('input', (e) => {
  document.documentElement.style.setProperty('--card', `${e.target.value}px`);
  store.set('card', e.target.value);
  onScrollOrResize(true);
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
  scroller.scrollTo({ top: 0 });
  refresh(false);
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
let spotRaf = 0;
window.addEventListener('pointermove', (e) => {
  if (spotRaf) return;
  spotRaf = requestAnimationFrame(() => {
    spotRaf = 0;
    document.body.style.setProperty('--mx', `${e.clientX}px`);
    document.body.style.setProperty('--my', `${e.clientY}px`);
  });
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
  $('#set-autoupdate').checked = !S.settings.noUpdateCheck;
  $('#set-autoinstall').checked = !S.settings.noAutoInstall;
  $('#set-callsounds').checked = !S.settings.noCallSounds;
  $('#set-autowatch').checked = !S.settings.noAutoWatch;
  Updater.fillAbout();
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
  loadedCovers.clear();
  heroKey = '';
  await refresh(true);
  renderHero();
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
  next.noUpdateCheck = !$('#set-autoupdate').checked;
  next.noAutoInstall = !$('#set-autoinstall').checked;
  next.noCallSounds = !$('#set-callsounds').checked;
  next.noAutoWatch = !$('#set-autowatch').checked;
  next.micId = $('#dev-mic').value;
  next.speakerId = $('#dev-spk').value;
  next.camId = $('#dev-cam').value;
  S.settings = next;
  store.set('themeCache', JSON.stringify({ theme: next.theme, accent: next.accent, bgTone: next.bgTone, noMotion: next.noMotion }));
  applyTheme(next);
  S.settings = { ...next, ...(await api.invoke('save_settings', { settings: next })) };
  closeSettings();
  toast('Settings saved');
  Social.applyDevices();
  if (next.steamKey !== old.steamKey || next.rsiPath !== old.rsiPath) { runScan(true); return; }
  if (next.sgdbKey !== old.sgdbKey) {
    // Rust restarts the cover downloads itself; the header asks for banner and logo again
    renderHero();
    updateArtRow();
  }
});
/* ───────────────────────── artwork picker (per game) ───────────────────────── */

const artUI = { game: null, kind: 'cover', cache: new Map(), busy: false };
const ART_NAMES = { cover: 'Cover', hero: 'Banner', logo: 'Logo', icon: 'Icon' };

function nameOf(id) {
  if (S.hero?.id === id) return S.hero.name;
  return $('.card-info b', cardEl(id) || document.createElement('i'))?.title || '';
}

function openArt(id) {
  const g = { id, name: nameOf(id) };
  if (!g.name) return;
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
  return api.invoke('art_current', { id: artUI.game.id, kind: artUI.kind }).catch(() => ({ url: null, custom: false }));
}

async function loadArtOptions() {
  const g = artUI.game;
  const k = artUI.kind;
  const grid = $('#art-grid');
  const msg = $('#art-msg');
  grid.dataset.k = k;
  msg.className = 'art-msg';
  msg.textContent = '';
  const cur = await artCurrent();
  $('#art-reset').disabled = !cur.custom;
  grid.innerHTML = Array.from({ length: k === 'icon' ? 16 : 8 }, () => '<div class="art-skel"></div>').join('');
  try {
    const key = `${g.id}|${k}`;
    let opts = artUI.cache.get(key);
    if (!opts) {
      opts = await api.invoke('list_art_options', { id: g.id, kind: k });
      artUI.cache.set(key, opts);
    }
    if (artUI.game !== g || artUI.kind !== k) return; // user switched tab meanwhile
    const current = cur.url
      ? `<button class="art-opt cur" data-keep="1" title="Current ${ART_NAMES[k].toLowerCase()}${cur.custom ? ' (your choice)' : ''}"><img src="${esc(cur.url)}" alt=""><span>${cur.custom ? 'Yours' : 'Current'}</span></button>`
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
  return cur.url ? `<button class="art-opt cur" data-keep="1"><img src="${esc(cur.url)}" alt=""><span>${cur.custom ? 'Yours' : 'Current'}</span></button>` : '';
}

async function applyArt(source, btn) {
  if (artUI.busy) return;
  const g = artUI.game;
  const k = artUI.kind;
  artUI.busy = true;
  btn?.classList.add('busy');
  try {
    const change = await api.invoke('set_art', { id: g.id, kind: k, source });
    afterArtChange(g.id, change, k);
    toast(`${ART_NAMES[k]} updated for ${g.name}`);
    loadArtOptions();
  } catch (e) {
    toast(String(e), 'err');
  } finally {
    artUI.busy = false;
    btn?.classList.remove('busy');
  }
}

function afterArtChange(id, change, kind) {
  if (kind === 'cover') {
    $('.cover', cardEl(id) || document.createElement('i'))?.remove();
    loadedCovers.delete(id);
    updateCard(id, change.card, change.cover);
  }
  if (S.selected === id && change.hero) applyHero(change.hero);
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
    const change = await api.invoke('reset_art', { id: g.id, kind: k });
    afterArtChange(g.id, change, k); // Rust fetches the automatic artwork again
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
/* ───────────────────────── updates ─────────────────────────
 * Rust checks GitHub shortly after the start and every 6 hours, downloads a new version in the
 * background and installs it silently when Nexus is closed. This bar only shows what happens. */

const Updater = {
  info: null,
  busy: false,
  ready: false,
  async fillAbout() {
    try { $('#about-ver').textContent = `v${await api.invoke('app_version')}`; } catch { $('#about-ver').textContent = ''; }
  },
  setStatus(text) { $('#upd-status').textContent = text; },
  async check(manual) {
    if (!window.__TAURI__ || this.busy) return;
    if (manual) this.setStatus('Checking…');
    try {
      const info = await api.invoke('check_update');
      this.info = info;
      if (info.available) {
        this.setStatus(this.ready ? `Version ${info.latest} is ready to install` : `Version ${info.latest} is available`);
        if (this.ready) this.showReady(info);
        else if (manual || info.latest !== S.settings.skipVersion) this.show(info);
      } else {
        this.setStatus(`You have the latest version (v${info.current})`);
        if (manual) toast(`Nexus is up to date (v${info.current})`);
      }
    } catch (e) {
      this.setStatus(String(e));
      if (manual) toast(String(e), 'err');
    }
  },
  firstLine(info) {
    return (info.notes || '').split('\n').map((l) => l.replace(/[#*`]/g, '').trim()).find((l) => l) || `You have v${info.current}`;
  },
  show(info) {
    $('#ub-title').textContent = `Nexus ${info.latest} is available`;
    $('#ub-sub').textContent = this.firstLine(info);
    $('#ub-progress').hidden = true;
    $('#ub-install .bp-label').textContent = 'INSTALL NOW';
    $('#ub-install').disabled = false;
    $('#ub-later').hidden = false;
    $('#ub-skip').hidden = false;
    $('#update-bar').hidden = false;
  },
  /** Downloaded and verified: installs by itself when Nexus closes, or right away with a restart. */
  showReady(info) {
    this.ready = true;
    $('#ub-title').textContent = `Nexus ${info.latest} is ready`;
    $('#ub-sub').textContent = 'Installs automatically when you close Nexus – or restart now.';
    $('#ub-progress').hidden = true;
    $('#ub-install .bp-label').textContent = 'RESTART NOW';
    $('#ub-install').disabled = false;
    $('#ub-later').hidden = false;
    $('#ub-skip').hidden = true;
    $('#update-bar').hidden = false;
    this.setStatus(`Version ${info.latest} is ready to install`);
  },
  hide() { $('#update-bar').hidden = true; },
  async install() {
    if (this.busy) return;
    this.busy = true;
    $('#ub-install').disabled = true;
    $('#ub-install .bp-label').textContent = this.ready ? 'RESTARTING…' : 'DOWNLOADING…';
    $('#ub-later').hidden = true;
    $('#ub-skip').hidden = true;
    $('#ub-progress').hidden = this.ready;
    try {
      await api.invoke('install_update');
      $('#ub-install .bp-label').textContent = 'RESTARTING…';
      $('#ub-progress').style.setProperty('--p', '100%');
    } catch (e) {
      this.busy = false;
      toast(String(e), 'err');
      if (this.info) this.show(this.info);
    }
  },
  init() {
    $('#ub-install').addEventListener('click', () => this.install());
    $('#ub-later').addEventListener('click', () => this.hide());
    $('#ub-skip').addEventListener('click', () => {
      if (this.info) { S.settings.skipVersion = this.info.latest; saveSettings(); }
      this.hide();
    });
    $('#upd-check').addEventListener('click', () => this.check(true));
    api.listen('update-available', (e) => {
      this.info = e.payload;
      this.setStatus(`Version ${e.payload.latest} is available`);
      // with automatic installation the bar appears once the download is ready
      if (S.settings.noAutoInstall && !this.busy && !this.ready) this.show(e.payload);
    });
    api.listen('update-ready', (e) => { this.info = e.payload; if (!this.busy) this.showReady(e.payload); });
    api.listen('update-error', (e) => this.setStatus(String(e.payload)));
    api.listen('update-progress', (e) => {
      if (!this.busy) return; // background downloads stay quiet
      const { done, total } = e.payload;
      $('#ub-progress').style.setProperty('--p', `${total ? Math.min(100, (done / total) * 100) : 0}%`);
      $('#ub-sub').textContent = total ? `${(done / 1e6).toFixed(1)} of ${(total / 1e6).toFixed(1)} MB` : `${(done / 1e6).toFixed(1)} MB`;
    });
    if (window.__TAURI__) {
      api.invoke('update_ready').then((v) => {
        if (v) this.showReady({ latest: v, notes: '', current: '' });
      }).catch(() => {});
    }
  },
};
/* ───────────────────────── memory: minimized or hidden ───────────────────────── */

document.addEventListener('visibilitychange', () => {
  const hidden = document.hidden;
  document.documentElement.classList.toggle('paused', hidden);
  if (window.__TAURI__) api.invoke('set_memory_mode', { low: hidden }).catch(() => {});
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
  await api.listen('genres-updated', () => onGenres());
  await api.listen('art-updated', (e) => onArtUpdated(e.payload));
  await api.listen('art-error', (e) => toast(String(e.payload), 'err'));
  await api.listen('hero-updated', (e) => { if (e.payload?.id === S.selected) applyHero(e.payload); });
  await api.listen('library-changed', async () => {
    loadedCovers.clear();
    await refresh(true);
    renderHero();
  });

  progress(34, 'Loading library');
  const b = await api.invoke('bootstrap', { artBase: T ? api.src('', 'art') : null });
  S.settings = { ...S.settings, ...b.settings };
  if (!S.settings.theme) S.settings.theme = 'neon';
  if (!S.settings.bgTone) S.settings.bgTone = 'black';
  applyTheme(S.settings);
  progress(66, 'Preparing games');
  Social.init();
  Updater.init();
  await refresh(true);
  renderHero();

  const hasLibrary = b.hasLibrary;
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
  // without a scan Rust starts genre lookups and cover downloads by itself
  if (!(hasLibrary && S.settings.skipStartupScan)) runScan(!hasLibrary);

  if (!S.settings.sgdbKey) {
    setTimeout(() => toast('Add a free SteamGridDB key to load cover art', '', { label: 'Open settings', fn: openSettings }), 3200);
  }
}
boot().catch((e) => { console.error(e); toast(`Startup error: ${e}`, 'err'); $('#splash').classList.add('out'); });
