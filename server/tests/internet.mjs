// Checks the "play across networks" features of nexus-server (Node 22+, no dependencies):
// invite codes, TURN relay (real STUN/TURN allocation with the credentials handed out in `welcome`).
//   node tests/internet.mjs <path-to-nexus-server.exe> <lan-ip>
import { spawn } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [exe, lan] = process.argv.slice(2);
if (!exe || !lan) { console.log('usage: node tests/internet.mjs <nexus-server.exe> <lan-ip>'); process.exit(2); }
const HTTP = 7791, TURN = 3490, INVITE = 'TESTCODE';
let failed = 0;
const ok = (c, l) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${l}`); if (!c) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const data = mkdtempSync(join(tmpdir(), 'nexus-net-'));
const srv = spawn(exe, ['--bind', `0.0.0.0:${HTTP}`, '--data', data, '--turn', '--turn-port', String(TURN),
  '--relay-min', '49300', '--relay-max', '49320', '--public-ip', lan, '--invite', INVITE], { stdio: 'ignore' });
await sleep(1500);

const post = async (path, body, host = '127.0.0.1') => {
  const r = await fetch(`http://${host}:${HTTP}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

try {
  // ── invite code
  const h = await (await fetch(`http://127.0.0.1:${HTTP}/api/health`)).json();
  ok(h.invite === true, 'health tells that an invite code is required');
  let r = await post('/api/register', { username: 'nobody', password: 'secret1' });
  ok(r.status === 403, 'registration without invite code is refused');
  r = await post('/api/register', { username: 'nobody', password: 'secret1', invite: 'WRONG' });
  ok(r.status === 403, 'registration with a wrong invite code is refused');
  r = await post('/api/register', { username: 'somebody', password: 'secret1', invite: INVITE });
  ok(r.status === 200 && r.json.token, 'registration with the right invite code works');
  const login = await post('/api/login', { username: 'somebody', password: 'secret1' });
  ok(login.status === 200, 'login needs no invite code');

  // ── ICE servers depend on how the client reaches the server
  const iceFor = async (host) => {
    const ws = new WebSocket(`ws://${host}:${HTTP}/ws?token=${login.json.token}`);
    const msg = await new Promise((res, rej) => { ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.t === 'welcome') res(m); }; ws.onerror = rej; });
    ws.close();
    return msg.ice;
  };
  const iceLocal = await iceFor('127.0.0.1');
  ok(!JSON.stringify(iceLocal).includes('turn:'), 'local clients get no relay entry');
  const iceLan = await iceFor(lan);
  const turnEntry = iceLan.find((s) => s.username);
  ok(turnEntry && turnEntry.urls.some((u) => u === `turn:${lan}:${TURN}?transport=udp`), 'remote clients get the relay address they connected to');

  // ── real STUN + TURN allocation against the relay
  const sock = createSocket('udp4');
  const request = (msg) => new Promise((res) => { sock.once('message', (m) => res(m)); sock.send(msg, TURN, lan); setTimeout(() => res(null), 2500); });
  const MAGIC = 0x2112a442;
  const header = (type, len, tid) => { const b = Buffer.alloc(20); b.writeUInt16BE(type, 0); b.writeUInt16BE(len, 2); b.writeUInt32BE(MAGIC, 4); tid.copy(b, 8); return b; };
  const attr = (type, val) => { const pad = (4 - (val.length % 4)) % 4; const b = Buffer.alloc(4 + val.length + pad); b.writeUInt16BE(type, 0); b.writeUInt16BE(val.length, 2); val.copy(b, 4); return b; };
  const parse = (m) => { const out = {}; let o = 20; while (o + 4 <= m.length) { const t = m.readUInt16BE(o), l = m.readUInt16BE(o + 2); out[t] = m.subarray(o + 4, o + 4 + l); o += 4 + l + ((4 - (l % 4)) % 4); } return out; };

  const binding = await request(header(0x0001, 0, randomBytes(12)));
  ok(binding && binding.readUInt16BE(0) === 0x0101, 'STUN binding request is answered');

  const transport = attr(0x0019, Buffer.from([17, 0, 0, 0]));
  const first = await request(Buffer.concat([header(0x0003, transport.length, randomBytes(12)), transport]));
  const a1 = first ? parse(first) : {};
  ok(first && first.readUInt16BE(0) === 0x0113 && a1[0x0014] && a1[0x0015], 'TURN asks for authentication (401 with realm and nonce)');
  const realm = a1[0x0014].toString(), nonce = a1[0x0015];

  const authed = async (user, pass) => {
    const body = Buffer.concat([transport, attr(0x0006, Buffer.from(user)), attr(0x0014, Buffer.from(realm)), attr(0x0015, nonce)]);
    const tid = randomBytes(12);
    const key = createHash('md5').update(`${user}:${realm}:${pass}`).digest();
    const h1 = header(0x0003, body.length + 24, tid);
    const mac = createHmac('sha1', key).update(Buffer.concat([h1, body])).digest();
    const msg = Buffer.concat([h1, body, attr(0x0008, mac)]);
    return request(msg);
  };
  const good = await authed(turnEntry.username, turnEntry.credential);
  ok(good && good.readUInt16BE(0) === 0x0103 && parse(good)[0x0016], 'TURN allocates a relay with the credentials from the server');
  const bad = await authed(turnEntry.username, 'not-the-password');
  ok(!bad || bad.readUInt16BE(0) !== 0x0103, 'TURN refuses wrong credentials');
  sock.close();
} finally {
  srv.kill();
}
console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
