/* 截图：node test/shot.mjs [输出文件] */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PAGE = 'file:///D:/workbuddy-workspace/autotune/guadian-studio.html';
const PORT = 9334;
const OUT = process.argv[2] || 'D:/workbuddy-workspace/autotune/preview.png';

const profile = mkdtempSync(join(tmpdir(), 'at-shot-'));
const proc = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--force-device-scale-factor=1',
  '--window-size=1280,880',
  '--autoplay-policy=no-user-gesture-required',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, PAGE,
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
function evaluate(expression) {
  return send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
    .then((r) => {
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
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

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 880, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: PAGE });
await sleep(1500);

// 注入一段合成的「人声」：音高游走的元音，让曲线有内容
const info = await evaluate(`(async () => {
  const sr = 44100, n = sr * 6;
  const buf = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const base = 196 + 40 * Math.sin(t * 1.3) + 5 * Math.sin(t * 11);
    const f = base * (1 + 0.004 * Math.sin(t * 2 * Math.PI * 5.5));
    ph += 2 * Math.PI * f / sr;
    let v = 0;
    for (let h = 1; h <= 7; h++) v += Math.sin(h * ph) / h;
    const env = 0.5 + 0.5 * Math.sin(t * 2.2);
    buf[i] = v * 0.055 * env;
  }
  document.querySelector('#presets button[data-preset="tpain"]').click();
  await window.__AT.setDry(buf, 'demo');
  return { ok: true, len: buf.length };
})()`);
console.log('注入结果', JSON.stringify(info));
await sleep(2200);

const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
console.log('saved ->', OUT);

ws.close();
proc.kill();
await sleep(400);
try { rmSync(profile, { recursive: true, force: true }); } catch (e) {}
process.exit(0);
