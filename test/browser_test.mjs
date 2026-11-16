/* 真浏览器端到端测试：用 Edge 无头模式跑一遍实际音频链路
 * node test/browser_test.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PAGE = 'file:///D:/workbuddy-workspace/autotune/%E6%8C%82%E7%94%B5Studio.html';
const PORT = 9333;

const profile = mkdtempSync(join(tmpdir(), 'at-edge-'));
const proc = spawn(EDGE, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--autoplay-policy=no-user-gesture-required',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  PAGE,
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws;
let msgId = 0;
const pending = new Map();
const logs = [];
const errors = [];

function send(method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }
    }, 40000);
  });
}

function evaluate(expression) {
  return send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  }).then((r) => {
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result.value;
  });
}

let ok = true;
function check(name, cond, detail) {
  ok = ok && !!cond;
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}  ${detail || ''}`);
}

async function main() {
  // 等 CDP 端口就绪
  let list = null;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      list = await r.json();
      if (list && list.some((p) => p.type === 'page')) break;
    } catch (e) { /* 还没起来 */ }
    await sleep(250);
  }
  if (!list) throw new Error('浏览器没起来');

  const page = list.find((p) => p.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message));
      else p.resolve(m.result);
    } else if (m.method === 'Runtime.consoleAPICalled') {
      logs.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
    } else if (m.method === 'Runtime.exceptionThrown') {
      errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    } else if (m.method === 'Log.entryAdded') {
      if (m.params.entry.level === 'error') errors.push(m.params.entry.text);
    }
  };

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: PAGE });
  await sleep(1800);

  console.log('\n== 1. 页面加载 ==');
  check('无 JS 异常', errors.length === 0, errors.join(' | ').slice(0, 300));

  const ui = await evaluate(`(() => {
    const q = (s) => !!document.querySelector(s);
    return {
      title: document.title,
      presets: document.querySelectorAll('#presets button').length,
      keys: document.querySelectorAll('#keys button').length,
      scales: document.querySelectorAll('#scale option').length,
      hasRec: q('#recBtn'), hasDrop: q('#dropzone'),
      hook: typeof window.__AT === 'object',
      dsp: typeof window.ATDSP === 'object',
    };
  })()`);
  check('预设按钮 6 个', ui.presets === 6, String(ui.presets));
  check('调性按钮 12 个', ui.keys === 12, String(ui.keys));
  check('音阶选项 10 个', ui.scales === 10, String(ui.scales));
  check('DSP 已载入主线程', ui.dsp === true);
  check('测试钩子可用', ui.hook === true);

  console.log('\n== 2. 离线渲染（真实 AudioWorklet）==');
  const r1 = await evaluate(`(async () => {
    const D = window.ATDSP, S = window.__AT.S;
    S.key = 9; S.scale = 'chromatic'; S.amount = 100; S.retune = 0; S.octave = 0;
    S.drive = 10; S.chorus = 15; S.echo = 10; S.reverb = 15;
    const sr = 44100, n = sr * 2;
    const buf = new Float32Array(n);
    for (let i = 0; i < n; i++) buf[i] = 0.4 * Math.sin(2 * Math.PI * 226 * i / sr);
    const t0 = performance.now();
    const wet = await window.__AT.renderOffline(buf, sr);
    const ms = performance.now() - t0;
    const seg = wet.subarray(sr * 0.5, sr * 0.5 + 4096);
    const pitch = D.yinPitch(seg, sr, 65, 900, 0.15, -60);
    let peak = 0;
    for (let i = 0; i < wet.length; i++) peak = Math.max(peak, Math.abs(wet[i]));
    let finite = true;
    for (let i = 0; i < wet.length; i++) if (!Number.isFinite(wet[i])) finite = false;
    return { len: wet.length, inLen: n, f0: pitch.f0, conf: pitch.conf, peak, ms, finite };
  })()`);

  check('渲染完成', r1 && r1.len > 0, `输出 ${r1 && r1.len} 采样 / 输入 ${r1 && r1.inLen}`);
  check('无 NaN', r1.finite === true);
  check('有电平输出', r1.peak > 0.05, `peak=${r1.peak?.toFixed(3)}`);
  const cents = 1200 * Math.log2(r1.f0 / 220);
  check('226Hz 被吸到 A3(220Hz)', Math.abs(cents) < 30,
    `实测 ${r1.f0.toFixed(1)}Hz 偏差 ${cents.toFixed(1)}音分 conf=${r1.conf?.toFixed(2)}`);
  console.log(`   整条链路（含失真/合唱/回声/混响）耗时 ${r1.ms.toFixed(0)}ms / 2s 音频`);

  console.log('\n== 3. 静音与极端参数 ==');
  const r2 = await evaluate(`(async () => {
    const S = window.__AT.S;
    S.amount = 0; S.drive = 100; S.chorus = 100; S.echo = 100; S.reverb = 100;
    const sr = 44100, n = sr;
    const buf = new Float32Array(n);
    for (let i = 0; i < n; i++) buf[i] = Math.sin(2 * Math.PI * 300 * i / sr) * 0.9;
    let out;
    try { out = await window.__AT.renderOffline(buf, sr); } catch (e) { return { err: e.message }; }
    let peak = 0, finite = true;
    for (let i = 0; i < out.length; i++) {
      if (!Number.isFinite(out[i])) finite = false;
      peak = Math.max(peak, Math.abs(out[i]));
    }
    return { peak, finite, len: out.length };
  })()`);
  check('全参数拉满不崩', !r2.err, r2.err || '');
  check('全参数拉满不产生 NaN', r2.finite === true);
  check('全参数拉满不削爆', r2.peak <= 1.02, `peak=${r2.peak?.toFixed(3)}`);

  console.log('\n== 4. 界面交互 ==');
  const r3 = await evaluate(`(async () => {
    document.querySelector('#presets button[data-preset="trap"]').click();
    const S = window.__AT.S;
    const afterPreset = {
      amount: S.amount, retune: S.retune, drive: S.drive,
      on: document.querySelectorAll('#presets button.on').length,
    };
    document.querySelector('#keys button[data-key="2"]').click();
    const sel = document.getElementById('scale');
    sel.value = 'minor_pentatonic';
    sel.dispatchEvent(new Event('change'));
    document.getElementById('amount').value = 70;
    document.getElementById('amount').dispatchEvent(new Event('input'));
    return {
      afterPreset,
      amount: S.amount, key: S.key, scale: S.scale,
      presetOnAfterTweak: document.querySelectorAll('#presets button.on').length,
      label: document.getElementById('amountV').textContent,
      keyOn: document.querySelectorAll('#keys button.on').length,
    };
  })()`);
  check('预设切换生效', r3.afterPreset.amount === 100 && r3.afterPreset.drive === 22
    && r3.afterPreset.on === 1, JSON.stringify(r3.afterPreset));
  check('调性切换生效', r3.key === 2 && r3.keyOn === 1, `key=${r3.key}`);
  check('音阶切换生效', r3.scale === 'minor_pentatonic', r3.scale);
  check('滑杆数值联动', r3.label === '70%', r3.label);
  check('手动改滑杆会取消预设高亮', r3.presetOnAfterTweak === 0 && r3.amount === 70,
    `on=${r3.presetOnAfterTweak} amount=${r3.amount}`);

  console.log('\n== 5. WAV 导出 ==');
  const r4 = await evaluate(`(async () => {
    const sr = 44100, n = sr * 1;
    const buf = new Float32Array(n);
    for (let i = 0; i < n; i++) buf[i] = 0.5 * Math.sin(2 * Math.PI * 220 * i / sr);
    const S = window.__AT.S;
    S.dry = buf; S.wet = buf; S.sr = sr;

    // 1) 直接检查导出的二进制
    const blob = window.__AT.encodeWav(buf, sr, 24);
    const ab = await blob.arrayBuffer();
    const dv = new DataView(ab);
    const tag = (o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o+1), dv.getUint8(o+2), dv.getUint8(o+3));
    const wav = {
      size: ab.byteLength,
      expect: 44 + n * 3,
      riff: tag(0), wave: tag(8), data: tag(36),
      channels: dv.getUint16(22, true),
      rate: dv.getUint32(24, true),
      bits: dv.getUint16(34, true),
    };

    // 2) 下载按钮真的触发
    const btn = document.getElementById('dlBtn');
    let clicked = null;
    const orig = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { clicked = this.download; };
    btn.click();
    HTMLAnchorElement.prototype.click = orig;

    return { wav, clicked, blobType: blob.type };
  })()`);
  check('WAV 头正确', r4.wav.riff === 'RIFF' && r4.wav.wave === 'WAVE' && r4.wav.data === 'data',
    `${r4.wav.riff}/${r4.wav.wave}/${r4.wav.data}`);
  check('WAV 长度正确', r4.wav.size === r4.wav.expect, `${r4.wav.size} = ${r4.wav.expect}`);
  check('WAV 参数正确', r4.wav.channels === 1 && r4.wav.rate === 44100 && r4.wav.bits === 24,
    `${r4.wav.channels}ch ${r4.wav.rate}Hz ${r4.wav.bits}bit`);
  check('导出触发下载', typeof r4.clicked === 'string' && r4.clicked.endsWith('.wav'), r4.clicked);

  console.log('\n== 6. 拖入文件（解码 -> 处理）==');
  const r5 = await evaluate(`(async () => {
    const sr = 44100, n = sr * 2;
    const src = new Float32Array(n);
    for (let i = 0; i < n; i++) src[i] = 0.4 * Math.sin(2 * Math.PI * 226 * i / sr);
    const blob = window.__AT.encodeWav(src, sr, 16);
    const file = new File([blob], '测试素材.wav', { type: 'audio/wav' });
    await window.__AT.loadFile(file);
    // 等渲染完成
    for (let i = 0; i < 60; i++) {
      if (window.__AT.S.wet) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    const S = window.__AT.S;
    if (!S.wet) return { err: '渲染超时' };
    const D = window.__AT.D;
    const p = D.yinPitch(S.wet.subarray(sr * 0.4, sr * 0.4 + 4096), S.sr, 65, 900, 0.15, -60);
    return {
      dryLen: S.dry.length, wetLen: S.wet.length,
      f0: p.f0, sr: S.sr,
      vizVisible: !document.getElementById('viz').hidden,
      transportVisible: !document.getElementById('transport').hidden,
      dropHidden: document.getElementById('dropzone').hidden,
      status: document.getElementById('statusText').textContent,
    };
  })()`);
  check('文件解码成功', r5.dryLen === 88200, `${r5.dryLen} / 88200`);
  check('处理产生结果', r5.wetLen > 88200, `${r5.wetLen}`);
  check('界面切到结果态', r5.vizVisible && r5.transportVisible && r5.dropHidden === true);
  const c2 = 1200 * Math.log2(r5.f0 / 220);
  check('文件路径同样修到 A3', Math.abs(c2) < 30, `${r5.f0?.toFixed(1)}Hz 偏差 ${c2.toFixed(1)}音分`);
  console.log('   状态栏：' + r5.status);

  if (errors.length) {
    console.log('\n浏览器错误：');
    for (const e of errors.slice(0, 8)) console.log('  - ' + String(e).slice(0, 200));
  }

  console.log('\n' + (ok && errors.length === 0 ? '全部通过 ✅' : '有失败项 ❌'));
  return ok && errors.length === 0;
}

let code = 1;
try {
  const pass = await main();
  code = pass ? 0 : 1;
} catch (e) {
  console.error('测试异常：', e.message);
  code = 1;
} finally {
  try { ws && ws.close(); } catch (e) {}
  try { proc.kill(); } catch (e) {}
  await new Promise((r) => setTimeout(r, 400));
  try { rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  process.exit(code);
}
