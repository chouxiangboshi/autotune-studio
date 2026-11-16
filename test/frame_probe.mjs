/* 验证：被嵌进 iframe 时是否出现麦克风提示条，且顶层打开时不出现
   node test/frame_probe.mjs   （需先起 http 服务，脚本自己会起）
*/
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9336;
const HTTP = 8759;
const BASE = `http://127.0.0.1:${HTTP}`;

const py = spawn('C:\\Users\\TX\\AppData\\Local\\Programs\\Python\\Python313\\python.exe',
  ['-m', 'http.server', String(HTTP), '--bind', '127.0.0.1'],
  { stdio: 'ignore', cwd: 'D:/workbuddy-workspace/autotune' });

const profile = mkdtempSync(join(tmpdir(), 'at-frame-'));
const proc = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--window-size=1280,880',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, msgId = 0;
const pending = new Map();
const events = [];

function send(method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); } }, 30000);
  });
}
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
  return r.result.value;
};

let ok = true;
const check = (name, cond, detail) => {
  ok = ok && !!cond;
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}  ${detail || ''}`);
};

try {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); break; }
    } catch (e) { /* 还没起来 */ }
    await sleep(250);
  }
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    events.push(m);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      if (m.error) p.rej(new Error(m.error.message)); else p.res(m.result);
    }
  };
  await send('Runtime.enable');
  await send('Page.enable');

  // ---- 1. 顶层打开 ----
  await send('Page.navigate', { url: `${BASE}/guadian-studio.html` });
  await sleep(2000);
  const top = await evaluate(`({
    framed: window.self !== window.top,
    tip: !!document.querySelector('.framed-tip'),
    presets: document.querySelectorAll('#presets button').length,
  })`);
  check('顶层打开不算内嵌', top.framed === false);
  check('顶层不显示提示条', top.tip === false);
  check('顶层界面正常初始化', top.presets === 6, `预设 ${top.presets} 个`);

  // ---- 2. iframe 内打开 ----
  await send('Page.navigate', { url: `${BASE}/test/frame_host.html` });
  await sleep(2500);
  const inner = await evaluate(`(() => {
    const f = document.getElementById('f');
    const d = f.contentDocument;
    const tip = d.querySelector('.framed-tip');
    return {
      hasDoc: !!d,
      tip: !!tip,
      text: tip ? tip.textContent.replace(/\\s+/g, ' ').trim() : '',
      href: tip ? tip.querySelector('a') && tip.querySelector('a').href : '',
      presets: d.querySelectorAll('#presets button').length,
      status: d.getElementById('statusText').textContent,
    };
  })()`);
  check('iframe 内出现麦克风提示条', inner.tip === true);
  check('提示里有独立窗口链接', inner.href.startsWith('https://chouxiangboshi.github.io/'), inner.href);
  check('提示文案点明原因', /内嵌预览|不允许/.test(inner.text), inner.text.slice(0, 40));
  check('iframe 内功能仍可初始化', inner.presets === 6, `预设 ${inner.presets} 个`);
  console.log('   状态栏：' + inner.status);

  console.log('\n' + (ok ? '全部通过 ✅' : '有失败项 ❌'));
} catch (e) {
  console.error('异常：', e.message);
  ok = false;
} finally {
  try { ws && ws.close(); } catch (e) {}
  try { proc.kill(); py.kill(); } catch (e) {}
  await sleep(400);
  try { rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  process.exit(ok ? 0 : 1);
}
