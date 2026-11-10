// End-to-end test of the in-app updater against a mock GitHub release API (Node 22+, no dependencies).
//   node installer/tests/update-e2e.mjs <nexus.exe> <Nexus-Setup.exe> <work-dir>
// Runs a throw-away Nexus instance (own data folder + web view profile). The "update" is installed
// into <work-dir>/installed with --no-stop --no-shortcuts --no-registry, so nothing on this PC is touched.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const [nexusExe, setupExe, work] = process.argv.slice(2);
if (!nexusExe || !setupExe || !work) { console.log('usage: node update-e2e.mjs <nexus.exe> <Nexus-Setup.exe> <work-dir>'); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, l) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${l}`); if (!c) failed++; };

const setup = readFileSync(setupExe);
const goodSum = createHash('sha256').update(setup).digest('hex');
let badChecksum = false;
const API = 8099;
const srv = createServer((req, res) => {
  const base = `http://127.0.0.1:${API}`;
  if (req.url === '/latest') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      tag_name: 'v9.9.9', html_url: `${base}/release`, body: '## Mock release\n- everything is better',
      assets: [
        { name: 'Nexus-Setup-v9.9.9.exe', browser_download_url: `${base}/dl/Nexus-Setup-v9.9.9.exe`, size: setup.length },
        { name: 'SHA256SUMS.txt', browser_download_url: `${base}/dl/SHA256SUMS.txt`, size: 100 },
      ],
    }));
  } else if (req.url === '/dl/Nexus-Setup-v9.9.9.exe') {
    res.setHeader('content-length', setup.length);
    res.end(setup);
  } else if (req.url === '/dl/SHA256SUMS.txt') {
    res.end(`${badChecksum ? '0'.repeat(64) : goodSum}  Nexus-Setup-v9.9.9.exe\n`);
  } else { res.statusCode = 404; res.end(); }
}).listen(API, '127.0.0.1');

const installed = join(work, 'installed');
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const PORT = 9557;
const env = {
  ...process.env,
  NEXUS_UPDATE_API: `http://127.0.0.1:${API}/latest`,
  NEXUS_UPDATE_ARGS: `/S --dir ${installed} --no-shortcuts --no-registry --no-stop`,
  NEXUS_DATA_DIR: join(work, 'data'),
  WEBVIEW2_USER_DATA_FOLDER: join(work, 'wv2'),
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
};
const app = spawn(nexusExe, [], { env, stdio: 'ignore' });
await sleep(10000);

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const ev = (expr) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } })); }).then((r) => r.result?.result?.value);

console.log('app version:', await ev(`window.__TAURI__.core.invoke('app_version')`));
const info = await ev(`window.__TAURI__.core.invoke('check_update')`);
ok(info?.available === true && info.latest === '9.9.9', `update check sees the new release (${info?.current} -> ${info?.latest})`);
await sleep(9000);
ok(await ev(`!document.querySelector('#update-bar').hidden && document.querySelector('#ub-title').textContent.includes('9.9.9')`), 'the app shows the update banner');

// 1) tampered download is refused
badChecksum = true;
const bad = await ev(`window.__TAURI__.core.invoke('install_update').then(()=>'started', e=>String(e))`);
ok(/damaged|checksum/i.test(bad), `a download with a wrong checksum is refused (${bad})`);
await sleep(1500);
ok(!existsSync(join(installed, 'nexus.exe')), 'nothing was installed after the refused download');

// 2) real update through the banner button
badChecksum = false;
await ev(`document.querySelector('#ub-install').click(); 1`);
for (let i = 0; i < 40 && !existsSync(join(installed, 'nexus.exe')); i++) await sleep(500);
ok(existsSync(join(installed, 'nexus.exe')) && existsSync(join(installed, 'nexus-server.exe')), 'the installer ran silently and installed the files');
await sleep(3000);
const alive = await new Promise((r) => { try { process.kill(app.pid, 0); r(true); } catch { r(false); } });
ok(!alive, 'Nexus quit itself so the installer can replace it');
ws.close(); srv.close();
try { app.kill(); } catch { /* gone */ }
console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
