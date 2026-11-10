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
    speaker: svg('<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/>'),
  };

  const st = {
    base: '', token: '', user: '', conn: 0, ws: null, ice: [], rooms: [], dms: [], users: [], voiceRooms: {},
    msgs: new Map(), unread: new Map(), current: 'general', typing: new Map(), ready: false, wantOnline: false,
    retry: 0, hb: 0, tab: 'people', mode: 'login', inited: false, lastTypingSent: 0, resuming: false,
    rings: new Map(), ts: { on: false, ov: null, talk: new Set(), tried: false, refreshT: 0 },
  };
  const V = {
    room: null, local: null, camTrack: null, screen: null, mixTrack: null, ctx: null, muted: false, deaf: false,
    peers: new Map(), tiles: new Map(), stops: new Map(), calling: null, preview: null,
  };

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
  const linkify = (t) => esc(t).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" data-ext>$1</a>');
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
      label = `${j.name} · ${j.users} accounts · ${j.online} online`;
      // a brand-new server has no accounts yet: start on "Create account"
      if (j.users === 0 && !st.token && st.mode === 'login' && !st.modeTouched) setMode('register');
    } catch { /* offline */ }
    $('#soc-sdot').classList.toggle('on', running);
    $('#soc-sstat').textContent = label;
    $('#soc-sstart').hidden = running || !isLocal || !desktop();
    $('#soc-sstop').hidden = !(running && isLocal && desktop());
    return running;
  }

  function setMode(m) {
    st.mode = m;
    $$('#soc-mode button').forEach((b) => b.classList.toggle('on', b.dataset.m === m));
    $('#soc-go .bp-label').textContent = m === 'login' ? 'LOG IN' : 'CREATE ACCOUNT';
    $('#soc-pass').autocomplete = m === 'login' ? 'current-password' : 'new-password';
    $('#soc-err').textContent = '';
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
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }),
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
      updateBadge();
      renderRooms();
      renderDms();
      if (room.startsWith('dm:')) toast(`${msg.from}: ${msg.text.slice(0, 80)}`);
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
      return `<button class="soc-room ${st.current === r.id ? 'on' : ''}" data-room="${esc(r.id)}"><span class="ri">#</span><span class="rn">${esc(r.name)}</span>${ub ? `<span class="ub">${ub}</span>` : ''}</button>`;
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
      return `<button class="soc-room ${st.current === d.id ? 'on' : ''}" data-room="${esc(d.id)}">${avatar(d.with, p?.online ? p.status : '')}<span class="rn">${esc(d.with)}</span>${ub ? `<span class="ub">${ub}</span>` : ''}<span class="acts"><span class="mini" data-call="${esc(d.with)}" title="Call">${ICON.phone}</span><span class="mini" data-call="${esc(d.with)}" data-video="1" title="Video call">${ICON.cam}</span></span></button>`;
    }).join('') || '<div style="padding:6px 8px;color:var(--dim);font-size:12px">Use the People tab to start a conversation.</div>';
  }

  function renderPeople() {
    const inCall = !!V.room;
    $('#pane-people').innerHTML = st.users.filter((u) => u.name.toLowerCase() !== (st.user || '').toLowerCase()).map((u) => {
      const sub = u.voice ? `In voice: ${esc(roomById(u.voice)?.name || 'call')}` : u.online ? esc(u.status) : 'offline';
      return `<div class="person ${u.online ? '' : 'off'}">${avatar(u.name, u.online ? u.status : '')}<div class="grow"><b>${esc(u.name)}</b><small>${sub}</small></div><span class="acts">
        <span class="mini" data-dm="${esc(u.name)}" title="Message">${ICON.msg}</span>
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

  const micTrack = () => V.mixTrack || V.local?.getAudioTracks()[0] || null;
  const videoTrack = () => V.screen?.getVideoTracks()[0] || V.camTrack || null;

  function tune(sender) {
    if (!sender?.getParameters) return;
    try {
      const p = sender.getParameters();
      if (!p.encodings || !p.encodings.length) p.encodings = [{}];
      p.encodings[0].maxBitrate = V.screen ? 4_000_000 : 1_500_000;
      sender.setParameters(p).catch(() => {});
    } catch { /* not supported */ }
  }

  function sendState() {
    send({ t: 'voice_state', muted: V.muted, deaf: V.deaf, video: !!videoTrack(), screen: !!V.screen });
  }

  async function joinVoice(room, video = false) {
    if (!st.ready) { toast('Not connected to the server', 'err'); return; }
    if (V.room === room && !video) { leaveVoice(); return; }
    if (V.room) await leaveVoice();
    V.room = room;
    V.muted = false; V.deaf = false;
    V.preview = new MediaStream();
    try { V.ctx ||= new AudioContext(); V.ctx.resume(); } catch { /* audio analysis optional */ }
    try {
      V.local = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const t = V.local.getAudioTracks()[0];
      if (t) watchSpeaking('me', t);
    } catch (e) {
      V.local = null;
      toast('No microphone available – you can listen but not talk', 'err');
    }
    if (video) await startCamera(true);
    renderCall(); renderVoiceList(); renderPeople();
    send({ t: 'voice_join', room, video: !!videoTrack() });
  }

  async function leaveVoice() {
    send({ t: 'voice_leave' });
    endVoiceLocal();
  }

  function endVoiceLocal(msg) {
    for (const p of V.peers.values()) { try { p.pc.close(); } catch { /* ignore */ } }
    V.peers.clear();
    for (const stop of V.stops.values()) stop();
    V.stops.clear();
    V.local?.getTracks().forEach((t) => t.stop());
    V.camTrack?.stop();
    V.screen?.getTracks().forEach((t) => t.stop());
    V.mixTrack?.stop();
    if (V.calling) { clearTimeout(V.calling.timer); V.calling = null; }
    Object.assign(V, { room: null, local: null, camTrack: null, screen: null, mixTrack: null, muted: false, deaf: false, preview: null });
    $('#vgrid').innerHTML = '';
    V.tiles.clear();
    renderCall(); renderVoiceList(); renderPeople();
    if (msg) toast(msg, 'err');
  }

  function makePeer(conn, user, state = {}) {
    if (V.peers.has(conn)) return V.peers.get(conn);
    const pc = new RTCPeerConnection({ iceServers: st.ice });
    const peer = {
      conn, user, pc, polite: st.conn < conn, makingOffer: false, ignoreOffer: false, stream: new MediaStream(),
      audioSender: null, videoSender: null, state: { video: false, screen: false, muted: false, deaf: false, ...state },
    };
    const mic = micTrack();
    if (mic) peer.audioSender = pc.addTrack(mic, V.local || new MediaStream([mic]));
    else pc.addTransceiver('audio', { direction: 'recvonly' });
    // one video transceiver per peer: it carries the camera or, while sharing, the screen
    const vt = pc.addTransceiver('video', { direction: 'sendrecv' });
    peer.videoSender = vt.sender;
    const vtrack = videoTrack();
    if (vtrack) { vt.sender.replaceTrack(vtrack).catch(() => {}); tune(vt.sender); }

    pc.onicecandidate = (e) => { if (e.candidate) send({ t: 'signal', to: conn, data: { candidate: e.candidate } }); };
    pc.ontrack = (e) => {
      peer.stream.addTrack(e.track);
      if (e.track.kind === 'audio') watchSpeaking(conn, e.track);
      const tile = V.tiles.get(conn);
      const v = tile?.querySelector('video');
      if (v) { v.srcObject = peer.stream; v.play().catch(() => {}); }
    };
    // "perfect negotiation": both sides may offer at once, the polite one backs off
    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        send({ t: 'signal', to: conn, data: { description: pc.localDescription } });
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
    const { description, candidate } = m.data || {};
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
    if (V.calling) { clearTimeout(V.calling.timer); V.calling = null; }
    renderCall();
  }
  function onVoiceLeft(conn) {
    const p = V.peers.get(conn);
    if (!p) return;
    try { p.pc.close(); } catch { /* ignore */ }
    V.peers.delete(conn);
    V.stops.get(conn)?.();
    V.stops.delete(conn);
    V.tiles.get(conn)?.remove();
    V.tiles.delete(conn);
    renderCall();
  }
  function onVoiceState(mem) {
    const p = V.peers.get(mem.conn);
    if (!p) return;
    p.state = { video: mem.video, screen: mem.screen, muted: mem.muted, deaf: mem.deaf };
    updateTile(mem.conn);
  }

  // ── speaking indicator
  function watchSpeaking(key, track) {
    V.stops.get(key)?.();
    try {
      V.ctx ||= new AudioContext();
      const src = V.ctx.createMediaStreamSource(new MediaStream([track]));
      const an = V.ctx.createAnalyser();
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

  // ── camera, screen, mute
  async function startCamera(silent) {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } });
      V.camTrack = s.getVideoTracks()[0];
      V.camTrack.onended = () => stopCamera();
      applyVideo(silent);
      return true;
    } catch (e) {
      toast(`Camera not available: ${e.message || e}`, 'err');
      return false;
    }
  }
  function stopCamera() {
    V.camTrack?.stop();
    V.camTrack = null;
    applyVideo();
  }
  function applyVideo(silent) {
    const t = videoTrack();
    V.preview?.getVideoTracks().forEach((x) => V.preview.removeTrack(x));
    if (t) V.preview?.addTrack(t);
    for (const p of V.peers.values()) { p.videoSender?.replaceTrack(t).catch(() => {}); tune(p.videoSender); }
    if (!silent) sendState();
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
      applyVideo();
    } catch (e) {
      if (e && e.name !== 'NotAllowedError') toast(`Screen sharing failed: ${e.message || e}`, 'err');
    }
  }
  function stopScreen() {
    if (!V.screen) return;
    V.screen.getTracks().forEach((t) => t.stop());
    V.screen = null;
    if (V.mixTrack) {
      V.mixTrack.stop();
      V.mixTrack = null;
      const mic = V.local?.getAudioTracks()[0] || null;
      for (const p of V.peers.values()) p.audioSender?.replaceTrack(mic).catch(() => {});
    }
    applyVideo();
  }
  /** Game/system audio of the shared screen is mixed into the microphone track. */
  function mixScreenAudio(display) {
    const at = display.getAudioTracks()[0];
    const mic = V.local?.getAudioTracks()[0];
    if (!at || !mic) return;
    try {
      V.ctx ||= new AudioContext();
      const dest = V.ctx.createMediaStreamDestination();
      V.ctx.createMediaStreamSource(new MediaStream([mic])).connect(dest);
      V.ctx.createMediaStreamSource(new MediaStream([at])).connect(dest);
      V.mixTrack = dest.stream.getAudioTracks()[0];
      for (const p of V.peers.values()) p.audioSender?.replaceTrack(V.mixTrack).catch(() => {});
    } catch { /* keep the plain microphone */ }
  }

  function applyMute() {
    V.local?.getAudioTracks().forEach((t) => { t.enabled = !(V.muted || V.deaf); });
    for (const el of V.tiles.values()) {
      if (!el.classList.contains('me')) { const v = el.querySelector('video'); if (v) v.muted = V.deaf; }
    }
    sendState();
    updateTile('me');
    renderCallBar();
  }

  // ── call area
  function ensureTile(key, name, isMe) {
    let el = V.tiles.get(key);
    if (el) return el;
    el = document.createElement('div');
    el.className = `vtile ${isMe ? 'me' : ''}`;
    el.dataset.key = key;
    el.innerHTML = `<video autoplay playsinline ${isMe ? 'muted' : ''}></video><div class="big">${avatar(name)}</div><div class="vlabel"><i class="conn"></i><span>${esc(name)}${isMe ? ' (you)' : ''}</span><span class="vic"></span></div>`;
    el.addEventListener('click', () => el.classList.toggle('focus'));
    $('#vgrid').appendChild(el);
    V.tiles.set(key, el);
    const v = el.querySelector('video');
    if (isMe) v.srcObject = V.preview;
    else { const p = V.peers.get(key); if (p) { v.srcObject = p.stream; v.muted = V.deaf; v.play().catch(() => {}); } }
    return el;
  }

  function updateTile(key) {
    const el = V.tiles.get(key);
    if (!el) return;
    const me = key === 'me';
    const p = me ? null : V.peers.get(key);
    if (!me && !p) return;
    const s = me ? { video: !!videoTrack(), screen: !!V.screen, muted: V.muted, deaf: V.deaf } : p.state;
    el.classList.toggle('has-video', !!s.video);
    el.classList.toggle('screen', !!s.screen);
    el.querySelector('.vic').innerHTML = s.deaf ? ICON.spkOff : s.muted ? ICON.micOff : '';
    el.querySelector('.conn').classList.toggle('ok', me || p.pc.connectionState === 'connected');
  }

  function renderCall() {
    const box = $('#soc-call');
    if (!V.room) { box.hidden = true; return; }
    box.hidden = false;
    const r = roomById(V.room);
    $('#call-title').textContent = V.room.startsWith('call:') ? 'Call' : (r?.name || 'Voice');
    $('#call-sub').textContent = V.calling ? `Calling ${V.calling.to}…` : `${V.peers.size + 1} in call`;
    ensureTile('me', st.user, true);
    for (const [conn, p] of V.peers) ensureTile(conn, p.user, false);
    for (const key of [...V.tiles.keys()]) if (key !== 'me' && !V.peers.has(key)) { V.tiles.get(key).remove(); V.tiles.delete(key); }
    for (const key of V.tiles.keys()) updateTile(key);
    renderCallBar();
  }

  function renderCallBar() {
    $('#vbar').innerHTML = `
      <button class="vbtn ${V.muted ? 'off' : ''}" data-act="mic" title="${V.muted ? 'Unmute' : 'Mute'}">${V.muted ? ICON.micOff : ICON.mic}</button>
      <button class="vbtn ${V.deaf ? 'off' : ''}" data-act="deaf" title="${V.deaf ? 'Undeafen' : 'Deafen'}">${V.deaf ? ICON.spkOff : ICON.spk}</button>
      <button class="vbtn ${V.camTrack ? 'live' : ''}" data-act="cam" title="Camera">${V.camTrack ? ICON.cam : ICON.camOff}</button>
      <button class="vbtn ${V.screen ? 'live' : ''}" data-act="screen" title="${V.screen ? 'Stop sharing' : 'Share your screen'}">${ICON.screen}</button>
      <button class="vbtn leave" data-act="leave" title="Leave">${ICON.hangup}</button>`;
  }

  // ── calls (ringing)
  let toneTimer = 0;
  function startTone() {
    stopTone();
    const beep = () => {
      try {
        V.ctx ||= new AudioContext();
        const o = V.ctx.createOscillator();
        const g = V.ctx.createGain();
        o.type = 'sine';
        o.connect(g); g.connect(V.ctx.destination);
        const t = V.ctx.currentTime;
        o.frequency.setValueAtTime(660, t);
        o.frequency.setValueAtTime(880, t + 0.18);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.12, t + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
        o.start(t); o.stop(t + 0.45);
      } catch { /* silent */ }
    };
    beep();
    toneTimer = setInterval(beep, 1600);
  }
  function stopTone() { clearInterval(toneTimer); toneTimer = 0; }

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
    if (st.rings.size === 1) startTone();
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
      renderCall();
    });
  }

  function callUser(name, video) {
    if (V.room) { send({ t: 'call_invite', room: V.room, to: name }); toast(`Invited ${name}`); return; }
    send({ t: 'call', to: name, video: !!video });
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
    if (st.ready) { st.unread.delete(st.current); updateBadge(); renderRooms(); renderDms(); renderMsgs(); }
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
    $('#vbar').addEventListener('click', async (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      switch (b.dataset.act) {
        case 'mic': V.muted = !V.muted; applyMute(); break;
        case 'deaf': V.deaf = !V.deaf; applyMute(); break;
        case 'cam': if (V.camTrack) stopCamera(); else await startCamera(); break;
        case 'screen': if (V.screen) stopScreen(); else await startScreen(); break;
        case 'leave': leaveVoice(); break;
        default: break;
      }
    });

    // composer
    const input = $('#chat-input');
    const fit = () => { input.style.height = 'auto'; input.style.height = `${Math.min(140, input.scrollHeight)}px`; };
    input.addEventListener('input', () => {
      fit();
      if (Date.now() - st.lastTypingSent > 2500) { st.lastTypingSent = Date.now(); send({ t: 'typing', room: st.current }); }
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#composer').requestSubmit(); }
    });
    $('#composer').addEventListener('submit', (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text || !st.ready) return;
      send({ t: 'msg', room: st.current, text });
      input.value = ''; fit();
    });

    initTs();
    setMode('login');
    if (st.token && st.base) { st.wantOnline = true; resume(); }
  }

  return { init, onShow, state: st };
})();
