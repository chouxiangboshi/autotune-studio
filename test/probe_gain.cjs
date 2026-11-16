/* 探测 DSP 链在不同输入电平下的输出电平：node test/probe_gain.cjs */
const fs = require('fs');

const SR = 44100, BLK = 128;
const registered = {};
class FakePort { constructor() { this.onmessage = null; } postMessage() {} }
globalThis.sampleRate = SR;
globalThis.AudioWorkletProcessor = class { constructor() { this.port = new FakePort(); } };
globalThis.registerProcessor = (n, c) => { registered[n] = c; };
(0, eval)(fs.readFileSync('src/dsp.js', 'utf8'));

function run(nFft, hop, input, params) {
  const p = new registered.autotune({ processorOptions: { nFft, hop, params } });
  const out = new Float32Array(input.length);
  for (let pos = 0; pos + BLK <= input.length; pos += BLK) {
    const o = new Float32Array(BLK);
    p.process([[input.subarray(pos, pos + BLK)]], [[o]]);
    out.set(o, pos);
  }
  return out;
}
const rms = (x) => { let s = 0; for (const v of x) s += v * v; return Math.sqrt(s / x.length); };
const peak = (x) => { let m = 0; for (const v of x) m = Math.max(m, Math.abs(v)); return m; };

const params = { key: 9, scale: 'chromatic', amount: 1, retuneMs: 0, octave: 0, maxShift: 6 };
for (const amp of [0.4, 0.06, 0.015]) {
  const dur = Math.floor(SR * 2), sil = Math.floor(SR * 0.3);
  const inp = new Float32Array(dur);
  for (let i = sil; i < dur; i++) inp[i] = amp * Math.sin(2 * Math.PI * 221 * (i - sil) / SR);
  const out = run(1024, 256, inp, params);
  const a = inp.subarray(SR * 0.8, SR * 1.8);
  const b = out.subarray(SR * 0.8, SR * 1.8);
  const g = 20 * Math.log10(rms(b) / rms(a));
  console.log('amp=' + String(amp).padEnd(6) + ' inRMS=' + rms(a).toFixed(4) +
    ' outRMS=' + rms(b).toFixed(4) + ' 增益=' + g.toFixed(2) + 'dB' +
    ' outPeak=' + peak(b).toFixed(3));
}
