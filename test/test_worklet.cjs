/* 模拟 AudioWorklet 环境，验证实时流式处理链路：node test/test_worklet.cjs */
const fs = require('fs');
const path = require('path');

const SR = 44100;
const BLK = 128;

// ---- 伪造 worklet 全局环境 ----
const registered = {};
const posts = [];

class FakePort {
  constructor() { this.onmessage = null; this._q = []; }
  postMessage(msg, transfer) { posts.push(msg); if (name2cb[this._tag]) name2cb[this._tag](msg); }
}
const name2cb = {};

globalThis.sampleRate = SR;
globalThis.AudioWorkletProcessor = class {
  constructor() { this.port = new FakePort(); }
};
globalThis.registerProcessor = (name, cls) => { registered[name] = cls; };

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'dsp.js'), 'utf8');
(0, eval)(src);

let ok = true;
function check(name, cond, detail) {
  ok = ok && !!cond;
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}  ${detail || ''}`);
}

// ============================================================ 1. 处理器注册
console.log('\n== 1. AudioWorklet 处理器注册 ==');
check('注册了 autotune', typeof registered.autotune === 'function');
check('注册了 recorder', typeof registered.recorder === 'function');

// ============================================================ 2. 实时链路
console.log('\n== 2. 实时链路（1024 帧 / 256 跳）==');

function runProcessor(nFft, hop, input, params) {
  const p = new registered.autotune({ processorOptions: { nFft, hop, params } });
  const out = new Float32Array(input.length);
  for (let pos = 0; pos + BLK <= input.length; pos += BLK) {
    const inp = input.subarray(pos, pos + BLK);
    const outCh = new Float32Array(BLK);
    p.process([[inp]], [[outCh]]);
    out.set(outCh, pos);
  }
  return out;
}

function peakFreq(x) {
  const N = 1 << 17;
  const D = globalThis.ATDSP;
  const t = D.makeFFT(N);
  const re = new Float64Array(N), im = new Float64Array(N);
  const n = Math.min(x.length, N);
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
    re[i] = x[i] * w;
  }
  D.fft(t, re, im, false);
  let best = -1, bk = 0;
  for (let k = 1; k < N / 2; k++) {
    const m = re[k] * re[k] + im[k] * im[k];
    if (m > best) { best = m; bk = k; }
  }
  const mag = (k) => Math.hypot(re[k], im[k]);
  const a = mag(bk - 1), b = mag(bk), c = mag(bk + 1);
  const den = a - 2 * b + c;
  const d = Math.abs(den) > 1e-12 ? 0.5 * (a - c) / den : 0;
  return (bk + d) * SR / N;
}

// 输入：226Hz，落在 G#3(207.65) 与 A3(220) 之间偏上，应吸回 A3=220Hz
const freqIn = 226.0;
const silence = Math.floor(SR * 0.3);
const dur = Math.floor(SR * 1.7);
const input = new Float32Array(dur);
for (let i = silence; i < dur; i++) {
  input[i] = 0.4 * Math.sin(2 * Math.PI * freqIn * (i - silence) / SR);
}

const params = { key: 9, scale: 'chromatic', amount: 1, retuneMs: 0, octave: 0, maxShift: 6 };
const out = runProcessor(1024, 256, input, params);

check('输出长度与输入一致', out.length === input.length, `${out.length}`);
check('有输出信号', Math.max(...out.subarray(20000, 40000).map(Math.abs)) > 0.05);

// 延迟：用载入点估计
const onset = (x) => { for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > 0.02) return i; return -1; };
const lag = onset(out) - onset(input);
check('处理延迟约等于 nFft', lag >= 900 && lag <= 2600, `实测 ${lag} 采样 ≈ ${(lag / SR * 1000).toFixed(1)}ms`);

const measured = peakFreq(out.subarray(30000, dur - 2000));
const errC = 1200 * Math.log2(measured / 220.0);
check('实时模式把 226Hz 吸到 A3(220Hz)', Math.abs(errC) < 25,
  `实测 ${measured.toFixed(1)}Hz, 相对 220Hz 偏差 ${errC.toFixed(1)} 音分`);

// ============================================================ 3. 参数热更新
console.log('\n== 3. 参数热更新（录音中改调性）==');
const p2 = new registered.autotune({
  processorOptions: { nFft: 1024, hop: 256, params: { ...params, key: 0, scale: 'major' } },
});
const o2 = new Float32Array(BLK);
p2.process([[input.subarray(0, BLK)]], [[o2]]);
p2.port.onmessage({ data: { type: 'params', params: { key: 9, scale: 'chromatic', amount: 0.5, retuneMs: 20 } } });
check('收到参数更新不报错', p2.tuner.amount === 0.5 && p2.tuner.retuneMs === 20,
  `amount=${p2.tuner.amount} retune=${p2.tuner.retuneMs} key=${p2.tuner.key}`);

// ============================================================ 4. 静音 / 断流
console.log('\n== 4. 边界情况 ==');
const p3 = new registered.autotune({ processorOptions: { nFft: 1024, hop: 256, params } });
let allZero = true;
for (let i = 0; i < 200; i++) {
  const o = new Float32Array(BLK);
  p3.process([[new Float32Array(BLK)]], [[o]]);
  for (let k = 0; k < BLK; k++) if (Math.abs(o[k]) > 1e-4) allZero = false;
}
check('静音输入输出静音', allZero);

// 没有输入（麦克风断开）
const p4 = new registered.autotune({ processorOptions: { nFft: 1024, hop: 256, params } });
let threw = false;
try {
  for (let i = 0; i < 50; i++) {
    const o = new Float32Array(BLK);
    p4.process([[]], [[o]]);
  }
} catch (e) { threw = true; }
check('输入断开不崩', !threw);

// ============================================================ 5. 录音器
console.log('\n== 5. Recorder 处理器 ==');
const rec = new registered.recorder();
const collected = [];
rec.port.postMessage = (m) => collected.push(m);
const total = BLK * 300;            // 38400 采样 > 16384 阈值
const src2 = new Float32Array(BLK);
for (let i = 0; i < BLK; i++) src2[i] = Math.sin(i / 10);
for (let i = 0; i < 300; i++) rec.process([[src2]]);
rec.port.onmessage({ data: 'stop' });

const chunks = collected.filter((m) => m.type === 'chunk');
const doneMsg = collected.filter((m) => m.type === 'done');
let samples = 0;
for (const c of chunks) samples += c.data.length;
check('录音分块回传', chunks.length >= 2, `${chunks.length} 块`);
check('采样数完整', samples === total, `${samples} / ${total}`);
check('结束信号已发送', doneMsg.length === 1);

// ============================================================ 6. 长时序不溢出
console.log('\n== 6. 长时序（60 秒输入）==');
const longN = SR * 60;
const p5 = new registered.autotune({ processorOptions: { nFft: 1024, hop: 256, params } });
let bad = 0;
const blk = new Float32Array(BLK);
for (let i = 0; i < BLK; i++) blk[i] = 0.3 * Math.sin(2 * Math.PI * 200 * i / SR);
for (let pos = 0; pos + BLK <= longN; pos += BLK) {
  const o = new Float32Array(BLK);
  p5.process([[blk]], [[o]]);
  for (let k = 0; k < BLK; k++) if (!Number.isFinite(o[k])) bad++;
}
check('60 秒连续处理无 NaN/Inf', bad === 0, `${bad} 个异常采样`);

console.log('\n' + (ok ? '全部通过 ✅' : '有失败项 ❌'));
process.exit(ok ? 0 : 1);
