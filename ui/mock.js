'use strict';
/* ───────────────────────── browser mock (UI preview without Rust) ─────────────────────────
 * Only used when the page is opened in a normal browser (no Tauri). In the app every command
 * below is answered by Rust (src-tauri/src/library.rs and main.rs); this is a small stand-in
 * with demo games so the interface can be checked without building the app. */

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
  // many extra titles so the virtual grid can be checked with a big library (?many in the URL)
  const many = /[?&]many\b/.test(location.search);
  const base = many ? Array.from({ length: 600 }, (_, i) => demo[i % demo.length].slice()).map((d, i) => { d[0] = i < demo.length ? d[0] : `${d[0]} ${Math.floor(i / demo.length) + 1}`; return d; }) : demo;
  const games = base.map(([name, platform, inst], i) => ({
    id: `${platform}:${i}`, name, platform, installed: !!inst, installPath: `C:\\Games\\${name}`,
    installUri: 'x://i', sizeBytes: (8 + (i % 19) * 3) * 1e9, playtimeMin: inst ? (i % 19) * 95 : null,
  }));
  const genres = {};
  let scanned = false;
  let settings = { sgdbKey: '', steamKey: '', favorites: [], lastPlayed: {} };
  const pname = (p) => PLATFORMS[p]?.name || p;
  const hueOf = (name) => { let h = 7; for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360; };
  const lp = (g) => settings.lastPlayed[g.id] || 0;
  const byName = (x, y) => x.name.localeCompare(y.name);
  const sorters = {
    recent: (x, y) => (y.installed - x.installed) || (lp(y) - lp(x)) || byName(x, y),
    az: byName,
    played: (x, y) => ((y.playtimeMin || 0) - (x.playtimeMin || 0)) || (lp(y) - lp(x)) || byName(x, y),
    platform: (x, y) => x.platform.localeCompare(y.platform) || byName(x, y),
  };
  const lib = () => (scanned ? games : []);
  const filter = (q, skipGenre) => lib().filter((g) => {
    const fav = settings.favorites.includes(g.id);
    if (q.view === 'fav' && !fav) return false;
    if (q.view === 'recent' && !lp(g)) return false;
    if (q.platform && g.platform !== q.platform) return false;
    if (q.install === 'installed' && !g.installed) return false;
    if (q.install === 'missing' && g.installed) return false;
    if (q.q && !g.name.toLowerCase().includes(q.q.trim().toLowerCase())) return false;
    if (!skipGenre && q.genre !== 'ALL' && !(genres[g.id] || []).includes(q.genre)) return false;
    return true;
  });
  const card = (g, i) => {
    const genre = (genres[g.id] || [])[0];
    const meta = g.installed ? `<i class="dot"></i>${esc(pname(g.platform))}${genre ? ' · ' + esc(genre) : ''}` : `${esc(pname(g.platform))} · Not installed`;
    return `<article class="card${g.installed ? '' : ' missing'}" data-id="${esc(g.id)}" style="--i:${Math.min(i, 26)};--h:${hueOf(g.name)}"><div class="card-art"><div class="gen"><b>${esc(g.name)}</b><small>${esc(pname(g.platform))}</small></div><div class="glare"></div>${settings.favorites.includes(g.id) ? `<span class="fav-badge">${IC.heart}</span>` : ''}${g.installed ? '' : `<span class="dl-badge">${IC.download}</span>`}<button class="card-play" data-act="play" aria-label="${g.installed ? 'Play' : 'Install'}">${g.installed ? IC.play : IC.download}</button></div><div class="card-info"><b title="${esc(g.name)}">${esc(g.name)}</b><span>${meta}</span></div></article>`;
  };
  const view = (q) => {
    const counts = new Map();
    const pre = filter(q, true);
    for (const g of pre) for (const t of genres[g.id] || []) counts.set(t, (counts.get(t) || 0) + 1);
    const genre = q.genre !== 'ALL' && !counts.has(q.genre) ? 'ALL' : q.genre;
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 18);
    const chips = `<button class="chip${genre === 'ALL' ? ' on' : ''}" data-g="ALL">All<sup>${pre.length}</sup></button>` +
      top.map(([t, n]) => `<button class="chip${t === genre ? ' on' : ''}" data-g="${esc(t)}">${esc(t)}<sup>${n}</sup></button>`).join('');
    const list = filter({ ...q, genre }, false).sort(sorters[q.sort] || sorters.recent);
    const platforms = {};
    for (const g of lib()) platforms[g.platform] = (platforms[g.platform] || 0) + 1;
    return {
      ids: list.map((g) => g.id), cards: list.map(card), chips, genre,
      counts: { all: lib().length, fav: lib().filter((g) => settings.favorites.includes(g.id)).length, recent: lib().filter(lp).length,
        installed: lib().filter((g) => g.installed).length, platforms, covered: 0, tried: 0 },
    };
  };
  const hero = (id) => {
    let g = lib().find((x) => x.id === id);
    if (!g) g = [...lib()].sort(sorters.recent).find((x) => x.installed) || lib()[0];
    if (!g) return null;
    const pills = [`<span class="pill"><i style="--c:${PLATFORMS[g.platform]?.color || '#fff'}"></i>${esc(pname(g.platform))}</span>`];
    for (const t of (genres[g.id] || []).slice(0, 3)) pills.push(`<span class="pill">${esc(t)}</span>`);
    if (g.playtimeMin) pills.push(`<span class="pill">${g.playtimeMin < 60 ? `${g.playtimeMin}m` : `${(g.playtimeMin / 60).toFixed(g.playtimeMin < 600 ? 1 : 0)}h`} played</span>`);
    if (lp(g)) pills.push('<span class="pill">Last played today</span>');
    if (g.installed) pills.push(`<span class="pill">${(g.sizeBytes / 1e9).toFixed(1)} GB</span>`);
    return {
      id: g.id, name: g.name, installed: g.installed, statusHtml: `<i class="dot"></i>${g.installed ? 'Installed' : 'Not installed'}`,
      logo: null, metaHtml: pills.join(''), canPlay: true, fav: settings.favorites.includes(g.id), folder: g.installed,
      credit: '', bgKind: 'gen', bgUrl: null, hue: hueOf(g.name),
    };
  };
  return {
    src: (p) => p,
    win: { minimize() {}, toggleMaximize() {}, close() {} },
    listen: async (n, f) => { (subs[n] ||= []).push(f); return () => {}; },
    async invoke(cmd, args) {
      switch (cmd) {
        case 'bootstrap': return { settings, hasLibrary: false };
        case 'library_view': return view(args.query);
        case 'hero_view': return hero(args.id);
        case 'scan_library':
          for (const p of Object.keys(PLATFORMS)) {
            emit('scan-progress', { platform: p, state: 'running', count: 0 });
            await sleep(250);
            emit('scan-progress', { platform: p, state: 'done', count: games.filter((g) => g.platform === p).length });
          }
          scanned = true;
          games.slice(0, 40).forEach((g, i) => setTimeout(() => {
            genres[g.id] = base[i][3];
            emit('genres-updated', { id: g.id, genres: base[i][3] });
          }, 700 + i * 140));
          setTimeout(() => games.slice(40).forEach((g, i) => { genres[g.id] = base[i + 40][3]; }), 700);
          return games.length;
        case 'toggle_favorite': {
          const i = settings.favorites.indexOf(args.id);
          if (i >= 0) settings.favorites.splice(i, 1); else settings.favorites.push(args.id);
          return i < 0;
        }
        case 'save_settings': settings = { ...args.settings, favorites: settings.favorites, lastPlayed: settings.lastPlayed }; return settings;
        case 'play_game': {
          const g = games.find((x) => x.id === args.id);
          if (!g.installed) return { launched: false, ts: 0, minimize: false, message: `Opening ${pname(g.platform)} to install ${g.name}` };
          const ts = Math.floor(Date.now() / 1000);
          settings.lastPlayed[g.id] = ts;
          return { launched: true, ts, minimize: false, message: `Launching ${g.name}…` };
        }
        case 'art_current': return { url: null, custom: false };
        case 'test_sgdb_key': return 'Key works (mock)';
        case 'clear_art_cache': return 0;
        case 'app_version': return '0.0.0';
        case 'check_update': return { available: false, current: '0.0.0', latest: '0.0.0', notes: '' };
        case 'update_ready': return null;
        case 'server_status': return { running: true, address: '127.0.0.1:7777', hasBinary: true, internet: false };
        case 'list_art_options': return [];
        case 'set_art': case 'reset_art': return { cover: null, card: null, hero: hero(args.id), current: { url: null, custom: false } };
        default: return null;
      }
    },
  };
}
