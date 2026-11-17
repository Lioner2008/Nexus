'use strict';
/* Nexus mobile: the simple parts – chat and talking (voice rooms and 1:1 calls).
 * Talks to the same nexus-server as the desktop app (HTTP login + WebSocket + WebRTC audio). */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
const hue = (name) => { let h = 7; for (const c of String(name || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360; };
const avatar = (name, online) => `<div class="av" style="--h:${hue(name)}">${esc((name || '?')[0])}${online === undefined ? '' : `<i class="pd ${online ? 'on' : ''}"></i>`}</div>`;
const ICON = {
  mic: '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
  micOff: '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M3 3l18 18"/></svg>',
  phone: '<svg viewBox="0 0 24 24"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/></svg>',
  msg: '<svg viewBox="0 0 24 24"><path d="M4 5h16v11H9l-5 4z"/></svg>',
  cam: '<svg viewBox="0 0 24 24"><rect x="3" y="6" width="12" height="12" rx="2"/><path d="M15 10l6-3v10l-6-3"/></svg>',
  camOff: '<svg viewBox="0 0 24 24"><rect x="3" y="6" width="12" height="12" rx="2"/><path d="M15 10l6-3v10l-6-3M3 3l18 18"/></svg>',
};

const S = {
  base: store.get('server', ''), user: store.get('user', ''), token: store.get('token', ''),
  ws: null, ready: false, conn: 0, ice: [], rooms: [], dms: [], users: [], voiceRooms: {},
  msgs: new Map(), unread: new Map(), current: 'general', tab: 'chat', mode: 'login',
  retry: 0, wantOnline: false, inviteRequired: false, hb: 0, ring: null,
};
const V = { room: null, local: null, ctx: null, muted: false, peers: new Map(), stops: new Map(), wake: null, calling: null, cam: null, facing: 'user', tiles: new Map() };

const send = (o) => { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(o)); };
const normBase = (s) => {
  let v = (s || '').trim();
  if (!v) return '';
  if (!/^https?:\/\//i.test(v)) v = `http://${v}`;
  return v.replace(/\/+$/, '');
};
let toastT = 0;
function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = kind;
  t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => { t.hidden = true; }, 3200);
}
const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const roomById = (id) => S.rooms.find((r) => r.id === id) || S.dms.find((r) => r.id === id);
const presenceOf = (n) => S.users.find((u) => u.name.toLowerCase() === n.toLowerCase());

/* ───────────── login ───────────── */

async function checkServer() {
  const base = normBase($('#server').value);
  if (!base) return;
  try {
    const j = await (await fetch(`${base}/api/health`, { cache: 'no-store' })).json();
    S.inviteRequired = !!j.invite;
    if (j.users === 0 && S.mode === 'login' && !S.touched) setMode('register');
  } catch { S.inviteRequired = false; }
  updateInvite();
}
function updateInvite() { $('#invite-box').hidden = !(S.mode === 'register' && S.inviteRequired); }
function setMode(m) {
  S.mode = m;
  $$('#mode button').forEach((b) => b.classList.toggle('on', b.dataset.m === m));
  $('#go').textContent = m === 'login' ? 'LOG IN' : 'CREATE ACCOUNT';
  $('#err').textContent = '';
  updateInvite();
}

async function submit() {
  const base = normBase($('#server').value);
  const username = $('#user').value.trim();
  const password = $('#pass').value;
  const err = $('#err');
  err.textContent = '';
  if (!base) { err.textContent = 'Enter the server address'; return; }
  if (!username || !password) { err.textContent = 'Enter a username and a password'; return; }
  $('#go').disabled = true;
  try {
    const r = await fetch(`${base}/api/${S.mode}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password, invite: $('#invite').value.trim() || undefined }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { err.textContent = j.error || `Server answered ${r.status}`; return; }
    S.base = base; S.token = j.token; S.user = j.user;
    store.set('server', base); store.set('user', j.user); store.set('token', j.token);
    $('#pass').value = '';
    connect();
  } catch {
    err.textContent = `Could not reach ${base}. Is the address right and the server running?`;
  } finally { $('#go').disabled = false; }
}

function showLogin(msg) {
  $('#main').hidden = true;
  $('#login').hidden = false;
  $('#err').textContent = msg || '';
  $('#server').value = S.base;
  $('#user').value = S.user;
  checkServer();
}

async function logout() {
  S.wantOnline = false;
  if (V.room) endVoice();
  try { await fetch(`${S.base}/api/logout?token=${encodeURIComponent(S.token)}`, { method: 'POST' }); } catch { /* offline */ }
  closeWs();
  S.token = ''; S.ready = false;
  store.del('token');
  S.msgs.clear(); S.unread.clear();
  showLogin();
}

/* ───────────── websocket ───────────── */

function closeWs() {
  clearInterval(S.hb);
  const ws = S.ws;
  S.ws = null;
  if (ws) { ws.onclose = null; ws.onmessage = null; try { ws.close(); } catch { /* ignore */ } }
}

function connect() {
  closeWs();
  S.wantOnline = true;
  const ws = new WebSocket(`${S.base.replace(/^http/i, 'ws')}/ws?token=${encodeURIComponent(S.token)}`);
  S.ws = ws;
  ws.onopen = () => { S.retry = 0; S.hb = setInterval(() => send({ t: 'ping' }), 25000); };
  ws.onmessage = (e) => { try { handle(JSON.parse(e.data)); } catch (err) { console.error(err); } };
  ws.onclose = () => {
    if (S.ws !== ws) return;
    clearInterval(S.hb);
    S.ready = false;
    if (V.room) { endVoice(); toast('Connection lost – the call ended', 'err'); }
    if (S.wantOnline) retrySoon();
  };
}

async function retrySoon() {
  S.retry = Math.min(S.retry + 1, 8);
  setTimeout(async () => {
    if (!S.wantOnline || S.ready) return;
    try {
      const r = await fetch(`${S.base}/api/me?token=${encodeURIComponent(S.token)}`, { cache: 'no-store' });
      if (r.status === 401) { S.wantOnline = false; store.del('token'); S.token = ''; showLogin('Your session expired, please log in again'); return; }
      connect();
    } catch { retrySoon(); }
  }, Math.min(1000 * S.retry, 8000));
}

function handle(m) {
  switch (m.t) {
    case 'welcome':
      S.ready = true; S.user = m.you; S.conn = m.conn; S.ice = m.ice || [];
      S.rooms = m.rooms || []; S.dms = m.dms || [];
      if (!roomById(S.current)) S.current = (S.rooms.find((r) => r.kind === 'text') || {}).id || '';
      $('#login').hidden = true;
      $('#main').hidden = false;
      renderAll();
      break;
    case 'presence': S.users = m.users; renderPeople(); renderTalk(); renderMe(); renderRooms(); break;
    case 'rooms': S.rooms = m.rooms; renderRooms(); renderTalk(); break;
    case 'voice_rooms': S.voiceRooms = m.rooms || {}; renderTalk(); break;
    case 'dm_room':
      if (!S.dms.some((d) => d.id === m.room.id)) S.dms.push(m.room);
      renderRooms();
      if (S.pendingDm === m.room.with) { S.pendingDm = null; openRoom(m.room.id); setTab('chat'); }
      break;
    case 'history': S.msgs.set(m.room, m.msgs || []); if (m.room === S.current) renderMsgs(); break;
    case 'msg': onMessage(m.room, m.msg); break;
    case 'error': toast(m.msg, 'err'); break;
    case 'voice_members': for (const mem of m.members) makePeer(mem.conn, mem.user, mem); renderTalk(); break;
    case 'voice_joined': if (V.room === m.room) { makePeer(m.member.conn, m.member.user, m.member); beep('join'); } break;
    case 'voice_left': dropPeer(m.conn); beep('leave'); break;
    case 'voice_state': {
      const p = V.peers.get(m.member.conn);
      if (p) {
        p.muted = m.member.muted; p.video = !!m.member.video; p.screen = !!m.member.screen;
        if (!p.screen) p.watching = false;
        refreshDirections(p); renderTalk();
      }
      break;
    }
    case 'signal': onSignal(m); break;
    case 'call_started': joinVoice(m.room, true).then(() => { V.calling = { room: m.room, to: m.to }; toast(`Calling ${m.to}…`); }); break;
    case 'call_incoming': showRing(m); break;
    case 'call_declined': toast(`${m.by} declined the call`, 'err'); if (V.room === m.room && V.peers.size === 0) leaveVoice(); break;
    case 'call_cancelled': case 'call_handled': hideRing(m.room); break;
    default: break;
  }
}

/* ───────────── chat ───────────── */

const MENTION_RE = /(^|[^\w@/])@([A-Za-z0-9_-]{2,24})\b/g;
function linkify(text) {
  return esc(text).split(/(https?:\/\/[^\s<]+)/g).map((part, i) => {
    if (i % 2) return `<a href="${part}" target="_blank" rel="noopener">${part}</a>`;
    return part.replace(MENTION_RE, (m, pre, name) => {
      const low = name.toLowerCase();
      const known = ['everyone', 'here'].includes(low) || S.users.some((u) => u.name.toLowerCase() === low);
      if (!known) return m;
      const me = ['everyone', 'here'].includes(low) || low === (S.user || '').toLowerCase();
      return `${pre}<span class="mention ${me ? 'me' : ''}">@${name}</span>`;
    });
  }).join('');
}

function msgHTML(m, prev) {
  const mine = m.from === S.user;
  const cont = prev && prev.from === m.from && m.ts - prev.ts < 300000;
  return `<div class="msg ${mine ? 'me' : ''} ${cont ? 'cont' : ''}">${mine ? '' : avatar(m.from)}<div class="bub">${mine || cont ? '' : `<span class="who">${esc(m.from)}</span>`}${linkify(m.text)}<span class="when">${fmtTime(m.ts)}</span></div></div>`;
}

function renderMsgs() {
  const box = $('#msgs');
  const list = S.msgs.get(S.current) || [];
  box.innerHTML = list.length ? list.map((m, i) => msgHTML(m, list[i - 1])).join('') : '<div class="empty">No messages yet.<br>Write the first one.</div>';
  box.scrollTop = box.scrollHeight;
}

function onMessage(room, msg) {
  const list = S.msgs.get(room) || [];
  list.push(msg);
  if (list.length > 300) list.shift();
  S.msgs.set(room, list);
  const mine = msg.from === S.user;
  if (room === S.current && S.tab === 'chat' && !document.hidden) {
    const box = $('#msgs');
    box.querySelector('.empty')?.remove();
    const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 140 || mine;
    box.insertAdjacentHTML('beforeend', msgHTML(msg, list[list.length - 2]));
    if (stick) box.scrollTop = box.scrollHeight;
  } else if (!mine) {
    S.unread.set(room, (S.unread.get(room) || 0) + 1);
    renderRooms(); updateDot();
    navigator.vibrate?.(40);
    if (room.startsWith('dm:')) toast(`${msg.from}: ${msg.text.slice(0, 60)}`);
  }
}

function updateDot() {
  let n = 0;
  for (const v of S.unread.values()) n += v;
  $('#d-chat').classList.toggle('has', n > 0);
}

function renderRooms() {
  const chip = (id, label) => {
    const ub = S.unread.get(id);
    return `<button class="chip ${S.current === id ? 'on' : ''}" data-room="${esc(id)}">${esc(label)}${ub ? `<em>${ub}</em>` : ''}</button>`;
  };
  $('#rooms').innerHTML =
    S.rooms.filter((r) => r.kind === 'text').map((r) => chip(r.id, `# ${r.name}`)).join('') +
    S.dms.map((d) => chip(d.id, `@ ${d.with}`)).join('');
}

function openRoom(id) {
  S.current = id;
  S.unread.delete(id);
  updateDot(); renderRooms(); renderMsgs();
  const r = roomById(id);
  $('#input').placeholder = id.startsWith('dm:') ? `Message ${r?.with || ''}` : `Message #${r?.name || ''}`;
}

/* ───────────── people / talk lists ───────────── */

function renderMe() {
  $('#me-av').innerHTML = `${esc((S.user || '?')[0])}`;
  $('#me-av').style.setProperty('--h', hue(S.user));
  $('#me-name').textContent = S.user;
  $('#me-sub').textContent = `${S.users.filter((u) => u.online).length} online`;
}

function renderPeople() {
  const others = S.users.filter((u) => u.name.toLowerCase() !== (S.user || '').toLowerCase());
  $('#people').innerHTML = others.map((u) => `<div class="person ${u.online ? '' : 'off'}">${avatar(u.name, u.online)}<div class="nm"><b>${esc(u.name)}</b><small>${u.voice ? `In voice: ${esc(roomById(u.voice)?.name || 'call')}` : u.online ? 'online' : 'offline'}</small></div><div class="acts"><button data-dm="${esc(u.name)}" aria-label="Message">${ICON.msg}</button>${u.online ? `<button data-call="${esc(u.name)}" aria-label="Call">${ICON.phone}</button>` : ''}</div></div>`).join('')
    || '<div class="empty">Nobody else has an account on this server yet.</div>';
}

function renderTalk() {
  const box = $('#talk');
  const rooms = S.rooms.filter((r) => r.kind === 'voice');
  const callRoom = V.room && V.room.startsWith('call:') ? V.room : null;
  const member = (m, mine) => {
    const p = mine ? null : V.peers.get(m.conn);
    const vol = p ? Math.round((p.volume ?? 1) * 100) : 100;
    return `<div class="vmem ${mine ? 'me-m' : ''}" data-conn="${mine ? 'me' : m.conn}">${avatar(m.user)}<span class="nm">${esc(m.user)}${mine ? ' (you)' : ''}</span>${(mine ? V.muted : m.muted) ? ICON.micOff : ''}${p ? `<input type="range" min="0" max="100" value="${vol}" data-vol="${m.conn}" aria-label="Volume of ${esc(m.user)}">` : ''}</div>`;
  };
  const roomHTML = (id, name) => {
    const members = S.voiceRooms[id] || [];
    const inHere = V.room === id;
    return `<div class="vroom ${members.length ? 'occupied' : ''}"><div class="vhead"><b>${esc(name)}</b><button class="join ${inHere ? 'leave' : ''}" data-join="${esc(id)}">${inHere ? 'LEAVE' : 'JOIN'}</button></div>${members.map((m) => member(m, m.conn === S.conn)).join('')}</div>`;
  };
  box.innerHTML = `<div class="sec">Voice rooms</div>${rooms.map((r) => roomHTML(r.id, r.name)).join('') || '<div class="empty">No voice rooms yet.</div>'}${callRoom ? `<div class="sec">Call</div>${roomHTML(callRoom, 'Call')}` : ''}${V.room ? `<div class="bigctl"><button class="round big ${V.muted ? 'off' : ''}" data-mute aria-label="Mute">${V.muted ? ICON.micOff : ICON.mic}</button></div>` : ''}`;
  renderCallBar();
  renderStage();
}

function renderCallBar() {
  const bar = $('#call-bar');
  bar.hidden = !V.room;
  if (!V.room) return;
  const r = roomById(V.room);
  $('#call-name').textContent = V.room.startsWith('call:') ? 'In a call' : (r?.name || 'Voice');
  $('#cb-mute').innerHTML = V.muted ? ICON.micOff : ICON.mic;
  $('#cb-mute').classList.toggle('off', V.muted);
  $('#cb-cam').innerHTML = V.cam ? ICON.cam : ICON.camOff;
  $('#cb-cam').classList.toggle('on', !!V.cam);
  $('#cb-flip').hidden = !V.cam;
}

/* ───────────── video (camera of everyone, screens you choose to watch) ───────────── */

function videoTile(key, label, stream, opt = {}) {
  let t = V.tiles.get(key);
  if (!t) {
    t = document.createElement('div');
    t.innerHTML = '<video playsinline autoplay muted></video><span class="lbl"></span>';
    V.tiles.set(key, t);
  }
  t.className = `tile${opt.mirror ? ' mirror' : ''}${opt.screen ? ' screen' : ''}`;
  t.querySelector('.lbl').textContent = label;
  const v = t.querySelector('video');
  if (v.srcObject !== stream) { v.srcObject = stream; v.play().catch(() => {}); }
  let x = t.querySelector('.x');
  if (opt.stop && !x) { x = document.createElement('button'); x.className = 'x'; x.textContent = 'STOP'; x.dataset.unwatch = opt.stop; t.appendChild(x); }
  return t;
}

function watchTile(p) {
  const key = `${p.conn}:ph`;
  let t = V.tiles.get(key);
  if (!t) { t = document.createElement('div'); t.className = 'tile'; V.tiles.set(key, t); }
  t.innerHTML = `<div class="ph"><span>${esc(p.user)} shares their screen</span><button data-watch="${p.conn}">WATCH</button></div>`;
  return t;
}

function renderStage() {
  const st = $('#stage');
  if (!st) return;
  const want = [];
  if (V.room && V.cam) {
    if (!V.camStream || V.camStream.getVideoTracks()[0] !== V.cam) V.camStream = new MediaStream([V.cam]);
    want.push(videoTile('me', 'You', V.camStream, { mirror: V.facing === 'user' }));
  }
  for (const p of V.peers.values()) {
    if (p.video && p.camStream.getVideoTracks().length) want.push(videoTile(p.conn, p.user, p.camStream));
    if (p.screen) want.push(p.watching && p.screenStream.getVideoTracks().length ? videoTile(`${p.conn}:s`, `${p.user} · screen`, p.screenStream, { screen: true, stop: p.conn }) : watchTile(p));
  }
  for (const c of [...st.children]) if (!want.includes(c)) c.remove();
  for (const t of want) if (t.parentNode !== st) st.appendChild(t);
  st.className = want.length === 1 ? 'one' : '';
}

async function startCam() {
  if (!V.room || V.cam) return;
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: V.facing, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 } } });
    const track = s.getVideoTracks()[0];
    if (!V.room) { track.stop(); return; }
    V.cam = track;
    track.onended = () => { if (V.cam === track) stopCam(); };
    for (const p of V.peers.values()) { p.camTx.sender.replaceTrack(track).catch(() => {}); tuneVideo(p.camTx.sender); }
    send({ t: 'voice_state', video: true });
  } catch { toast('No camera access', 'err'); }
  renderCallBar(); renderStage();
}

function stopCam() {
  if (!V.cam) return;
  V.cam.stop(); V.cam = null;
  for (const p of V.peers.values()) p.camTx.sender.replaceTrack(null).catch(() => {});
  send({ t: 'voice_state', video: false });
  renderCallBar(); renderStage();
}

async function flipCam() {
  if (!V.cam) return;
  const next = V.facing === 'user' ? 'environment' : 'user';
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: next, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 } } });
    const track = s.getVideoTracks()[0];
    const old = V.cam;
    V.facing = next; V.cam = track;
    track.onended = () => { if (V.cam === track) stopCam(); };
    old.onended = null; old.stop();
    for (const p of V.peers.values()) p.camTx.sender.replaceTrack(track).catch(() => {});
    renderStage();
  } catch { toast('Could not switch the camera', 'err'); }
}

function renderAll() { renderMe(); renderRooms(); renderMsgs(); renderPeople(); renderTalk(); updateDot(); }

function setTab(tab) {
  S.tab = tab;
  $$('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  for (const t of ['chat', 'talk', 'people']) $(`#p-${t}`).hidden = t !== tab;
  if (tab === 'chat') { S.unread.delete(S.current); updateDot(); renderRooms(); renderMsgs(); }
}

/* ───────────── sounds ───────────── */

function getCtx() {
  if (!V.ctx) V.ctx = new (window.AudioContext || window.webkitAudioContext)();
  return V.ctx;
}
function tone(f, t0, dur, vol = 0.25, type = 'sine') {
  const c = getCtx();
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type; o.frequency.value = f;
  g.gain.setValueAtTime(0.0001, c.currentTime + t0);
  g.gain.exponentialRampToValueAtTime(vol, c.currentTime + t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + t0 + dur);
  o.connect(g); g.connect(c.destination);
  o.start(c.currentTime + t0); o.stop(c.currentTime + t0 + dur + 0.05);
}
function beep(kind) {
  try {
    if (kind === 'join') { tone(523, 0, 0.12); tone(784, 0.09, 0.14); }
    if (kind === 'leave') { tone(784, 0, 0.12); tone(392, 0.09, 0.14); }
  } catch { /* no audio */ }
}
let ringTimer = 0;
function startRing() { stopRing(); const r = () => { try { tone(660, 0, 0.18, 0.3); tone(880, 0.18, 0.22, 0.3); } catch { /* ignore */ } navigator.vibrate?.([300, 150, 300]); }; r(); ringTimer = setInterval(r, 1800); }
function stopRing() { clearInterval(ringTimer); ringTimer = 0; }

/* ───────────── voice (WebRTC mesh, audio only) ───────────── */

async function joinVoice(room, isCall = false) {
  if (!S.ready) { toast('Not connected to the server', 'err'); return; }
  if (V.room === room && !isCall) { leaveVoice(); return; }
  if (V.room) await leaveVoice();
  V.room = room;
  V.muted = false;
  try { getCtx().resume(); } catch { /* ignore */ }
  try {
    V.local = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    watchLevel('me', V.local.getAudioTracks()[0]);
  } catch {
    V.local = null;
    toast('No microphone access – you can only listen', 'err');
  }
  try { V.wake = await navigator.wakeLock?.request('screen'); } catch { V.wake = null; } // keep the screen on during a call
  send({ t: 'voice_join', room, video: false });
  beep('join');
  renderTalk();
}

async function leaveVoice() {
  send({ t: 'voice_leave' });
  beep('leave');
  endVoice();
}

function endVoice() {
  for (const p of V.peers.values()) closePeer(p);
  V.peers.clear();
  for (const stop of V.stops.values()) stop();
  V.stops.clear();
  V.local?.getTracks().forEach((t) => t.stop());
  V.cam?.stop();
  try { V.wake?.release(); } catch { /* ignore */ }
  Object.assign(V, { room: null, local: null, muted: false, wake: null, calling: null, cam: null });
  V.tiles.clear();
  renderTalk();
}

function closePeer(p) {
  try { p.pc.close(); } catch { /* ignore */ }
  if (p.audioEl) { p.audioEl.srcObject = null; p.audioEl.remove(); }
  for (const k of [p.conn, `${p.conn}:s`, `${p.conn}:ph`]) V.tiles.delete(k);
}
function dropPeer(conn) {
  const p = V.peers.get(conn);
  if (!p) return;
  closePeer(p);
  V.peers.delete(conn);
  V.stops.get(conn)?.();
  V.stops.delete(conn);
  renderTalk();
}

function makePeer(conn, user, state = {}) {
  if (V.peers.has(conn)) return V.peers.get(conn);
  const pc = new RTCPeerConnection({ iceServers: S.ice });
  const peer = {
    conn, user, pc, polite: S.conn < conn, makingOffer: false, ignoreOffer: false, stream: new MediaStream(), audioEl: document.createElement('audio'),
    muted: !!state.muted, volume: 1, video: !!state.video, screen: !!state.screen, watching: false,
    camStream: new MediaStream(), screenStream: new MediaStream(), videoTracks: new Map(), remoteMids: null, sentMids: '', camTx: null, screenTx: null,
  };
  peer.audioEl.autoplay = true;
  $('#audio').appendChild(peer.audioEl);
  // Same layout as the desktop app (audio, camera, screen) so both understand each other.
  const mic = V.local?.getAudioTracks()[0];
  if (mic) pc.addTrack(mic, V.local);
  else pc.addTransceiver('audio', { direction: 'sendrecv' }); // listen only; a microphone can't be added later on mobile
  peer.camTx = pc.addTransceiver('video', { direction: 'sendrecv' });
  peer.screenTx = pc.addTransceiver('video', { direction: 'inactive' }); // opens when someone shares and I watch
  if (V.cam) { peer.camTx.sender.replaceTrack(V.cam).catch(() => {}); tuneVideo(peer.camTx.sender); }
  refreshDirections(peer);
  pc.onicecandidate = (e) => { if (e.candidate) send({ t: 'signal', to: conn, data: { candidate: e.candidate } }); };
  pc.ontrack = () => syncTracks(peer);
  // "perfect negotiation": both sides may offer at the same time, the polite one backs off
  pc.onnegotiationneeded = async () => {
    try {
      peer.makingOffer = true;
      await pc.setLocalDescription();
      send({ t: 'signal', to: conn, data: { description: pc.localDescription } });
      announceMids(peer);
    } catch (e) { console.warn(e); } finally { peer.makingOffer = false; }
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') { try { pc.restartIce(); } catch { /* ignore */ } }
    if (pc.connectionState === 'connected') syncTracks(peer);
  };
  V.peers.set(conn, peer);
  renderTalk();
  return peer;
}

/* Each side creates its own video transceivers, so a camera/screen can arrive on any m-line:
 * everyone announces the "mid" of its camera and screen sender and the receiver routes by that. */
function announceMids(peer) {
  const cam = peer.camTx.mid, scr = peer.screenTx.mid;
  if (cam == null || scr == null) return;
  const key = `${cam},${scr}`;
  if (peer.sentMids === key) return;
  peer.sentMids = key;
  send({ t: 'signal', to: peer.conn, data: { mids: { cam: String(cam), screen: String(scr) } } });
}

/** After a "rollback" (both sides offered at once) a track from ontrack can be stale: always use what the receivers hold now. */
function syncTracks(peer) {
  if (!V.peers.has(peer.conn)) return;
  const audio = [], video = new Map();
  for (const t of peer.pc.getTransceivers()) {
    const tr = t.receiver?.track;
    if (!tr || t.mid == null || t.stopped) continue;
    if (tr.kind === 'audio') audio.push(tr); else video.set(t.mid, tr);
  }
  let changed = false;
  for (const old of peer.stream.getAudioTracks()) if (!audio.includes(old)) { peer.stream.removeTrack(old); changed = true; }
  for (const tr of audio) if (!peer.stream.getTracks().includes(tr)) { peer.stream.addTrack(tr); watchLevel(peer.conn, tr); changed = true; }
  if (changed || peer.audioEl.srcObject !== peer.stream) {
    peer.audioEl.srcObject = peer.stream;
    peer.audioEl.play().catch(() => { /* retried on the next tap */ });
  }
  peer.videoTracks = video;
  routeVideo(peer);
}

function routeVideo(peer) {
  const m = peer.remoteMids;
  if (!m) return;
  // the announced mids can change after a renegotiation: rebuild both streams from scratch so no stale (muted) track stays behind
  const want = { cam: new Set(), screen: new Set() };
  for (const [mid, track] of peer.videoTracks) {
    if (String(mid) === m.screen) want.screen.add(track);
    else if (String(mid) === m.cam) want.cam.add(track);
  }
  for (const [stream, set] of [[peer.camStream, want.cam], [peer.screenStream, want.screen]]) {
    for (const t of stream.getTracks()) if (!set.has(t)) stream.removeTrack(t);
    for (const t of set) if (!stream.getTracks().includes(t)) stream.addTrack(t);
  }
  renderStage();
}

/** My camera is always sent, the other person's camera always received, their screen only while I watch it. */
function refreshDirections(peer) {
  const m = peer.remoteMids;
  for (const t of peer.pc.getTransceivers()) {
    if (t.stopped || (t !== peer.camTx && t !== peer.screenTx && !(m && (String(t.mid) === m.cam || String(t.mid) === m.screen)))) continue;
    const remote = !!m && (String(t.mid) === m.cam || String(t.mid) === m.screen);
    const sendIt = t === peer.camTx;
    // my camera line is "sendrecv" from the very start, so it matches the other side's camera line (a lone "sendonly" line
    // makes both sides open extra lines, and after the resulting rollback Chrome can leave the voice track muted)
    const recvIt = t === peer.camTx || (remote && (String(t.mid) === m.cam || peer.watching));
    const dir = sendIt && recvIt ? 'sendrecv' : sendIt ? 'sendonly' : recvIt ? 'recvonly' : 'inactive';
    try { if (t.direction !== dir) t.direction = dir; } catch { /* closed */ }
  }
}

function tuneVideo(sender) { // phones: keep the picture small and the bitrate low
  try {
    const p = sender.getParameters();
    if (!p.encodings?.length) p.encodings = [{}];
    p.encodings[0].maxBitrate = 700000;
    sender.setParameters(p).catch(() => {});
  } catch { /* not supported */ }
}

async function onSignal(m) {
  if (!V.room) return;
  const peer = V.peers.get(m.from) || makePeer(m.from, m.user);
  const pc = peer.pc;
  const { description, candidate, mids } = m.data || {};
  if (mids) { peer.remoteMids = mids; routeVideo(peer); refreshDirections(peer); return; }
  try {
    if (description) {
      const collision = description.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
      peer.ignoreOffer = !peer.polite && collision;
      if (peer.ignoreOffer) return;
      await pc.setRemoteDescription(description);
      if (description.type === 'offer') {
        await pc.setLocalDescription();
        send({ t: 'signal', to: m.from, data: { description: pc.localDescription } });
      }
      announceMids(peer);
      refreshDirections(peer);
      syncTracks(peer);
    } else if (candidate) {
      try { await pc.addIceCandidate(candidate); } catch (e) { if (!peer.ignoreOffer) throw e; }
    }
  } catch (e) { console.warn('signal', e); }
}

function setMuted(on) {
  V.muted = on;
  V.local?.getAudioTracks().forEach((t) => { t.enabled = !on; });
  send({ t: 'voice_state', muted: on });
  renderTalk();
}

/** "Who is talking" ring around the avatar. */
function watchLevel(key, track) {
  V.stops.get(key)?.();
  try {
    const c = getCtx();
    const src = c.createMediaStreamSource(new MediaStream([track]));
    const an = c.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    const buf = new Uint8Array(an.fftSize);
    const id = setInterval(() => {
      an.getByteTimeDomainData(buf);
      let s = 0;
      for (const v of buf) { const d = (v - 128) / 128; s += d * d; }
      const on = Math.sqrt(s / buf.length) > 0.035 && !(key === 'me' && V.muted);
      $(`.vmem[data-conn="${key}"]`)?.classList.toggle('speaking', on);
    }, 140);
    V.stops.set(key, () => { clearInterval(id); try { src.disconnect(); } catch { /* ignore */ } });
  } catch { /* no level meter */ }
}

/* ───────────── calls (ringing) ───────────── */

function showRing(m) {
  S.ring = m;
  $('#ring-av').innerHTML = avatar(m.from);
  $('#ring-name').textContent = m.from;
  $('#ring').hidden = false;
  startRing();
}
function hideRing(room) {
  if (S.ring && (!room || S.ring.room === room)) { S.ring = null; $('#ring').hidden = true; stopRing(); }
}

/* ───────────── wiring ───────────── */

function init() {
  $('#server').value = S.base;
  $('#user').value = S.user;
  $('#mode').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { S.touched = true; setMode(b.dataset.m); } });
  $('#go').addEventListener('click', submit);
  $('#server').addEventListener('change', checkServer);
  for (const id of ['#user', '#pass']) $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  $('#btn-logout').addEventListener('click', logout);

  $('.tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setTab(b.dataset.tab); });
  $('#rooms').addEventListener('click', (e) => { const b = e.target.closest('[data-room]'); if (b) openRoom(b.dataset.room); });

  const input = $('#input');
  const fit = () => { input.style.height = 'auto'; input.style.height = `${Math.min(120, input.scrollHeight)}px`; };
  input.addEventListener('input', fit);
  $('#composer').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || !S.ready) return;
    send({ t: 'msg', room: S.current, text });
    input.value = ''; fit();
  });

  $('#people').addEventListener('click', (e) => {
    const dm = e.target.closest('[data-dm]');
    if (dm) {
      const name = dm.dataset.dm;
      const ex = S.dms.find((d) => d.with.toLowerCase() === name.toLowerCase());
      if (ex) { openRoom(ex.id); setTab('chat'); } else { S.pendingDm = name; send({ t: 'dm', to: name }); }
      return;
    }
    const call = e.target.closest('[data-call]');
    if (call) send({ t: 'call', to: call.dataset.call, video: false });
  });

  $('#talk').addEventListener('click', (e) => {
    const j = e.target.closest('[data-join]');
    if (j) { joinVoice(j.dataset.join); return; }
    if (e.target.closest('[data-mute]')) setMuted(!V.muted);
  });
  $('#talk').addEventListener('input', (e) => {
    const r = e.target.closest('[data-vol]');
    const p = r && V.peers.get(Number(r.dataset.vol));
    if (p) { p.volume = Number(r.value) / 100; p.audioEl.volume = p.volume; }
  });
  $('#cb-mute').addEventListener('click', () => setMuted(!V.muted));
  $('#cb-cam').addEventListener('click', () => (V.cam ? stopCam() : startCam()));
  $('#cb-flip').addEventListener('click', flipCam);
  $('#stage').addEventListener('click', (e) => {
    const w = e.target.closest('[data-watch]'), u = e.target.closest('[data-unwatch]');
    const p = V.peers.get(Number((w || u)?.dataset.watch ?? (w || u)?.dataset.unwatch));
    if (!p) return;
    p.watching = !!w;
    refreshDirections(p); renderStage();
  });
  $('#cb-leave').addEventListener('click', leaveVoice);

  $('#ring-yes').addEventListener('click', () => {
    const m = S.ring;
    if (!m) return;
    send({ t: 'call_accept', room: m.room });
    hideRing();
    setTab('talk');
    joinVoice(m.room, true);
  });
  $('#ring-no').addEventListener('click', () => { if (S.ring) send({ t: 'call_decline', room: S.ring.room }); hideRing(); });

  // browsers may block audio until the user touches the screen: retry then
  document.addEventListener('pointerdown', () => {
    try { V.ctx?.resume(); } catch { /* ignore */ }
    for (const p of V.peers.values()) if (p.audioEl.paused) p.audioEl.play().catch(() => {});
  }, { capture: true });
  // coming back to the app: reconnect if the connection was dropped while it slept
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && S.wantOnline && !S.ready) retrySoon();
    if (!document.hidden && S.ready && S.tab === 'chat' && S.current) { // show what arrived while the app was in the background
      S.unread.delete(S.current); renderMsgs(); renderRooms(); updateDot();
    }
    if (!document.hidden && V.room && !V.wake) navigator.wakeLock?.request('screen').then((w) => { V.wake = w; }).catch(() => {});
  });

  setMode('login');
  if (S.token && S.base) { S.wantOnline = true; retrySoon(); } else showLogin();
}

init();
