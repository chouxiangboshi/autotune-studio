/* 从 tools/icon-src.html 生成 PWA 图标
 * 用法：node tools/make-icons.mjs
 * 产出：assets/icon-192.png、assets/icon-512.png
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ROOT = 'D:/workbuddy-workspace/autotune';
const PAGE = 'file:///' + ROOT + '/tools/icon-src.html';
const OUTDIR = ROOT + '/assets';
const PORT = 9336;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUTDIR, { recursive: true });

const profile = mkdtempSync(join(tmpdir(), 'at-icon-'));
const proc = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--force-device-scale-factor=1',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, PAGE,
], { stdio: 'ignore' });

let ws, msgId = 0;
const pending = new Map();
function send(method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); } }, 30000);
  });
}

let list;
for (let i = 0; i < 40; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    list = await r.json();
    if (list.some((p) => p.type === 'page')) break;
  } catch (e) {}
  await sleep(250);
}
const page = list.find((p) => p.type === 'page');
ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
  }
};

await send('Page.enable');
await send('Runtime.enable');

for (const size of [192, 512]) {
  await send('Emulation.setDeviceMetricsOverride', {
    width: size, height: size, deviceScaleFactor: 1, mobile: false,
  });
  await sleep(350);
  const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  const buf = Buffer.from(shot.data, 'base64');
  const out = `${OUTDIR}/icon-${size}.png`;
  writeFileSync(out, buf);
  // 读 PNG 头校验尺寸
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  console.log(`${out}  ${w}x${h}  ${(buf.length / 1024).toFixed(1)} KB`);
  if (w !== size || h !== size) throw new Error(`尺寸不符：期望 ${size}，实得 ${w}x${h}`);
}

ws.close();
proc.kill();
await sleep(400);
try { rmSync(profile, { recursive: true, force: true }); } catch (e) {}
console.log('图标生成完成');
process.exit(0);
