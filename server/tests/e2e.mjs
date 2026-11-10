// End-to-end smoke test for nexus-server (Node 22+, no dependencies).
//   node tests/e2e.mjs [http://127.0.0.1:7777]
const BASE = process.argv[2] || 'http://127.0.0.1:7777';
const WS = BASE.replace(/^http/, 'ws');
let failed = 0;
const ok = (cond, label) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = async (path, body) => {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

function client(token) {
  const ws = new WebSocket(`${WS}/ws?token=${token}`);
  const c = { ws, inbox: [], send: (o) => ws.send(JSON.stringify(o)) };
  ws.onmessage = (e) => c.inbox.push(JSON.parse(e.data));
  c.open = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  c.wait = async (pred, ms = 3000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const i = c.inbox.findIndex(pred);
      if (i >= 0) return c.inbox.splice(i, 1)[0];
      await sleep(25);
    }
    return null;
  };
  return c;
}

const suffix = Math.random().toString(36).slice(2, 7);
const A = `alice_${suffix}`;
const B = `bob_${suffix}`;

// ── accounts
let r = await post('/api/register', { username: 'x', password: 'secret1' });
ok(r.status === 400, 'rejects invalid username');
r = await post('/api/register', { username: A, password: '123' });
ok(r.status === 400, 'rejects short password');
const ra = await post('/api/register', { username: A, password: 'secret1' });
ok(ra.status === 200 && ra.json.token, 'registers user A');
r = await post('/api/register', { username: A.toUpperCase(), password: 'secret1' });
ok(r.status === 409, 'usernames are unique (case-insensitive)');
const rb = await post('/api/register', { username: B, password: 'secret2' });
ok(rb.status === 200, 'registers user B');
r = await post('/api/login', { username: A, password: 'wrong-pass' });
ok(r.status === 401, 'wrong password is rejected');
const la = await post('/api/login', { username: A, password: 'secret1' });
ok(la.status === 200 && la.json.token, 'login works');
const me = await (await fetch(`${BASE}/api/me?token=${la.json.token}`)).json();
ok(me.user === A, 'token resolves to the user');

// ── websocket + chat
const bad = new WebSocket(`${WS}/ws?token=nope`);
const badRes = await new Promise((res) => { bad.onerror = () => res('error'); bad.onopen = () => res('open'); });
ok(badRes === 'error', 'websocket refuses an invalid token');

const a = client(la.json.token);
const b = client(rb.json.token);
await Promise.all([a.open, b.open]);
const wa = await a.wait((m) => m.t === 'welcome');
ok(wa && wa.you === A && wa.rooms.some((x) => x.id === 'general') && wa.ice.length > 0, 'welcome with rooms and ICE servers');
await b.wait((m) => m.t === 'welcome');
const pres = await a.wait((m) => m.t === 'presence' && m.users.filter((u) => u.online).length >= 2);
ok(!!pres, 'presence shows both users online');

a.send({ t: 'msg', room: 'general', text: 'hello from alice' });
const gm = await b.wait((m) => m.t === 'msg' && m.room === 'general');
ok(gm && gm.msg.from === A && gm.msg.text === 'hello from alice', 'public chat message reaches other user');

a.send({ t: 'dm', to: B });
const dmA = await a.wait((m) => m.t === 'dm_room');
const dmB = await b.wait((m) => m.t === 'dm_room');
ok(dmA && dmB && dmA.room.with === B && dmB.room.with === A, 'direct message room is created for both');
a.send({ t: 'msg', room: dmA.room.id, text: 'psst' });
const dm = await b.wait((m) => m.t === 'msg' && m.room === dmA.room.id);
ok(dm && dm.msg.text === 'psst', 'direct message is delivered');

const c3 = await post('/api/register', { username: `carol_${suffix}`, password: 'secret3' });
const c = client(c3.json.token);
await c.open;
await c.wait((m) => m.t === 'welcome');
a.send({ t: 'msg', room: dmA.room.id, text: 'should stay private' });
await sleep(300);
ok(!c.inbox.some((m) => m.t === 'msg' && m.room === dmA.room.id), 'third user does not see the DM');
c.send({ t: 'msg', room: dmA.room.id, text: 'intruder' });
await sleep(300);
ok(!a.inbox.some((m) => m.t === 'msg' && m.msg?.text === 'intruder'), 'third user cannot write into the DM');

a.send({ t: 'typing', room: 'general' });
ok(!!(await b.wait((m) => m.t === 'typing' && m.from === A)), 'typing indicator is forwarded');

a.send({ t: 'create_room', name: 'Raid Night', kind: 'voice' });
const rooms = await b.wait((m) => m.t === 'rooms' && m.rooms.some((x) => x.name === 'Raid Night'));
ok(!!rooms, 'new rooms are broadcast');

// ── history survives a reconnect
const a2 = client(la.json.token);
await a2.open;
await a2.wait((m) => m.t === 'welcome');
const hist = await a2.wait((m) => m.t === 'history' && m.room === 'general');
ok(hist && hist.msgs.some((x) => x.text === 'hello from alice'), 'history is replayed on reconnect');
a2.ws.close();

// ── voice rooms + signaling (two separate rooms in parallel = multiple talks)
a.send({ t: 'voice_join', room: 'lobby', video: false });
const vm = await a.wait((m) => m.t === 'voice_members');
ok(vm && vm.members.length === 0, 'first member joins an empty voice room');
b.send({ t: 'voice_join', room: 'lobby', video: true });
const vmB = await b.wait((m) => m.t === 'voice_members');
ok(vmB && vmB.members.length === 1 && vmB.members[0].user === A, 'second member sees the first');
const joined = await a.wait((m) => m.t === 'voice_joined');
ok(joined && joined.member.user === B && joined.member.video === true, 'first member is told about the new one');
const connA = vmB.members[0].conn;
const connB = joined.member.conn;
b.send({ t: 'signal', to: connA, data: { type: 'offer', sdp: 'v=0 test' } });
const sig = await a.wait((m) => m.t === 'signal');
ok(sig && sig.from === connB && sig.data.sdp === 'v=0 test', 'WebRTC signaling is forwarded inside the room');
c.send({ t: 'voice_join', room: 'gaming-1' });
await c.wait((m) => m.t === 'voice_members');
c.send({ t: 'signal', to: connA, data: { type: 'offer', sdp: 'evil' } });
await sleep(300);
ok(!a.inbox.some((m) => m.t === 'signal' && m.data?.sdp === 'evil'), 'signaling is blocked between different rooms');
const vr = await a.wait((m) => m.t === 'voice_rooms' && m.rooms['lobby']?.length === 2 && m.rooms['gaming-1']?.length === 1);
ok(!!vr, 'two voice rooms are active at the same time');
b.send({ t: 'voice_state', muted: true, screen: true });
const st = await a.wait((m) => m.t === 'voice_state' && m.member.user === B);
ok(st && st.member.muted === true && st.member.screen === true, 'mute and screen-share state is broadcast');

// ── calls
a.send({ t: 'voice_leave' });
b.send({ t: 'voice_leave' });
await sleep(200);
a.send({ t: 'call', to: B, video: true });
const started = await a.wait((m) => m.t === 'call_started');
const incoming = await b.wait((m) => m.t === 'call_incoming');
ok(started && incoming && incoming.from === A && incoming.video === true && incoming.room === started.room, 'call rings the other user');
a.send({ t: 'voice_join', room: started.room, video: true });
await a.wait((m) => m.t === 'voice_members');
b.send({ t: 'call_accept', room: incoming.room });
b.send({ t: 'voice_join', room: incoming.room, video: true });
const bm = await b.wait((m) => m.t === 'voice_members');
ok(bm && bm.members.length === 1, 'callee joins the call room');
a.send({ t: 'call', to: `nobody_${suffix}`, video: false });
ok(!!(await a.wait((m) => m.t === 'error')), 'calling an unknown user returns an error');

b.ws.close();
const left = await a.wait((m) => m.t === 'voice_left');
ok(!!left, 'leaving (disconnect) frees the call slot');

const health = await (await fetch(`${BASE}/api/health`)).json();
ok(health.ok && health.users >= 3, 'health endpoint');

console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
