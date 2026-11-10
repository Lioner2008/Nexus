'use strict';
/* ───────────────────────── Nexus Social ─────────────────────────
 * Chat rooms, direct messages, voice/video calls (WebRTC mesh), screen sharing and the
 * TeamSpeak 3 panel. Talks to the Nexus server (nexus-server) over HTTP + WebSocket.
 *
 * Loaded BEFORE app.js: nothing here touches the DOM or app.js globals ($, S, api, toast …)
 * at load time – everything happens inside Social.init() / the functions below.
 */
window.Social = (() => {
  const svg = (p) => `<svg viewBox="0 0 24 24">${p}</svg>`;
  const ICON = {
    mic: svg('<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>'),
    micOff: svg('<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M3 3l18 18"/>'),
    spk: svg('<path d="M3 14v-2a9 9 0 0 1 18 0v2"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/>'),
    spkOff: svg('<path d="M3 14v-2a9 9 0 0 1 18 0v2"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/><path d="M3 3l18 18"/>'),
    cam: svg('<rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3z"/>'),
    camOff: svg('<rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3zM3 3l18 18"/>'),
    screen: svg('<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>'),
    hangup: svg('<path d="M3 15c5-5 13-5 18 0l-2.2 2.6-3.3-1.6v-2.6c-2.2-.6-4.8-.6-7 0v2.6l-3.3 1.6z"/>'),
    phone: svg('<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/>'),
    msg: svg('<path d="M4 5h16v11H9l-5 4z"/>'),
    invite: svg('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M19 8v6M16 11h6"/>'),
    full: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
    eyeOff: svg('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM3 3l18 18"/>'),
    music: svg('<path d="M9 18V6l11-2v12"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>'),
    speaker: svg('<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/>'),
  };

  const st = {
    base: '', token: '', user: '', conn: 0, ws: null, ice: [], rooms: [], dms: [], users: [], voiceRooms: {},
    msgs: new Map(), unread: new Map(), current: 'general', typing: new Map(), ready: false, wantOnline: false,
    retry: 0, hb: 0, tab: 'people', mode: 'login', inited: false, lastTypingSent: 0, resuming: false,
    rings: new Map(), mentions: new Map(), ts: { on: false, ov: null, talk: new Set(), tried: false, refreshT: 0 },
  };
  const V = {
    room: null, local: null, camTrack: null, screen: null, mixTrack: null, ctx: null, muted: false, deaf: false,
    peers: new Map(), tiles: new Map(), stops: new Map(), calling: null, previewCam: null, previewScreen: null, mix: null, devIds: { mic: '', cam: '' },
  };

  /* ───────────── devices: microphone, headphones, camera ───────────── */

  const audioConstraints = (id) => ({ echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...(id ? { deviceId: { exact: id } } : {}) });
  const videoConstraints = (id) => ({ width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 }, ...(id ? { deviceId: { exact: id } } : {}) });

  /** Opens the chosen device; falls back to the system default if it was unplugged. */
  async function openDevice(kind, id) {
    const ask = (dev) => navigator.mediaDevices.getUserMedia(kind === 'audio' ? { audio: audioConstraints(dev) } : { video: videoConstraints(dev) });
    try { return await ask(id); } catch (e) {
      if (id && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError')) {
        toast(`Selected ${kind === 'audio' ? 'microphone' : 'camera'} not found – using the default`, 'err');
        return ask('');
      }
      throw e;
    }
  }
  const getMic = () => openDevice('audio', S.settings.micId || '');
  const getCam = () => openDevice('video', S.settings.camId || '');
  const applySink = (el) => { if (el && el.setSinkId) el.setSinkId(S.settings.speakerId || '').catch(() => {}); };

  const send = (o) => { if (st.ws && st.ws.readyState === 1) st.ws.send(JSON.stringify(o)); };
  const desktop = () => !!window.__TAURI__;
  const visible = () => $('#view-social').classList.contains('on');
  const normBase = (s) => {
    let v = (s || '').trim() || 'http://127.0.0.1:7777';
    if (!/^https?:\/\//i.test(v)) v = `http://${v}`;
    return v.replace(/\/+$/, '');
  };
  const avatar = (name, presence) =>
    `<div class="av" style="--h:${hue({ name })}">${esc((name || '?')[0])}${presence ? `<i class="pdot ${presence}"></i>` : ''}</div>`;
  const fmtTime = (ts) => {
    const d = new Date(ts);
    const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return d.toDateString() === new Date().toDateString() ? t : `${d.toLocaleDateString()} ${t}`;
  };
  const MENTION_RE = /(^|[^\w@/])@([A-Za-z0-9_-]{2,24})\b/g;
  const isMention = (name, me) => ['everyone', 'here'].includes(name.toLowerCase()) || name.toLowerCase() === (me || '').toLowerCase();
  const knownUser = (name) => ['everyone', 'here'].includes(name.toLowerCase()) || st.users.some((u) => u.name.toLowerCase() === name.toLowerCase());
  /** Does this message ping me? (@me, @everyone, @here) */
  const mentionsMe = (text) => {
    MENTION_RE.lastIndex = 0;
    let m;
    while ((m = MENTION_RE.exec(text))) if (isMention(m[2], st.user)) return true;
    return false;
  };
  const mentionify = (escaped) => escaped.replace(MENTION_RE, (m, pre, name) => (knownUser(name)
    ? `${pre}<span class="mention ${isMention(name, st.user) ? 'me' : ''}">@${name}</span>` : m));
  // links are left alone, only the text between them gets @mentions
  const linkify = (t) => esc(t).split(/(https?:\/\/[^\s<]+)/g).map((part, i) => (i % 2 ? `<a href="${part}" data-ext>${part}</a>` : mentionify(part))).join('');
  const roomById = (id) => st.rooms.find((r) => r.id === id) || st.dms.find((r) => r.id === id);
  const presenceOf = (name) => st.users.find((u) => u.name.toLowerCase() === name.toLowerCase());
  const saveSocial = () => {
    S.settings.socialServer = st.base;
    S.settings.socialUser = st.user;
    S.settings.socialToken = st.token;
    saveSettings();
  };

  /* ───────────── server + login ───────────── */

  async function checkServer() {
    const base = normBase($('#soc-server').value);
    const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost)(:|$)/i.test(base);
    let running = false;
    let label = 'Server not reachable';
    try {
      const j = await (await fetch(`${base}/api/health`, { cache: 'no-store' })).json();
      running = !!j.ok;
      st.inviteRequired = !!j.invite;
      label = `${j.name} · ${j.users} accounts · ${j.online} online`;
      // a brand-new server has no accounts yet: start on "Create account"
      if (j.users === 0 && !st.token && st.mode === 'login' && !st.modeTouched) setMode('register');
    } catch { /* offline */ }
    $('#soc-sdot').classList.toggle('on', running);
    $('#soc-sstat').textContent = label;
    updateInviteField();
    $('#soc-sstart').hidden = running || !isLocal || !desktop();
    $('#soc-sstop').hidden = !(running && isLocal && desktop());
    return running;
  }

  function updateInviteField() {
    $('#soc-invite-box').hidden = !(st.mode === 'register' && st.inviteRequired);
  }

  function setMode(m) {
    st.mode = m;
    $$('#soc-mode button').forEach((b) => b.classList.toggle('on', b.dataset.m === m));
    $('#soc-go .bp-label').textContent = m === 'login' ? 'LOG IN' : 'CREATE ACCOUNT';
    $('#soc-pass').autocomplete = m === 'login' ? 'current-password' : 'new-password';
    $('#soc-err').textContent = '';
    updateInviteField();
  }

  async function submitAuth() {
    const username = $('#soc-user').value.trim();
    const password = $('#soc-pass').value;
    const err = $('#soc-err');
    err.textContent = '';
    if (!username || !password) { err.textContent = 'Enter a username and a password'; return; }
    const base = normBase($('#soc-server').value);
    $('#soc-go').disabled = true;
    try {
      if (!(await checkServer()) && /^https?:\/\/(127\.0\.0\.1|localhost)(:|$)/i.test(base) && desktop()) {
        await api.invoke('start_local_server').catch(() => {});
        await checkServer();
      }
      const r = await fetch(`${base}/api/${st.mode}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password, invite: $('#soc-invite').value.trim() || undefined }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { err.textContent = j.error || `Server answered ${r.status}`; return; }
      st.base = base; st.token = j.token; st.user = j.user;
      $('#soc-pass').value = '';
      saveSocial();
      connectWs();
    } catch (e) {
      err.textContent = `Could not reach ${base}. Is the server running?`;
    } finally {
      $('#soc-go').disabled = false;
    }
  }

  function showLogin(msg) {
    $('#soc-login').hidden = false;
    $('#soc-app').hidden = true;
    $('#soc-err').textContent = msg || '';
    $('#soc-user').value = st.user || S.settings.socialUser || '';
    $('#soc-server').value = st.base || S.settings.socialServer || 'http://127.0.0.1:7777';
    checkServer();
    setTimeout(() => $(st.mode === 'register' || !$('#soc-user').value ? '#soc-user' : '#soc-pass').focus(), 120);
  }

  async function logout() {
    st.wantOnline = false;
    if (V.room) endVoiceLocal();
    try { await fetch(`${st.base}/api/logout?token=${encodeURIComponent(st.token)}`, { method: 'POST' }); } catch { /* ignore */ }
    closeWs();
    st.token = ''; st.ready = false;
    S.settings.socialToken = '';
    saveSettings();
    st.msgs.clear(); st.unread.clear(); updateBadge();
    showLogin();
  }

  /** Re-checks the remembered session and (re)connects the websocket. */
  async function resume() {
    if (st.resuming || !st.token) return;
    st.resuming = true;
    try {
      const r = await fetch(`${st.base}/api/me?token=${encodeURIComponent(st.token)}`, { cache: 'no-store' });
      if (r.status === 401) { st.token = ''; S.settings.socialToken = ''; saveSettings(); st.wantOnline = false; showLogin('Your session expired, please log in again'); return; }
      st.wantOnline = true;
      connectWs();
    } catch {
      // server not reachable (yet): try to start the local one, then retry
      if (desktop() && /127\.0\.0\.1|localhost/.test(st.base)) await api.invoke('start_local_server').catch(() => {});
      scheduleRetry();
    } finally { st.resuming = false; }
  }

  function scheduleRetry() {
    if (!st.wantOnline && !st.token) return;
    st.wantOnline = true;
    st.retry = Math.min(st.retry + 1, 8);
    showConn('Reconnecting…');
    setTimeout(() => { if (st.wantOnline && !st.ready) resume(); }, Math.min(1000 * st.retry, 8000));
  }

  function showConn(text) {
    let el = $('#soc-conn');
    if (!text) { el?.remove(); return; }
    if (!el) { el = document.createElement('div'); el.id = 'soc-conn'; el.className = 'soc-conn'; $('#view-social').appendChild(el); }
    el.textContent = text;
  }

  function closeWs() {
    clearInterval(st.hb);
    const ws = st.ws;
    st.ws = null;
    if (ws) { ws.onclose = null; ws.onmessage = null; try { ws.close(); } catch { /* ignore */ } }
  }

  function connectWs() {
    closeWs();
    st.wantOnline = true;
    const ws = new WebSocket(`${st.base.replace(/^http/i, 'ws')}/ws?token=${encodeURIComponent(st.token)}`);
    st.ws = ws;
    ws.onopen = () => { st.retry = 0; st.hb = setInterval(() => send({ t: 'ping' }), 25000); };
    ws.onmessage = (e) => { try { handle(JSON.parse(e.data)); } catch (err) { console.error(err); } };
    ws.onclose = () => {
      if (st.ws !== ws) return;
      clearInterval(st.hb);
      st.ready = false;
      if (V.room) endVoiceLocal('Connection lost – the call ended');
      if (st.wantOnline) scheduleRetry();
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  /* ───────────── server messages ───────────── */

  function handle(m) {
    switch (m.t) {
      case 'welcome':
        st.ready = true; st.user = m.you; st.conn = m.conn; st.ice = m.ice || [];
        st.rooms = m.rooms || []; st.dms = m.dms || [];
        if (!roomById(st.current)) st.current = (st.rooms.find((r) => r.kind === 'text') || {}).id || '';
        showConn('');
        $('#soc-login').hidden = true;
        $('#soc-app').hidden = false;
        saveSocial();
        renderAll();
        break;
      case 'presence': st.users = m.users; renderPeople(); renderDms(); renderMe(); break;
      case 'voice_rooms': st.voiceRooms = m.rooms || {}; renderVoiceList(); renderCall(); break;
      case 'rooms':
        st.rooms = m.rooms; renderRooms(); break;
      case 'dm_room':
        if (!st.dms.some((d) => d.id === m.room.id)) st.dms.push(m.room);
        renderDms();
        if (st.pendingDm === m.room.with) { st.pendingDm = null; openRoom(m.room.id); }
        break;
      case 'history':
        st.msgs.set(m.room, m.msgs || []);
        if (m.room === st.current) renderMsgs();
        break;
      case 'msg': onMessage(m.room, m.msg); break;
      case 'typing': onTyping(m.room, m.from); break;
      case 'error': toast(m.msg, 'err'); break;
      case 'voice_members': onVoiceMembers(m); break;
      case 'voice_joined': onVoiceJoined(m.member); break;
      case 'voice_left': onVoiceLeft(m.conn); break;
      case 'voice_state': onVoiceState(m.member); break;
      case 'signal': onSignal(m); break;
      case 'call_started': onCallStarted(m); break;
      case 'call_incoming': ring(m); break;
      case 'call_declined':
        toast(`${m.by} declined the call`, 'err');
        if (V.room === m.room && V.peers.size === 0) leaveVoice();
        break;
      case 'call_cancelled': case 'call_handled': dismissRing(m.room); break;
      default: break;
    }
  }

  function onMessage(room, msg) {
    const list = st.msgs.get(room) || [];
    list.push(msg);
    if (list.length > 500) list.shift();
    st.msgs.set(room, list);
    const mine = msg.from === st.user;
    if (room === st.current && visible()) {
      appendMsg(msg, list[list.length - 2]);
    } else if (!mine) {
      st.unread.set(room, (st.unread.get(room) || 0) + 1);
      if (mentionsMe(msg.text)) st.mentions.set(room, (st.mentions.get(room) || 0) + 1);
      updateBadge();
      renderRooms();
      renderDms();
      if (room.startsWith('dm:')) toast(`${msg.from}: ${msg.text.slice(0, 80)}`);
    }
    if (!mine && mentionsMe(msg.text) && (room !== st.current || !visible() || document.hidden)) {
      const r = roomById(room);
      const where = r && !room.startsWith('dm:') ? ` in #${r.name}` : '';
      toast(`${msg.from} mentioned you${where}: ${msg.text.slice(0, 70)}`);
      uiSound('mention');
    }
    st.typing.delete(`${room}|${msg.from}`);
    renderTyping();
  }

  function onTyping(room, from) {
    const key = `${room}|${from}`;
    clearTimeout(st.typing.get(key));
    st.typing.set(key, setTimeout(() => { st.typing.delete(key); renderTyping(); }, 3000));
    renderTyping();
  }

  /* ───────────── rendering: sidebar, chat, people ───────────── */

  function updateBadge() {
    let n = 0;
    for (const v of st.unread.values()) n += v;
    const b = $('#c-social');
    b.textContent = n > 99 ? '99+' : n;
    b.classList.toggle('has', n > 0);
  }

  function renderAll() {
    renderMe(); renderRooms(); renderDms(); renderPeople(); renderChatHeader(); renderMsgs(); renderCall(); updateBadge();
  }

  function renderMe() {
    $('#me-av').innerHTML = `${esc((st.user || '?')[0])}<i class="pdot online"></i>`;
    $('#me-av').style.setProperty('--h', hue({ name: st.user || '' }));
    $('#me-name').textContent = st.user;
    const on = st.users.filter((u) => u.online).length;
    $('#me-sub').textContent = `${on} online`;
  }

  function renderRooms() {
    $('#soc-text').innerHTML = st.rooms.filter((r) => r.kind === 'text').map((r) => {
      const ub = st.unread.get(r.id);
      const mn = st.mentions.get(r.id);
      return `<button class="soc-room ${st.current === r.id ? 'on' : ''}" data-room="${esc(r.id)}"><span class="ri">#</span><span class="rn">${esc(r.name)}</span>${ub ? `<span class="ub ${mn ? 'mention' : ''}">${mn ? '@' : ''}${ub}</span>` : ''}</button>`;
    }).join('');
    renderVoiceList();
  }

  function renderVoiceList() {
    $('#soc-voice').innerHTML = st.rooms.filter((r) => r.kind === 'voice').map((r) => {
      const members = st.voiceRooms[r.id] || [];
      const mine = V.room === r.id;
      const list = members.map((m) => `<div class="vm" data-conn="${m.conn}">${avatar(m.user)}<span>${esc(m.user)}</span>${m.muted || m.deaf ? ICON.micOff : ''}${m.video ? ICON.cam.replace('<svg', '<svg class="ok"') : ''}${m.screen ? ICON.screen.replace('<svg', '<svg class="ok"') : ''}</div>`).join('');
      return `<div><button class="soc-room ${mine ? 'on' : ''} ${members.length ? 'live' : ''}" data-voice="${esc(r.id)}"><span class="ri">${ICON.speaker.replace('<svg', '<svg style="width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:2"')}</span><span class="rn">${esc(r.name)}</span><span class="acts"><span class="mini" data-vvideo="${esc(r.id)}" title="Join with camera">${ICON.cam}</span></span></button>${list ? `<div class="vmembers">${list}</div>` : ''}</div>`;
    }).join('');
  }

  function renderDms() {
    const sorted = [...st.dms].sort((a, b) => Number(!!presenceOf(b.with)?.online) - Number(!!presenceOf(a.with)?.online) || a.with.localeCompare(b.with));
    $('#soc-dms').innerHTML = sorted.map((d) => {
      const p = presenceOf(d.with);
      const ub = st.unread.get(d.id);
      const mn = st.mentions.get(d.id);
      return `<button class="soc-room ${st.current === d.id ? 'on' : ''}" data-room="${esc(d.id)}">${avatar(d.with, p?.online ? p.status : '')}<span class="rn">${esc(d.with)}</span>${ub ? `<span class="ub ${mn ? 'mention' : ''}">${mn ? '@' : ''}${ub}</span>` : ''}<span class="acts"><span class="mini" data-call="${esc(d.with)}" title="Call">${ICON.phone}</span><span class="mini" data-call="${esc(d.with)}" data-video="1" title="Video call">${ICON.cam}</span></span></button>`;
    }).join('') || '<div style="padding:6px 8px;color:var(--dim);font-size:12px">Use the People tab to start a conversation.</div>';
  }

  function renderPeople() {
    const inCall = !!V.room;
    $('#pane-people').innerHTML = st.users.filter((u) => u.name.toLowerCase() !== (st.user || '').toLowerCase()).map((u) => {
      const sub = u.voice ? `In voice: ${esc(roomById(u.voice)?.name || 'call')}` : u.online ? esc(u.status) : 'offline';
      return `<div class="person ${u.online ? '' : 'off'}">${avatar(u.name, u.online ? u.status : '')}<div class="grow"><b>${esc(u.name)}</b><small>${sub}</small></div><span class="acts">
        <span class="mini" data-dm="${esc(u.name)}" title="Message">${ICON.msg}</span>
        <span class="mini at" data-mention="${esc(u.name)}" title="Mention in the chat">@</span>
        ${u.online ? (inCall
    ? `<span class="mini" data-invite="${esc(u.name)}" title="Invite to your call">${ICON.invite}</span>`
    : `<span class="mini" data-call="${esc(u.name)}" title="Call">${ICON.phone}</span><span class="mini" data-call="${esc(u.name)}" data-video="1" title="Video call">${ICON.cam}</span>`) : ''}
      </span></div>`;
    }).join('') || '<div style="padding:10px;color:var(--dim);font-size:12.5px">Nobody else has an account on this server yet.</div>';
  }

  function renderChatHeader() {
    const r = roomById(st.current);
    const dm = st.current.startsWith('dm:');
    $('#chat-title').textContent = dm ? `@ ${r?.with || ''}` : `# ${r?.name || ''}`;
    $('#chat-topic').textContent = r?.topic || '';
    $('#chat-input').placeholder = dm ? `Message ${r?.with || ''}` : `Message #${r?.name || ''}`;
  }

  const msgHTML = (m, prev, isNew) => {
    const cont = prev && prev.from === m.from && m.ts - prev.ts < 300000;
    return `<div class="msg ${cont ? 'cont' : ''} ${isNew ? 'new' : ''}">${avatar(m.from)}<div><div class="mh">${cont ? '' : `<b class="${m.from === st.user ? 'me' : ''}">${esc(m.from)}</b><time>${fmtTime(m.ts)}</time>`}</div><div class="mt">${linkify(m.text)}</div></div></div>`;
  };

  function renderMsgs() {
    const box = $('#msgs');
    const list = st.msgs.get(st.current) || [];
    box.innerHTML = list.length
      ? list.map((m, i) => msgHTML(m, list[i - 1], false)).join('')
      : '<div class="msg-empty">No messages yet.<br>Write the first one.</div>';
    box.scrollTop = box.scrollHeight;
    renderTyping();
  }

  function appendMsg(m, prev) {
    const box = $('#msgs');
    box.querySelector('.msg-empty')?.remove();
    const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 120 || m.from === st.user;
    box.insertAdjacentHTML('beforeend', msgHTML(m, prev, true));
    if (stick) box.scrollTop = box.scrollHeight;
  }

  function renderTyping() {
    const who = [...st.typing.keys()].filter((k) => k.startsWith(`${st.current}|`)).map((k) => k.split('|').slice(1).join('|'));
    $('#typing').textContent = who.length ? `${who.join(', ')} ${who.length > 1 ? 'are' : 'is'} typing…` : '';
  }

  function openRoom(id) {
    st.current = id;
    st.unread.delete(id);
    st.mentions.delete(id);
    updateBadge();
    renderRooms(); renderDms(); renderChatHeader(); renderMsgs();
    $('#chat-input').focus();
  }

  function startDm(name) {
    const ex = st.dms.find((d) => d.with.toLowerCase() === name.toLowerCase());
    if (ex) { openRoom(ex.id); return; }
    st.pendingDm = name;
    send({ t: 'dm', to: name });
  }

  /* ───────────── voice & video (WebRTC mesh; the server only relays signaling) ───────────── */

  const getCtx = () => {
    if (!V.ctx) {
      V.ctx = new AudioContext();
      try { V.ctx.setSinkId?.(S.settings.speakerId || ''); } catch { /* default output */ }
    }
    return V.ctx;
  };
  const camTrack = () => V.camTrack || null;
  const screenTrack = () => V.screen?.getVideoTracks()[0] || null;
  const micTrack = () => V.mix?.track || V.local?.getAudioTracks()[0] || null;

  function tune(sender, screen) {
    if (!sender?.getParameters) return;
    try {
      const p = sender.getParameters();
      if (!p.encodings || !p.encodings.length) p.encodings = [{}];
      p.encodings[0].maxBitrate = screen ? 4_000_000 : 1_500_000;
      sender.setParameters(p).catch(() => {});
    } catch { /* not supported */ }
  }

  function sendState() {
    send({ t: 'voice_state', muted: V.muted, deaf: V.deaf, video: !!camTrack(), screen: !!V.screen });
  }

  /* ── sounds: call events, ringing, sound effects ── */

  /** Short synthesized tone (no audio files needed). */
  function tone(c, out, t, o) {
    const { type = 'sine', f = 440, to = null, dur = 0.3, vol = 0.3, attack = 0.01, vib = 0 } = o;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f, t);
    if (to) osc.frequency.exponentialRampToValueAtTime(to, t + dur);
    if (vib) {
      const l = c.createOscillator();
      const lg = c.createGain();
      l.frequency.value = vib; lg.gain.value = f * 0.025;
      l.connect(lg); lg.connect(osc.frequency); l.start(t); l.stop(t + dur + 0.05);
    }
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g); g.connect(out);
    osc.start(t); osc.stop(t + dur + 0.05);
  }
  function noise(c, out, t, o) {
    const { dur = 0.2, vol = 0.3, hp = 0, bp = 0 } = o;
    const buf = c.createBuffer(1, Math.max(1, Math.floor(c.sampleRate * dur)), c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const s = c.createBufferSource();
    s.buffer = buf;
    let node = s;
    if (hp) { const f = c.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = hp; node.connect(f); node = f; }
    if (bp) { const f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = bp; f.Q.value = 0.8; node.connect(f); node = f; }
    const g = c.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    node.connect(g); g.connect(out);
    s.start(t);
  }

  const SFX = [
    { id: 'airhorn', name: 'Airhorn', play: (c, o, t) => { [466, 622, 740].forEach((f) => tone(c, o, t, { type: 'sawtooth', f, to: f * 0.96, dur: 1.2, vol: 0.16, vib: 7 })); } },
    { id: 'trombone', name: 'Sad trombone', play: (c, o, t) => { [[233, 0], [220, 0.5], [208, 1.0]].forEach(([f, d]) => tone(c, o, t + d, { type: 'sawtooth', f, dur: 0.45, vol: 0.2 })); tone(c, o, t + 1.5, { type: 'sawtooth', f: 196, to: 120, dur: 1.1, vol: 0.22, vib: 6 }); } },
    { id: 'rimshot', name: 'Ba-dum-tss', play: (c, o, t) => { tone(c, o, t, { f: 160, to: 50, dur: 0.15, vol: 0.6 }); tone(c, o, t + 0.2, { f: 160, to: 50, dur: 0.15, vol: 0.6 }); noise(c, o, t + 0.4, { dur: 0.7, vol: 0.4, hp: 5000 }); } },
    { id: 'applause', name: 'Applause', play: (c, o, t) => { for (let i = 0; i < 70; i++) noise(c, o, t + Math.random() * 2.2, { dur: 0.06, vol: 0.12 + Math.random() * 0.1, bp: 1500 + Math.random() * 2500 }); } },
    { id: 'laser', name: 'Laser', play: (c, o, t) => { tone(c, o, t, { type: 'square', f: 1600, to: 120, dur: 0.35, vol: 0.2 }); } },
    { id: 'coin', name: 'Coin', play: (c, o, t) => { tone(c, o, t, { type: 'square', f: 988, dur: 0.09, vol: 0.16 }); tone(c, o, t + 0.09, { type: 'square', f: 1319, dur: 0.45, vol: 0.16 }); } },
    { id: 'buzzer', name: 'Wrong buzzer', play: (c, o, t) => { tone(c, o, t, { type: 'square', f: 110, dur: 0.7, vol: 0.22 }); tone(c, o, t, { type: 'sawtooth', f: 113, dur: 0.7, vol: 0.18 }); } },
    { id: 'ding', name: 'Ding', play: (c, o, t) => { [[880, 0.35], [1760, 0.18], [2640, 0.1]].forEach(([f, v]) => tone(c, o, t, { f, dur: 1.4, vol: v, attack: 0.005 })); } },
    { id: 'drumroll', name: 'Drum roll', play: (c, o, t) => { for (let i = 0; i < 50; i++) noise(c, o, t + i * 0.03, { dur: 0.05, vol: 0.08 + (i / 50) * 0.3, bp: 400 }); noise(c, o, t + 1.55, { dur: 1.0, vol: 0.45, hp: 3000 }); tone(c, o, t + 1.55, { f: 120, to: 45, dur: 0.4, vol: 0.5 }); } },
    { id: 'boing', name: 'Boing', play: (c, o, t) => { tone(c, o, t, { f: 180, to: 760, dur: 0.55, vol: 0.3, vib: 14 }); } },
  ];

  /** Quiet UI sounds (only you hear them): someone joins/leaves, mute, mention… */
  function uiSound(kind) {
    if (S.settings.noCallSounds) return;
    try {
      const c = getCtx();
      if (c.state === 'suspended') c.resume();
      const out = c.createGain();
      out.gain.value = 0.35;
      out.connect(c.destination);
      const t = c.currentTime + 0.01;
      const blip = (f, d, o = {}) => tone(c, out, t + d, { f, dur: 0.14, vol: 0.4, attack: 0.004, ...o });
      switch (kind) {
        case 'join': blip(523, 0); blip(784, 0.09); break;
        case 'leave': blip(784, 0); blip(392, 0.09); break;
        case 'selfJoin': blip(523, 0); blip(659, 0.09); blip(784, 0.18); break;
        case 'selfLeave': blip(784, 0); blip(659, 0.09); blip(523, 0.18); break;
        case 'mute': blip(300, 0, { dur: 0.09 }); break;
        case 'unmute': blip(600, 0, { dur: 0.09 }); break;
        case 'mention': blip(988, 0); blip(1319, 0.1); break;
        default: break;
      }
      setTimeout(() => out.disconnect(), 1500);
    } catch { /* no audio */ }
  }

  let toneTimer = 0;
  function startTone(pattern = 'ring') {
    stopTone();
    const beep = () => {
      try {
        const c = getCtx();
        const out = c.createGain();
        out.gain.value = 0.6;
        out.connect(c.destination);
        const t = c.currentTime;
        if (pattern === 'ring') { tone(c, out, t, { f: 660, dur: 0.18, vol: 0.2 }); tone(c, out, t + 0.18, { f: 880, dur: 0.22, vol: 0.2 }); } else { tone(c, out, t, { f: 440, dur: 0.9, vol: 0.12, attack: 0.05 }); tone(c, out, t, { f: 480, dur: 0.9, vol: 0.12, attack: 0.05 }); }
        setTimeout(() => out.disconnect(), 1500);
      } catch { /* silent */ }
    };
    beep();
    toneTimer = setInterval(beep, pattern === 'ring' ? 1600 : 3000);
  }
  function stopTone() { clearInterval(toneTimer); toneTimer = 0; }

  /** Plays a sound effect for you and, inside a call, for everybody in it. */
  const sfxBuffers = new Map();
  async function playSfx(item) {
    try {
      const c = getCtx();
      await c.resume();
      const out = c.createGain();
      out.gain.value = S.settings.sfxVolume ?? 0.8;
      if (!V.deaf) out.connect(c.destination); // you hear it too
      if (V.room) out.connect(ensureMixer().dest); // everyone in the call hears it
      const t = c.currentTime + 0.02;
      if (item.play) item.play(c, out, t);
      else {
        let buf = sfxBuffers.get(item.path);
        if (!buf) {
          const data = await (await fetch(api.src(item.path))).arrayBuffer();
          buf = await c.decodeAudioData(data);
          sfxBuffers.set(item.path, buf);
        }
        const s = c.createBufferSource();
        s.buffer = buf;
        s.connect(out);
        s.start(t);
      }
      setTimeout(() => out.disconnect(), 12000);
    } catch (e) { toast(`Could not play the sound: ${e.message || e}`, 'err'); }
  }

  function renderSfx() {
    const custom = S.settings.sounds || [];
    $('#sfx-panel').innerHTML = `
      <div class="sfx-head"><b>Sound effects</b><label class="sfx-vol" title="Volume">${ICON.spk}<input type="range" id="sfx-vol" min="0" max="100" value="${Math.round((S.settings.sfxVolume ?? 0.8) * 100)}"></label></div>
      <div class="sfx-grid">
        ${SFX.map((s) => `<button class="sfx-btn" data-sfx="${s.id}">${esc(s.name)}</button>`).join('')}
        ${custom.map((s, i) => `<button class="sfx-btn custom" data-sfxc="${i}" title="Right-click to remove">${esc(s.name)}</button>`).join('')}
        <button class="sfx-btn add" data-sfx-add>+ Add sound</button>
      </div>
      <small>Everyone in the call hears these. Right-click your own sounds to remove them.</small>`;
  }

  async function addSound() {
    try {
      const dlg = window.__TAURI__?.dialog;
      if (!dlg) { toast('Adding sounds works in the desktop app', 'err'); return; }
      const picked = await dlg.open({ multiple: false, filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'flac'] }] });
      const path = Array.isArray(picked) ? picked[0] : picked;
      if (!path) return;
      const s = await api.invoke('import_sound', { path });
      (S.settings.sounds ||= []).push(s);
      saveSettings();
      renderSfx();
      toast(`Added "${s.name}"`);
    } catch (e) { toast(String(e), 'err'); }
  }

  /* ── mixer: microphone + sound effects + shared system sound → one track for the others ── */

  function ensureMixer() {
    if (V.mix) return V.mix;
    const c = getCtx();
    const dest = c.createMediaStreamDestination();
    const mic = V.local?.getAudioTracks()[0];
    const micSrc = mic ? c.createMediaStreamSource(new MediaStream([mic])) : null;
    micSrc?.connect(dest);
    const mix = { dest, track: dest.stream.getAudioTracks()[0], micSrc, screenSrc: null };
    V.mix = mix;
    for (const p of V.peers.values()) p.audioSender?.replaceTrack(mix.track).catch(() => {});
    return mix;
  }

  /** A new microphone track (retry / device change). */
  function setMicTrack(nt) {
    nt.enabled = !(V.muted || V.deaf);
    if (V.mix) {
      try { V.mix.micSrc?.disconnect(); } catch { /* ignore */ }
      V.mix.micSrc = getCtx().createMediaStreamSource(new MediaStream([nt]));
      V.mix.micSrc.connect(V.mix.dest);
    } else {
      for (const p of V.peers.values()) p.audioSender?.replaceTrack(nt).catch(() => {});
    }
    watchSpeaking('me', nt);
  }

  /* ── join / leave ── */

  async function joinVoice(room, video = false) {
    if (!st.ready) { toast('Not connected to the server', 'err'); return; }
    if (V.room === room && !video) { leaveVoice(); return; }
    if (V.room) await leaveVoice();
    V.room = room;
    V.muted = false; V.deaf = false;
    V.previewCam = new MediaStream();
    V.previewScreen = new MediaStream();
    try { getCtx().resume(); } catch { /* audio analysis optional */ }
    try {
      V.local = await getMic();
      V.devIds.mic = S.settings.micId || '';
      const t = V.local.getAudioTracks()[0];
      if (t) watchSpeaking('me', t);
    } catch (e) {
      V.local = null;
      toast('No microphone available – you can listen but not talk', 'err');
    }
    if (video) await startCamera(true);
    renderCall(); renderVoiceList(); renderPeople(); renderSfx();
    send({ t: 'voice_join', room, video: !!camTrack() });
    uiSound('selfJoin');
  }

  async function leaveVoice() {
    send({ t: 'voice_leave' });
    uiSound('selfLeave');
    endVoiceLocal();
  }

  function endVoiceLocal(msg) {
    for (const p of V.peers.values()) closePeer(p);
    V.peers.clear();
    for (const stop of V.stops.values()) stop();
    V.stops.clear();
    V.local?.getTracks().forEach((t) => t.stop());
    V.camTrack?.stop();
    V.screen?.getTracks().forEach((t) => t.stop());
    try { V.mix?.micSrc?.disconnect(); V.mix?.screenSrc?.disconnect(); } catch { /* ignore */ }
    V.mix?.track.stop();
    stopTone();
    if (V.calling) { clearTimeout(V.calling.timer); V.calling = null; }
    Object.assign(V, { room: null, local: null, camTrack: null, screen: null, mix: null, muted: false, deaf: false, previewCam: null, previewScreen: null });
    $('#vgrid').innerHTML = '';
    $('#sfx-panel').hidden = true;
    V.tiles.clear();
    renderCall(); renderVoiceList(); renderPeople();
    if (msg) toast(msg, 'err');
  }

  function closePeer(p) {
    try { p.pc.close(); } catch { /* ignore */ }
    try { p.gain?.disconnect(); p.gainSrc?.disconnect(); } catch { /* ignore */ }
    if (p.audioEl) { p.audioEl.srcObject = null; p.audioEl.remove(); }
  }

  /* ── per person volume (0–200 %), remembered by name ── */

  const getVol = (name) => S.settings.peerVolumes?.[name] ?? 1;

  function applyPeerVolume(peer) {
    const el = peer.audioEl;
    if (!el) return;
    const v = getVol(peer.user);
    if (v > 1 && peer.audioStream.getAudioTracks().length) {
      // boost above 100 %: through a gain node; the element stays muted so nothing plays twice
      try {
        const c = getCtx();
        if (!peer.gain) {
          peer.gainSrc = c.createMediaStreamSource(peer.audioStream);
          peer.gain = c.createGain();
          peer.gainSrc.connect(peer.gain);
          peer.gain.connect(c.destination);
        }
        peer.gain.gain.value = V.deaf ? 0 : v;
        el.muted = true;
        return;
      } catch { /* fall back to the element */ }
    }
    if (peer.gain) {
      try { peer.gain.disconnect(); peer.gainSrc.disconnect(); } catch { /* ignore */ }
      peer.gain = null; peer.gainSrc = null;
    }
    el.volume = Math.min(1, v);
    el.muted = V.deaf;
  }

  /** Voice is played by a dedicated <audio> element, independent of the (possibly hidden) video tiles. */
  function playPeerAudio(peer) {
    const el = peer.audioEl;
    if (!el || !peer.audioStream.getAudioTracks().length) return;
    if (el.srcObject !== peer.audioStream) el.srcObject = peer.audioStream;
    applySink(el);
    applyPeerVolume(peer);
    el.play().catch(() => { /* blocked until the next click, see resumeAudio() */ });
  }

  /** Browsers may block audio until the user interacts: retry on every click. */
  function resumeAudio() {
    try { V.ctx?.resume(); } catch { /* ignore */ }
    for (const p of V.peers.values()) if (p.audioEl?.paused) playPeerAudio(p);
  }

  /* ── peers ── */

  /**
   * Each side creates its own video transceivers, so a person's camera/screen can arrive on any m-line.
   * Everyone therefore announces the "mid" of its camera and screen sender over the signaling channel;
   * the receiver routes incoming video tracks by that mid.
   */
  function announceMids(peer) { // eslint-disable-line no-use-before-define
    const cam = peer.camTx.mid;
    const scr = peer.screenTx.mid;
    if (cam == null || scr == null) return;
    const key = `${cam},${scr}`;
    if (peer.sentMids === key) return;
    peer.sentMids = key;
    send({ t: 'signal', to: peer.conn, data: { mids: { cam: String(cam), screen: String(scr) } } });
  }

  /** Puts incoming video tracks into the camera / screen stream of that person and shows them in the tiles. */
  function routeVideo(peer) {
    const m = peer.remoteMids;
    if (!m) return;
    for (const [mid, track] of peer.videoTracks) {
      const target = String(mid) === m.screen ? peer.screenStream : String(mid) === m.cam ? peer.camStream : null;
      if (!target) continue;
      const other = target === peer.screenStream ? peer.camStream : peer.screenStream;
      if (other.getTracks().includes(track)) other.removeTrack(track);
      if (!target.getTracks().includes(track)) target.addTrack(track);
    }
    for (const [key, stream] of [[peer.conn, peer.camStream], [`${peer.conn}:s`, peer.screenStream]]) {
      const v = V.tiles.get(key)?.querySelector('video');
      if (v) { v.srcObject = stream; v.play().catch(() => {}); }
    }
  }

  /**
   * Direction of every video m-line: my camera is always sent, my screen only while I share,
   * the other person's camera is always received, their screen only while I watch it.
   * (Nothing is transmitted for a screen nobody watches.)
   */
  function refreshDirections(peer) {
    const m = peer.remoteMids;
    for (const t of peer.pc.getTransceivers()) {
      if (t === peer.audioTx || t.stopped) continue;
      const mine = t === peer.camTx || t === peer.screenTx;
      const remote = !!m && (String(t.mid) === m.cam || String(t.mid) === m.screen);
      if (!mine && !remote) continue; // role not known yet: leave the default
      const send = (t === peer.camTx) || (t === peer.screenTx && !!V.screen);
      const recv = remote && (String(t.mid) === m.cam || peer.watching);
      const dir = send && recv ? 'sendrecv' : send ? 'sendonly' : recv ? 'recvonly' : 'inactive';
      try { if (t.direction !== dir) t.direction = dir; } catch { /* closed */ }
    }
  }

  function makePeer(conn, user, state = {}) {
    if (V.peers.has(conn)) return V.peers.get(conn);
    const pc = new RTCPeerConnection({ iceServers: st.ice });
    const peer = {
      conn, user, pc, polite: st.conn < conn, makingOffer: false, ignoreOffer: false,
      audioStream: new MediaStream(), camStream: new MediaStream(), screenStream: new MediaStream(), audioEl: document.createElement('audio'),
      audioSender: null, camSender: null, screenSender: null, audioTx: null, camTx: null, screenTx: null, gain: null, gainSrc: null,
      watching: !S.settings.noAutoWatch, videoTracks: new Map(), remoteMids: null, sentMids: '',
      state: { video: false, screen: false, muted: false, deaf: false, ...state },
    };
    peer.audioEl.autoplay = true;
    $('#soc-audio').appendChild(peer.audioEl);
    // the order of the transceivers is the same on both sides: audio, camera, screen
    const mic = micTrack();
    if (mic) peer.audioSender = pc.addTrack(mic, V.local || new MediaStream([mic]));
    else peer.audioSender = pc.addTransceiver('audio', { direction: 'sendrecv' }).sender; // track can be added later without renegotiation
    peer.audioTx = pc.getTransceivers().find((t) => t.sender === peer.audioSender);
    const vtCam = pc.addTransceiver('video', { direction: 'sendrecv' });
    const vtScr = pc.addTransceiver('video', { direction: 'inactive' }); // opens when someone shares / watches
    peer.camSender = vtCam.sender;
    peer.screenSender = vtScr.sender;
    peer.camTx = vtCam;
    peer.screenTx = vtScr;
    if (camTrack()) { vtCam.sender.replaceTrack(camTrack()).catch(() => {}); tune(vtCam.sender, false); }
    if (screenTrack()) { vtScr.sender.replaceTrack(screenTrack()).catch(() => {}); tune(vtScr.sender, true); }
    refreshDirections(peer);

    pc.onicecandidate = (e) => { if (e.candidate) send({ t: 'signal', to: conn, data: { candidate: e.candidate } }); };
    pc.ontrack = (e) => {
      if (e.track.kind === 'audio') {
        peer.audioStream.addTrack(e.track);
        watchSpeaking(conn, e.track);
        playPeerAudio(peer);
        return;
      }
      // camera or screen? decided by the mid the other side announced (see announceMids)
      peer.videoTracks.set(e.transceiver.mid, e.track);
      routeVideo(peer);
    };
    // "perfect negotiation": both sides may offer at once, the polite one backs off
    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        send({ t: 'signal', to: conn, data: { description: pc.localDescription } });
        announceMids(peer);
      } catch (e) { console.warn('negotiation', e); } finally { peer.makingOffer = false; }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') { try { pc.restartIce(); } catch { /* ignore */ } }
      updateTile(conn);
    };
    V.peers.set(conn, peer);
    renderCall();
    return peer;
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
      } else if (candidate) {
        try { await pc.addIceCandidate(candidate); } catch (e) { if (!peer.ignoreOffer) throw e; }
      }
    } catch (e) { console.warn('signal', e); }
  }

  function onVoiceMembers(m) {
    if (V.room !== m.room) return;
    for (const mem of m.members) makePeer(mem.conn, mem.user, mem);
    renderCall();
  }
  function onVoiceJoined(mem) {
    if (V.room !== mem.room) return;
    makePeer(mem.conn, mem.user, mem);
    if (V.calling) { clearTimeout(V.calling.timer); V.calling = null; stopTone(); }
    uiSound('join');
    renderCall();
  }
  function onVoiceLeft(conn) {
    const p = V.peers.get(conn);
    if (!p) return;
    closePeer(p);
    V.peers.delete(conn);
    V.stops.get(conn)?.();
    V.stops.delete(conn);
    for (const key of [conn, `${conn}:s`]) { V.tiles.get(key)?.remove(); V.tiles.delete(key); }
    uiSound('leave');
    renderCall();
  }
  function onVoiceState(mem) {
    const p = V.peers.get(mem.conn);
    if (!p) return;
    p.state = { video: mem.video, screen: mem.screen, muted: mem.muted, deaf: mem.deaf };
    renderCall();
  }

  // ── speaking indicator
  function watchSpeaking(key, track) {
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
        const rms = Math.sqrt(s / buf.length);
        setSpeaking(key, rms > 0.035 && !(key === 'me' && (V.muted || V.deaf)));
      }, 120);
      V.stops.set(key, () => { clearInterval(id); try { src.disconnect(); } catch { /* ignore */ } setSpeaking(key, false); });
    } catch { /* no audio analysis */ }
  }
  function setSpeaking(key, on) {
    V.tiles.get(key)?.classList.toggle('speaking', on);
    const conn = key === 'me' ? st.conn : key;
    $$(`.vm[data-conn="${conn}"]`).forEach((e) => e.classList.toggle('speaking', on));
  }

  // ── camera and screen are separate videos: both can be on at the same time
  async function startCamera(silent) {
    try {
      const s = await getCam();
      V.devIds.cam = S.settings.camId || '';
      V.camTrack = s.getVideoTracks()[0];
      V.camTrack.onended = () => stopCamera();
      applyCam(silent);
      return true;
    } catch (e) {
      toast(`Camera not available: ${e.message || e}`, 'err');
      return false;
    }
  }
  function stopCamera() {
    V.camTrack?.stop();
    V.camTrack = null;
    applyCam();
  }
  function applyCam(silent) {
    const t = camTrack();
    V.previewCam?.getVideoTracks().forEach((x) => V.previewCam.removeTrack(x));
    if (t) V.previewCam?.addTrack(t);
    for (const p of V.peers.values()) { p.camSender?.replaceTrack(t).catch(() => {}); tune(p.camSender, false); }
    if (!silent) sendState();
    renderCall();
  }
  function applyScreen() {
    const t = screenTrack();
    V.previewScreen?.getVideoTracks().forEach((x) => V.previewScreen.removeTrack(x));
    if (t) V.previewScreen?.addTrack(t);
    for (const p of V.peers.values()) {
      p.screenSender?.replaceTrack(t).catch(() => {});
      tune(p.screenSender, true);
      refreshDirections(p);
    }
    sendState();
    renderCall();
  }

  async function startScreen() {
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio: true });
      const vt = s.getVideoTracks()[0];
      vt.contentHint = 'motion';
      vt.onended = () => stopScreen();
      V.screen = s;
      mixScreenAudio(s);
      applyScreen();
    } catch (e) {
      if (e && e.name !== 'NotAllowedError') toast(`Screen sharing failed: ${e.message || e}`, 'err');
    }
  }
  function stopScreen() {
    if (!V.screen) return;
    V.screen.getTracks().forEach((t) => t.stop());
    V.screen = null;
    try { V.mix?.screenSrc?.disconnect(); } catch { /* ignore */ }
    if (V.mix) V.mix.screenSrc = null;
    applyScreen();
  }
  /** Game/system audio of the shared screen goes into the mixer next to the microphone. */
  function mixScreenAudio(display) {
    const at = display.getAudioTracks()[0];
    if (!at) return;
    try {
      const mix = ensureMixer();
      mix.screenSrc = getCtx().createMediaStreamSource(new MediaStream([at]));
      mix.screenSrc.connect(mix.dest);
    } catch { /* the others just don't get the system sound */ }
  }

  /** Re-opens the microphone after a failed start (permission, unplugged, wrong device). */
  async function retryMic() {
    try {
      const s = await getMic();
      V.local?.getTracks().forEach((x) => x.stop());
      V.local = s;
      V.devIds.mic = S.settings.micId || '';
      setMicTrack(s.getAudioTracks()[0]);
      renderCall();
      toast('Microphone connected');
    } catch (e) { toast(`Microphone still not available: ${e.message || e}`, 'err'); }
  }

  function applyMute(kind) {
    V.local?.getAudioTracks().forEach((t) => { t.enabled = !(V.muted || V.deaf); });
    for (const p of V.peers.values()) applyPeerVolume(p);
    sendState();
    updateTile('me');
    renderCallBar();
    if (kind) uiSound(kind);
  }

  // ── call area: every person has a camera tile, every shared screen has its own tile
  const isScreenKey = (key) => String(key).endsWith(':s');
  const peerOfKey = (key) => (key === 'me' || key === 'me:s' ? null : V.peers.get(parseInt(key, 10)));

  function ensureTile(key, label, isMe) {
    let el = V.tiles.get(key);
    if (el) return el;
    const screen = isScreenKey(key);
    const peer = peerOfKey(key);
    el = document.createElement('div');
    el.className = `vtile ${isMe ? 'me' : ''} ${screen ? 'screen-tile focus' : ''}`;
    el.dataset.key = key;
    el.innerHTML = `<video autoplay playsinline muted></video>
      ${screen ? '' : `<div class="big">${avatar(label)}</div>`}
      ${screen && !isMe ? `<div class="watch"><b>${esc(label)}</b><button class="btn-primary sm" data-watch><span class="bp-fill"></span><span class="bp-label">WATCH STREAM</span></button></div>` : ''}
      <div class="vlabel"><i class="conn"></i><span>${esc(label)}${isMe && !screen ? ' (you)' : ''}</span><span class="vic"></span></div>
      <div class="vtools">
        ${!screen && !isMe ? `<label class="vvol" title="Volume of ${esc(label)}">${ICON.spk}<input type="range" min="0" max="200" value="${Math.round(getVol(label) * 100)}" data-vol><em>${Math.round(getVol(label) * 100)}%</em></label>` : ''}
        ${screen ? `<button class="vtool" data-full title="Fullscreen">${ICON.full}</button>` : ''}
        ${screen && !isMe ? `<button class="vtool" data-unwatch title="Stop watching">${ICON.eyeOff}</button>` : ''}
      </div>`;
    el.addEventListener('click', (e) => { if (!e.target.closest('.vtools, .watch')) el.classList.toggle('focus'); });
    $('#vgrid').appendChild(el);
    V.tiles.set(key, el);
    const v = el.querySelector('video');
    if (key === 'me') v.srcObject = V.previewCam;
    else if (key === 'me:s') v.srcObject = V.previewScreen;
    else if (peer) { v.srcObject = screen ? peer.screenStream : peer.camStream; v.play().catch(() => {}); }
    return el;
  }

  function updateTile(key) {
    const el = V.tiles.get(key);
    if (!el) return;
    const peer = peerOfKey(key);
    const screen = isScreenKey(key);
    if (key !== 'me' && key !== 'me:s' && !peer) return;
    if (screen) {
      const watching = key === 'me:s' || peer.watching;
      el.classList.toggle('has-video', watching);
      el.classList.toggle('not-watching', !watching);
      el.querySelector('.conn')?.classList.toggle('ok', key === 'me:s' || peer.pc.connectionState === 'connected');
      el.querySelector('.vic').innerHTML = '';
      return;
    }
    const me = key === 'me';
    const s = me ? { video: !!camTrack(), muted: V.muted, deaf: V.deaf } : peer.state;
    el.classList.toggle('has-video', !!s.video);
    el.querySelector('.vic').innerHTML = s.deaf ? ICON.spkOff : s.muted ? ICON.micOff : '';
    el.querySelector('.conn').classList.toggle('ok', me || peer.pc.connectionState === 'connected');
  }

  function renderCall() {
    const box = $('#soc-call');
    if (!V.room) { box.hidden = true; return; }
    box.hidden = false;
    $('#call-warn').hidden = !!V.local;
    const r = roomById(V.room);
    $('#call-title').textContent = V.room.startsWith('call:') ? 'Call' : (r?.name || 'Voice');
    $('#call-sub').textContent = V.calling ? `Calling ${V.calling.to}…` : `${V.peers.size + 1} in call`;
    const want = new Set(['me']);
    ensureTile('me', st.user, true);
    if (V.screen) { want.add('me:s'); ensureTile('me:s', `${st.user} – your screen`, true); }
    for (const [conn, p] of V.peers) {
      want.add(conn);
      ensureTile(conn, p.user, false);
      if (p.state.screen) { want.add(`${conn}:s`); ensureTile(`${conn}:s`, `${p.user} is sharing their screen`, false); }
    }
    for (const key of [...V.tiles.keys()]) if (!want.has(key)) { V.tiles.get(key).remove(); V.tiles.delete(key); }
    for (const key of V.tiles.keys()) updateTile(key);
    renderCallBar();
  }

  function renderCallBar() {
    $('#vbar').innerHTML = `
      <button class="vbtn ${V.muted ? 'off' : ''}" data-act="mic" title="${V.muted ? 'Unmute' : 'Mute'}">${V.muted ? ICON.micOff : ICON.mic}</button>
      <button class="vbtn ${V.deaf ? 'off' : ''}" data-act="deaf" title="${V.deaf ? 'Undeafen' : 'Deafen'}">${V.deaf ? ICON.spkOff : ICON.spk}</button>
      <button class="vbtn ${V.camTrack ? 'live' : ''}" data-act="cam" title="Camera">${V.camTrack ? ICON.cam : ICON.camOff}</button>
      <button class="vbtn ${V.screen ? 'live' : ''}" data-act="screen" title="${V.screen ? 'Stop sharing' : 'Share your screen'}">${ICON.screen}</button>
      <button class="vbtn ${$('#sfx-panel').hidden ? '' : 'live'}" data-act="sfx" title="Sound effects">${ICON.music}</button>
      <button class="vbtn leave" data-act="leave" title="Leave">${ICON.hangup}</button>`;
  }

  /** Volume slider / watch buttons inside the call grid. */
  function wireCallGrid() {
    const grid = $('#vgrid');
    grid.addEventListener('input', (e) => {
      if (!e.target.matches('[data-vol]')) return;
      const tile = e.target.closest('.vtile');
      const peer = peerOfKey(tile.dataset.key);
      if (!peer) return;
      const v = Number(e.target.value) / 100;
      (S.settings.peerVolumes ||= {})[peer.user] = v;
      e.target.nextElementSibling.textContent = `${e.target.value}%`;
      applyPeerVolume(peer);
      saveSettings();
    });
    grid.addEventListener('click', (e) => {
      const tile = e.target.closest('.vtile');
      if (!tile) return;
      const peer = peerOfKey(tile.dataset.key);
      if (e.target.closest('[data-watch]') && peer) { peer.watching = true; refreshDirections(peer); updateTile(tile.dataset.key); tile.querySelector('video')?.play().catch(() => {}); }
      if (e.target.closest('[data-unwatch]') && peer) { peer.watching = false; refreshDirections(peer); updateTile(tile.dataset.key); }
      if (e.target.closest('[data-full]')) tile.requestFullscreen?.().catch(() => {});
    });
  }

  // ── calls (ringing)
  function ring(m) {
    if (st.rings.has(m.room)) return;
    const el = document.createElement('div');
    el.className = 'ring-card';
    el.innerHTML = `<div class="rt">${avatar(m.from)}<div><b>${esc(m.from)}</b><small>${m.group ? 'invites you to a call' : m.video ? 'Incoming video call' : 'Incoming call'}</small></div></div>
      <div class="rb"><button class="acc">Accept</button><button class="vid">Video</button><button class="dec">Decline</button></div>`;
    const accept = (video) => { send({ t: 'call_accept', room: m.room }); dismissRing(m.room); showSocial(); joinVoice(m.room, video); };
    $('.acc', el).onclick = () => accept(false);
    $('.vid', el).onclick = () => accept(true);
    $('.dec', el).onclick = () => { send({ t: 'call_decline', room: m.room }); dismissRing(m.room); };
    $('#soc-rings').appendChild(el);
    st.rings.set(m.room, { el, timer: setTimeout(() => dismissRing(m.room), 45000) });
    if (st.rings.size === 1) startTone('ring');
  }
  function dismissRing(room) {
    const r = st.rings.get(room);
    if (!r) return;
    clearTimeout(r.timer);
    r.el.remove();
    st.rings.delete(room);
    if (!st.rings.size) stopTone();
  }

  function onCallStarted(m) {
    joinVoice(m.room, m.video).then(() => {
      if (V.room !== m.room) return;
      V.calling = { room: m.room, to: m.to, timer: setTimeout(() => {
        if (V.room === m.room && V.peers.size === 0) { send({ t: 'call_cancel', room: m.room }); leaveVoice(); toast(`${m.to} did not answer`, 'err'); }
      }, 45000) };
      startTone('ringback'); // you hear it ringing on the other side
      renderCall();
    });
  }

  function callUser(name, video) {
    if (V.room) { send({ t: 'call_invite', room: V.room, to: name }); toast(`Invited ${name}`); return; }
    send({ t: 'call', to: name, video: !!video });
  }

  /* ───────────── device settings (selects, test, live switching) ───────────── */

  const devTest = { stream: null, raf: 0, ctx: null };

  async function fillDevices() {
    let all = [];
    try { all = await navigator.mediaDevices.enumerateDevices(); } catch {
      $('#dev-msg').textContent = 'Device access is not available here';
      return;
    }
    const fill = (sel, kind, cur, fallback) => {
      const list = all.filter((d) => d.kind === kind && d.deviceId !== 'default' && d.deviceId !== 'communications');
      const el = $(sel);
      el.innerHTML = `<option value="">System default</option>${list.map((d, i) => `<option value="${esc(d.deviceId)}">${esc(d.label || `${fallback} ${i + 1}`)}</option>`).join('')}`;
      if (cur && !list.some((d) => d.deviceId === cur)) el.insertAdjacentHTML('beforeend', `<option value="${esc(cur)}">Saved device (not connected)</option>`);
      el.value = cur || '';
    };
    fill('#dev-mic', 'audioinput', S.settings.micId, 'Microphone');
    fill('#dev-spk', 'audiooutput', S.settings.speakerId, 'Speakers');
    fill('#dev-cam', 'videoinput', S.settings.camId, 'Camera');
    $('#dev-allow').hidden = all.some((d) => d.label);
  }

  async function allowDevices() {
    const msg = $('#dev-msg');
    msg.className = 'dev-msg';
    try {
      let s;
      try { s = await navigator.mediaDevices.getUserMedia({ audio: true, video: true }); } catch { s = await navigator.mediaDevices.getUserMedia({ audio: true }); }
      s.getTracks().forEach((t) => t.stop());
    } catch (e) {
      msg.className = 'dev-msg err';
      msg.textContent = `Access was blocked: ${e.message || e}`;
    }
    fillDevices();
  }

  function stopDeviceTest() {
    cancelAnimationFrame(devTest.raf);
    devTest.stream?.getTracks().forEach((t) => t.stop());
    devTest.stream = null;
    try { devTest.ctx?.close(); } catch { /* ignore */ }
    devTest.ctx = null;
    const v = $('#dev-preview');
    v.srcObject = null; v.hidden = true;
    $('#dev-meter').hidden = true;
    $('#dev-meter i').style.width = '0';
    $('#dev-test').textContent = 'Test mic & camera';
  }

  async function toggleDeviceTest() {
    if (devTest.stream) { stopDeviceTest(); return; }
    const mic = $('#dev-mic').value;
    const cam = $('#dev-cam').value;
    const msg = $('#dev-msg');
    msg.className = 'dev-msg';
    msg.textContent = '';
    const dev = (id) => (id ? { deviceId: { exact: id } } : true);
    try {
      devTest.stream = await navigator.mediaDevices.getUserMedia({ audio: dev(mic), video: dev(cam) });
    } catch {
      try {
        devTest.stream = await navigator.mediaDevices.getUserMedia({ audio: dev(mic) });
        msg.textContent = 'No camera available – testing the microphone only';
      } catch (e) {
        msg.className = 'dev-msg err';
        msg.textContent = `Could not open the devices: ${e.message || e}`;
        return;
      }
    }
    const s = devTest.stream;
    if (s.getVideoTracks().length) { const v = $('#dev-preview'); v.srcObject = s; v.hidden = false; }
    $('#dev-meter').hidden = false;
    $('#dev-test').textContent = 'Stop test';
    try {
      devTest.ctx = new AudioContext();
      const an = devTest.ctx.createAnalyser();
      an.fftSize = 512;
      devTest.ctx.createMediaStreamSource(s).connect(an);
      const buf = new Uint8Array(an.fftSize);
      const loop = () => {
        an.getByteTimeDomainData(buf);
        let sum = 0;
        for (const x of buf) { const d = (x - 128) / 128; sum += d * d; }
        $('#dev-meter i').style.width = `${Math.min(100, Math.sqrt(sum / buf.length) * 320)}%`;
        devTest.raf = requestAnimationFrame(loop);
      };
      loop();
    } catch { /* no meter */ }
    fillDevices();
  }

  /** A short two-tone sound generated on the fly, played on the chosen output. */
  async function playTestSound() {
    const rate = 22050;
    const n = Math.floor(rate * 0.8);
    const buf = new DataView(new ArrayBuffer(44 + n * 2));
    const w = (o, s) => [...s].forEach((c, i) => buf.setUint8(o + i, c.charCodeAt(0)));
    w(0, 'RIFF'); buf.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); buf.setUint32(16, 16, true);
    buf.setUint16(20, 1, true); buf.setUint16(22, 1, true); buf.setUint32(24, rate, true); buf.setUint32(28, rate * 2, true);
    buf.setUint16(32, 2, true); buf.setUint16(34, 16, true); w(36, 'data'); buf.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) {
      const f = i < n / 2 ? 660 : 880;
      const env = Math.min(1, i / 400, (n - i) / 800);
      buf.setInt16(44 + i * 2, Math.sin((2 * Math.PI * f * i) / rate) * 9000 * env, true);
    }
    const a = new Audio(URL.createObjectURL(new Blob([buf], { type: 'audio/wav' })));
    try { if (a.setSinkId) await a.setSinkId($('#dev-spk').value || ''); await a.play(); } catch (e) {
      $('#dev-msg').className = 'dev-msg err';
      $('#dev-msg').textContent = `Could not play on that output: ${e.message || e}`;
    }
  }

  /** Called after the settings were saved: switches the running call to the new devices. */
  async function applyDevices() {
    for (const p of V.peers.values()) applySink(p.audioEl);
    if (!V.room) return;
    const mic = S.settings.micId || '';
    const cam = S.settings.camId || '';
    if (V.local && mic !== V.devIds.mic) {
      try {
        const s = await getMic();
        V.local.getTracks().forEach((x) => x.stop());
        V.local = s;
        V.devIds.mic = mic;
        setMicTrack(s.getAudioTracks()[0]);
      } catch (e) { toast(`Could not switch the microphone: ${e.message || e}`, 'err'); }
    }
    if (V.camTrack && cam !== V.devIds.cam) {
      V.camTrack.stop();
      V.camTrack = null;
      await startCamera();
    }
  }

  /* ───────────── internet mode (server reachable from other networks) ───────────── */

  function renderNet(s) {
    const box = $('#net-info');
    if (!s || !s.internet) { box.hidden = true; return; }
    box.hidden = false;
    const i = s.info || {};
    const addr = i.publicIp ? `http://${i.publicIp}:7777` : '';
    const upnp = i.upnp || {};
    const turn = i.turn || {};
    const mark = (ok, text) => `<span class="${ok ? 'ok' : 'warn'}">${ok ? '●' : '○'}</span> ${esc(text)}`;
    box.innerHTML = `
      <div class="row2"><b>Address for friends</b> ${addr ? `<code>${esc(addr)}</code><button class="btn-ghost mini" data-copy="${esc(addr)}">Copy</button>` : '<span class="warn">unknown – set up port forwarding and use your public IP</span>'}</div>
      <div class="row2"><b>Invite code</b> <code>${esc(s.inviteCode || '')}</code><button class="btn-ghost mini" data-copy="${esc(s.inviteCode || '')}">Copy</button></div>
      <div class="row2">${mark(s.running, s.running ? 'Server is running' : 'Server is not running')}</div>
      <div class="row2">${mark(upnp.ok, upnp.ok ? 'Router ports opened automatically (UPnP)' : `UPnP: ${upnp.message || 'not available'}`)}</div>
      <div class="row2">${mark(turn.ok, turn.ok ? `Call relay (TURN) on UDP ${turn.port}` : `Call relay: ${turn.message || 'not running'}`)}</div>
      <ul>
        <li>Friends enter the address above (Chat &amp; Voice → Server) and the invite code when creating their account.</li>
        <li>If Windows asks, allow <b>nexus-server.exe</b> through the firewall.</li>
        <li>Without UPnP forward <b>TCP 7777</b> and <b>UDP 3478</b> + <b>49160–49200</b> to this PC.</li>
        <li>The connection is <b>not encrypted</b>: use a password you use nowhere else, or run Nexus over a VPN such as Tailscale.</li>
      </ul>`;
  }

  async function netRefresh() {
    let s = null;
    try { s = await api.invoke('server_status'); } catch { /* browser preview */ }
    $('#set-internet').checked = !!(s && s.internet);
    renderNet(s);
  }

  async function setInternet(on) {
    const sw = $('#set-internet');
    sw.disabled = true;
    try {
      const s = await api.invoke('set_internet_mode', { enabled: on });
      S.settings.internetMode = on;
      S.settings.inviteCode = s.inviteCode || S.settings.inviteCode;
      renderNet(s);
      toast(on ? 'Internet mode on – allow the Windows Firewall prompt if it appears' : 'Internet mode off – the server is local only again');
    } catch (e) {
      sw.checked = !on;
      toast(String(e), 'err');
    } finally { sw.disabled = false; }
  }
  /* ───────────── TeamSpeak ───────────── */

  const tsSet = (id, hidden) => { $(id).hidden = hidden; };

  async function tsConnect(silent) {
    const key = $('#ts-key').value.trim();
    const addr = $('#ts-addr').value.trim();
    const err = $('#ts-err');
    err.textContent = '';
    if (!key) { if (!silent) err.textContent = 'Paste the ClientQuery API key from TeamSpeak'; return; }
    // keep the key on this PC right away, even if TeamSpeak is not running yet
    S.settings.tsApiKey = key;
    S.settings.tsAddress = addr;
    saveSettings();
    $('#ts-go').disabled = true;
    try {
      await api.invoke('ts_connect', { apiKey: key, address: addr || null });
      st.ts.on = true;
      await tsRefresh();
    } catch (e) {
      st.ts.on = false;
      if (!silent) err.textContent = String(e);
      tsSet('#ts-connect', false); tsSet('#ts-live', true);
    } finally { $('#ts-go').disabled = false; }
  }

  async function tsRefresh() {
    try {
      st.ts.ov = await api.invoke('ts_overview');
      tsSet('#ts-connect', true); tsSet('#ts-live', false);
      renderTs();
    } catch (e) {
      const msg = String(e);
      if (/not connected to the TeamSpeak client/i.test(msg)) { st.ts.on = false; tsSet('#ts-connect', false); tsSet('#ts-live', true); return; }
      // connected to the client, but its active tab is not on a server
      tsSet('#ts-connect', true); tsSet('#ts-live', false);
      st.ts.ov = null;
      $('#ts-server').textContent = 'TeamSpeak';
      $('#ts-tree').innerHTML = `<div style="padding:8px 2px;color:var(--mut);font-size:12.5px">${esc(msg)}</div>`;
    }
  }

  function renderTs() {
    const ov = st.ts.ov;
    if (!ov) return;
    $('#ts-server').textContent = ov.serverName || 'TeamSpeak server';
    $('#ts-mic').innerHTML = `${ov.inputMuted ? ICON.micOff : ICON.mic}<span>${ov.inputMuted ? 'Mic muted' : 'Mic on'}</span>`;
    $('#ts-mic').classList.toggle('off', ov.inputMuted);
    $('#ts-spk').innerHTML = `${ov.outputMuted ? ICON.spkOff : ICON.spk}<span>${ov.outputMuted ? 'Sound off' : 'Sound on'}</span>`;
    $('#ts-spk').classList.toggle('off', ov.outputMuted);
    const kids = new Map();
    const ids = new Set(ov.channels.map((c) => c.cid));
    for (const c of ov.channels) {
      const p = ids.has(c.pid) ? c.pid : 0;
      if (!kids.has(p)) kids.set(p, []);
      kids.get(p).push(c);
    }
    const client = (x) => `<div class="ts-cl ${x.talking || st.ts.talk.has(x.clid) ? 'talking' : ''} ${x.isMe ? 'me' : ''}" data-clid="${x.clid}"><i class="d"></i><span>${esc(x.name)}</span>${x.outputMuted ? ICON.spkOff : x.inputMuted ? ICON.micOff : ''}</div>`;
    const row = (c) => {
      const sub = (kids.get(c.cid) || []).map(row).join('');
      return `<div><button class="ts-ch ${c.cid === ov.myCid ? 'cur' : ''}" data-cid="${c.cid}"><span>#</span><span class="n">${esc(c.name)}</span></button>${ov.clients.filter((x) => x.cid === c.cid).map(client).join('')}${sub ? `<div class="ts-kids">${sub}</div>` : ''}</div>`;
    };
    $('#ts-tree').innerHTML = (kids.get(0) || []).map(row).join('');
  }

  function tsLog(who, text) {
    const log = $('#ts-log');
    const d = document.createElement('div');
    d.innerHTML = `<b>${esc(who)}</b> ${esc(text)}`;
    log.prepend(d);
    while (log.children.length > 40) log.lastChild.remove();
  }

  function tsDebouncedRefresh() {
    clearTimeout(st.ts.refreshT);
    st.ts.refreshT = setTimeout(() => { if (st.ts.on) tsRefresh(); }, 350);
  }

  function initTs() {
    $('#ts-key').value = S.settings.tsApiKey || '';
    $('#ts-addr').value = S.settings.tsAddress || '127.0.0.1:25639';
    $('#ts-go').addEventListener('click', () => tsConnect(false));
    $('#ts-key').addEventListener('keydown', (e) => { if (e.key === 'Enter') tsConnect(false); });
    $('#ts-off').addEventListener('click', async () => {
      await api.invoke('ts_disconnect').catch(() => {});
      st.ts.on = false; st.ts.ov = null;
      tsSet('#ts-connect', false); tsSet('#ts-live', true);
    });
    $('#ts-mic').addEventListener('click', async () => {
      try { await api.invoke('ts_set_mute', { input: !st.ts.ov?.inputMuted, output: null }); tsRefresh(); } catch (e) { toast(String(e), 'err'); }
    });
    $('#ts-spk').addEventListener('click', async () => {
      try { await api.invoke('ts_set_mute', { input: null, output: !st.ts.ov?.outputMuted }); tsRefresh(); } catch (e) { toast(String(e), 'err'); }
    });
    $('#ts-tree').addEventListener('click', async (e) => {
      const b = e.target.closest('.ts-ch');
      if (!b || !st.ts.ov) return;
      try { await api.invoke('ts_join_channel', { clid: st.ts.ov.myClid, cid: Number(b.dataset.cid) }); tsRefresh(); } catch (err) { toast(String(err), 'err'); }
    });
    $('#ts-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = $('#ts-msg');
      const msg = input.value.trim();
      if (!msg || !st.ts.ov) return;
      try { await api.invoke('ts_send_text', { cid: st.ts.ov.myCid, msg }); tsLog('You', msg); input.value = ''; } catch (err) { toast(String(err), 'err'); }
    });
    api.listen('ts-talk', (e) => {
      const { clid, talking } = e.payload;
      if (talking) st.ts.talk.add(clid); else st.ts.talk.delete(clid);
      $$(`.ts-cl[data-clid="${clid}"]`).forEach((el) => el.classList.toggle('talking', talking));
    });
    api.listen('ts-text', (e) => tsLog(e.payload.from || 'TeamSpeak', e.payload.msg));
    api.listen('ts-changed', tsDebouncedRefresh);
    api.listen('ts-disconnected', () => {
      st.ts.on = false; st.ts.ov = null;
      tsSet('#ts-connect', false); tsSet('#ts-live', true);
      $('#ts-err').textContent = 'The TeamSpeak client closed the connection';
    });
  }

  /* ───────────── wiring ───────────── */

  function showSocial() {
    if (typeof showView === 'function') showView('social');
  }

  function onShow() {
    if (st.ready) { st.unread.delete(st.current); st.mentions.delete(st.current); updateBadge(); renderRooms(); renderDms(); renderMsgs(); }
    else if (!st.token) showLogin();
    if (!st.ts.tried && S.settings.tsApiKey && desktop()) { st.ts.tried = true; tsConnect(true); }
  }

  function init() {
    if (st.inited) return;
    st.inited = true;
    st.base = S.settings.socialServer || '';
    st.user = S.settings.socialUser || '';
    st.token = S.settings.socialToken || '';
    $('#soc-server').value = st.base || 'http://127.0.0.1:7777';
    $('#soc-user').value = st.user;

    $('#soc-mode').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { st.modeTouched = true; setMode(b.dataset.m); } });
    $('#soc-go').addEventListener('click', submitAuth);
    for (const id of ['#soc-user', '#soc-pass']) $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') submitAuth(); });
    $('#soc-server').addEventListener('change', checkServer);
    $('#soc-adv').addEventListener('toggle', checkServer);
    $('#soc-sstart').addEventListener('click', async () => {
      $('#soc-sstat').textContent = 'Starting…';
      try { await api.invoke('start_local_server'); } catch (e) { toast(String(e), 'err'); }
      checkServer();
    });
    $('#soc-sstop').addEventListener('click', async () => { await api.invoke('stop_local_server').catch(() => {}); checkServer(); });
    $('#soc-logout').addEventListener('click', logout);

    // rooms
    $('#soc-text').addEventListener('click', (e) => { const b = e.target.closest('[data-room]'); if (b) openRoom(b.dataset.room); });
    $('#soc-dms').addEventListener('click', (e) => {
      const call = e.target.closest('[data-call]');
      if (call) { e.stopPropagation(); callUser(call.dataset.call, !!call.dataset.video); return; }
      const b = e.target.closest('[data-room]');
      if (b) openRoom(b.dataset.room);
    });
    $('#soc-voice').addEventListener('click', (e) => {
      const vid = e.target.closest('[data-vvideo]');
      if (vid) { e.stopPropagation(); joinVoice(vid.dataset.vvideo, true); return; }
      const b = e.target.closest('[data-voice]');
      if (b) joinVoice(b.dataset.voice, false);
    });
    for (const kind of ['text', 'voice']) {
      $(`#add-${kind}`).addEventListener('click', () => { const f = $(`#new-${kind}`); f.hidden = !f.hidden; if (!f.hidden) $('input', f).focus(); });
      $(`#new-${kind}`).addEventListener('submit', (e) => {
        e.preventDefault();
        const input = $('input', e.currentTarget);
        if (input.value.trim()) send({ t: 'create_room', name: input.value.trim(), kind });
        input.value = ''; e.currentTarget.hidden = true;
      });
    }

    // people + right tabs
    $('#pane-people').addEventListener('click', (e) => {
      const dm = e.target.closest('[data-dm]');
      if (dm) { startDm(dm.dataset.dm); return; }
      const mn = e.target.closest('[data-mention]');
      if (mn) {
        const el = $('#chat-input');
        el.value = `${el.value && !/\s$/.test(el.value) ? `${el.value} ` : el.value}@${mn.dataset.mention} `;
        el.focus();
        return;
      }
      const call = e.target.closest('[data-call]');
      if (call) { callUser(call.dataset.call, !!call.dataset.video); return; }
      const inv = e.target.closest('[data-invite]');
      if (inv) callUser(inv.dataset.invite, false);
    });
    $('#right-tabs').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      st.tab = b.dataset.tab;
      $$('#right-tabs button').forEach((x) => x.classList.toggle('on', x === b));
      $('#pane-people').hidden = st.tab !== 'people';
      $('#pane-ts').hidden = st.tab !== 'ts';
      if (st.tab === 'ts' && !st.ts.tried && S.settings.tsApiKey && desktop()) { st.ts.tried = true; tsConnect(true); }
    });

    // call controls
    document.addEventListener('pointerdown', resumeAudio, { capture: true });
    wireCallGrid();
    $('#sfx-panel').addEventListener('click', (e) => {
      if (e.target.closest('[data-sfx-add]')) { addSound(); return; }
      const b = e.target.closest('[data-sfx]');
      if (b) { playSfx(SFX.find((s) => s.id === b.dataset.sfx)); return; }
      const c = e.target.closest('[data-sfxc]');
      if (c) playSfx(S.settings.sounds[Number(c.dataset.sfxc)]);
    });
    $('#sfx-panel').addEventListener('input', (e) => {
      if (e.target.id === 'sfx-vol') { S.settings.sfxVolume = Number(e.target.value) / 100; saveSettings(); }
    });
    $('#sfx-panel').addEventListener('contextmenu', async (e) => {
      const c = e.target.closest('[data-sfxc]');
      if (!c) return;
      e.preventDefault();
      const [gone] = S.settings.sounds.splice(Number(c.dataset.sfxc), 1);
      api.invoke('remove_sound', { path: gone.path }).catch(() => {});
      saveSettings(); renderSfx(); toast(`Removed "${gone.name}"`);
    });
    $('#call-retry').addEventListener('click', retryMic);
    $('#vbar').addEventListener('click', async (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      switch (b.dataset.act) {
        case 'mic': V.muted = !V.muted; applyMute(V.muted ? 'mute' : 'unmute'); break;
        case 'deaf': V.deaf = !V.deaf; applyMute(V.deaf ? 'mute' : 'unmute'); break;
        case 'sfx': { const pnl = $('#sfx-panel'); pnl.hidden = !pnl.hidden; if (!pnl.hidden) renderSfx(); renderCallBar(); break; }
        case 'cam': if (V.camTrack) stopCamera(); else await startCamera(); break;
        case 'screen': if (V.screen) stopScreen(); else await startScreen(); break;
        case 'leave': leaveVoice(); break;
        default: break;
      }
    });

    // composer
    const input = $('#chat-input');
    const fit = () => { input.style.height = 'auto'; input.style.height = `${Math.min(140, input.scrollHeight)}px`; };
    // @mentions: typing "@" opens a list of people; Tab / Enter / click inserts the name
    const pop = $('#mention-pop');
    let popItems = [];
    let popIdx = 0;
    const closePop = () => { pop.hidden = true; popItems = []; };
    const mentionQuery = () => {
      const pos = input.selectionStart;
      const m = /(^|\s)@([A-Za-z0-9_-]{0,24})$/.exec(input.value.slice(0, pos));
      return m ? { start: pos - m[2].length - 1, end: pos, q: m[2] } : null;
    };
    const renderPop = () => {
      pop.innerHTML = popItems.map((c, i) => `<button type="button" class="mp ${i === popIdx ? 'on' : ''}" data-name="${esc(c.name)}">${c.special ? '<i class="mpi">@</i>' : avatar(c.name, c.online ? 'online' : '')}<b>${esc(c.name)}</b><small>${esc(c.hint || '')}</small></button>`).join('');
      pop.hidden = !popItems.length;
    };
    const updatePop = () => {
      const q = mentionQuery();
      if (!q) { closePop(); return; }
      const me = (st.user || '').toLowerCase();
      const low = q.q.toLowerCase();
      const users = st.users
        .filter((u) => u.name.toLowerCase() !== me && u.name.toLowerCase().startsWith(low))
        .sort((a, b) => Number(b.online) - Number(a.online))
        .map((u) => ({ name: u.name, online: u.online, hint: u.online ? 'online' : 'offline' }));
      const special = [{ name: 'everyone', special: true, hint: 'notify everybody' }, { name: 'here', special: true, hint: 'notify everybody' }].filter((s) => s.name.startsWith(low));
      popItems = [...users, ...special].slice(0, 7);
      popIdx = 0;
      renderPop();
    };
    const insertMention = (name) => {
      const q = mentionQuery();
      if (!q) return;
      input.value = `${input.value.slice(0, q.start)}@${name} ${input.value.slice(q.end)}`;
      const pos = q.start + name.length + 2;
      input.setSelectionRange(pos, pos);
      closePop();
      fit();
      input.focus();
    };
    pop.addEventListener('mousedown', (e) => { e.preventDefault(); const b = e.target.closest('.mp'); if (b) insertMention(b.dataset.name); });
    input.addEventListener('blur', () => setTimeout(closePop, 120));
    input.addEventListener('input', () => {
      fit();
      updatePop();
      if (Date.now() - st.lastTypingSent > 2500) { st.lastTypingSent = Date.now(); send({ t: 'typing', room: st.current }); }
    });
    input.addEventListener('keydown', (e) => {
      if (!pop.hidden && popItems.length) {
        if (e.key === 'ArrowDown') { e.preventDefault(); popIdx = (popIdx + 1) % popItems.length; renderPop(); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); popIdx = (popIdx - 1 + popItems.length) % popItems.length; renderPop(); return; }
        if (e.key === 'Tab' || e.key === 'Enter') { e.preventDefault(); insertMention(popItems[popIdx].name); return; }
        if (e.key === 'Escape') { e.preventDefault(); closePop(); return; }
      }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#composer').requestSubmit(); }
    });
    $('#composer').addEventListener('submit', (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text || !st.ready) return;
      send({ t: 'msg', room: st.current, text });
      input.value = ''; fit();
    });

    $('#dev-allow').addEventListener('click', allowDevices);
    $('#dev-test').addEventListener('click', toggleDeviceTest);
    $('#dev-sound').addEventListener('click', playTestSound);
    $('#set-internet').addEventListener('change', (e) => setInternet(e.target.checked));
    $('#net-info').addEventListener('click', (e) => {
      const b = e.target.closest('[data-copy]');
      if (b) navigator.clipboard?.writeText(b.dataset.copy).then(() => toast('Copied'));
    });
    navigator.mediaDevices?.addEventListener?.('devicechange', () => { if ($('#settings').classList.contains('on')) fillDevices(); });
    initTs();
    setMode('login');
    if (st.token && st.base) { st.wantOnline = true; resume(); }
  }

  return { init, onShow, state: st, debug: () => V, fillDevices, stopDeviceTest, applyDevices, netRefresh };
})();
