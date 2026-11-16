/* PWA 自检：node test/test_pwa.mjs [baseUrl]
 * 检查 manifest 能否解析、图标能否取到、Service Worker 能否注册、页面功能是否正常。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = (process.argv[2] || 'http://127.0.0.1:8756').replace(/\/$/, '') + '/';
const PORT = 9337;

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}  ${detail}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), 'at-pwa-'));
const proc = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--force-device-scale-factor=1', '--window-size=1280,880',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank',
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
await send('Network.enable');

const errors = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Runtime.exceptionThrown') {
    errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  }
});

console.log(`\n== 打开 ${BASE} ==`);
await send('Page.navigate', { url: BASE });
await sleep(3500);

// 1. 页面基本可用
const api = await evaluate(`({
  hasAT: typeof window.__AT === 'object' && window.__AT !== null,
  secure: window.isSecureContext,
  title: document.title,
  recBtn: !!document.getElementById('recBtn'),
})`);
check('页面 JS 初始化完成', api.hasAT === true);
check('安全上下文（麦克风可用）', api.secure === true);
check('录音按钮存在', api.recBtn === true);
check('标题正确', /挂电/.test(api.title || ''), api.title);

// 2. manifest
const mf = await send('Page.getAppManifest');
const mfData = (() => { try { return JSON.parse(mf.data || '{}'); } catch (_) { return null; } })();
check('manifest 可解析', !!mfData && mfData.name != null, (mf.errors || []).map((e) => e.message).join('; '));
if (mfData) {
  check('manifest name', /挂电/.test(mfData.name || ''), mfData.name);
  check('display 为 standalone', mfData.display === 'standalone', mfData.display);
  check('声明了 2 个图标', (mfData.icons || []).length >= 2, `实得 ${(mfData.icons || []).length}`);
}

// 3. 图标可访问
for (const size of [192, 512]) {
  const r = await fetch(`${BASE}assets/icon-${size}.png`);
  const buf = Buffer.from(await r.arrayBuffer());
  const ok = r.ok && buf.length > 1000 && buf.readUInt32BE(16) === size;
  check(`图标 icon-${size}.png 可取到且尺寸正确`, ok, `HTTP=${r.status} 字节=${buf.length}`);
}

// 4. Service Worker
const sw = await evaluate(`(async () => {
  if (!('serviceWorker' in navigator)) return { supported: false };
  const reg = await navigator.serviceWorker.getRegistration();
  if (reg) await navigator.serviceWorker.ready;
  return {
    supported: true,
    scope: reg ? reg.scope : null,
    active: reg ? !!(reg.active || reg.installing || reg.waiting) : false,
  };
})()`);
check('Service Worker 已注册', sw.supported && sw.active === true, JSON.stringify(sw));

// 5. 通过 SW 之后再取一次页面（缓存可用）
await sleep(800);
const cached = await evaluate(`(async () => {
  const r = await fetch('./index.html', { cache: 'no-store' });
  return { ok: r.ok, len: (await r.text()).length };
})()`);
check('Service Worker 代理下页面仍可加载', cached.ok && cached.len > 10000, JSON.stringify(cached));

// 6. 离线兜底：断网后仍能拿到页面
await send('Network.emulateNetworkConditions', {
  offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
});
await sleep(300);
const offline = await evaluate(`(async () => {
  try {
    const r = await fetch('./index.html');
    return { ok: r.ok, len: (await r.text()).length };
  } catch (e) { return { ok: false, err: e.message }; }
})()`);
check('断网后仍能从缓存取到页面', offline.ok && offline.len > 10000, JSON.stringify(offline));
await send('Network.emulateNetworkConditions', {
  offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
});

// 7. 快捷方式参数
const shortcut = await evaluate(`(async () => {
  const before = document.querySelectorAll('#presets button.on').length;
  return { presetButtons: document.querySelectorAll('#presets button').length, before };
})()`);
check('预设按钮渲染正常', shortcut.presetButtons >= 6, JSON.stringify(shortcut));

check('无未捕获的 JS 异常', errors.length === 0, errors.slice(0, 2).join(' | '));

console.log(`\n结果：${pass} 通过，${fail} 失败\n`);

ws.close();
proc.kill();
await sleep(400);
try { rmSync(profile, { recursive: true, force: true }); } catch (e) {}
process.exit(fail === 0 ? 0 : 1);
