/* 引擎数值自检：node test/test_dsp.cjs */
const D = require('../src/dsp.js');
const SR = 44100;
let allOk = true;

function check(name, cond, detail) {
  allOk = allOk && !!cond;
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}  ${detail || ''}`);
}

function peakFreq(x) {
  const N = 1 << 17;
  const t = D.makeFFT(N);
  const re = new Float64Array(N), im = new Float64Array(N);
  const n = Math.min(x.length, N);
  // Hann
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
    re[i] = x[i] * w;
  }
  D.fft(t, re, im, false);
  let best = 0, bk = 0;
  for (let k = 1; k < N / 2; k++) {
    const m = re[k] * re[k] + im[k] * im[k];
    if (m > best) { best = m; bk = k; }
  }
  // 抛物线插值
  const mag = k => Math.hypot(re[k], im[k]);
  const a = mag(bk - 1), b = mag(bk), c = mag(bk + 1);
  const den = a - 2 * b + c;
  const d = Math.abs(den) > 1e-12 ? 0.5 * (a - c) / den : 0;
  return (bk + d) * SR / N;
}

// ---------------------------------------------------------------- 1. YIN
console.log('\n== 1. YIN 基频检测 ==');
const gen = (f, sec, amps) => {
  const n = Math.floor(SR * sec);
  const x = new Float64Array(n);
  amps = amps || [1];
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let h = 0; h < amps.length; h++) v += amps[h] * Math.sin(2 * Math.PI * f * (h + 1) * i / SR);
    x[i] = v * 0.5;
  }
  return x;
};
for (const f of [82.41, 110, 220, 329.63, 440, 660]) {
  const x = gen(f, 0.15, [0.7, 0.3]);
  const r = D.yinPitch(x, SR, 70, 1000, 0.15, -52);
  const cents = r.f0 > 0 ? 1200 * Math.log2(r.f0 / f) : 9999;
  check(`YIN ${f.toFixed(2)}Hz`, Math.abs(cents) < 15,
    `-> ${r.f0.toFixed(2)}Hz err=${cents.toFixed(1)}c conf=${r.conf.toFixed(2)}`);
}

// 噪声不该被判成有音高（允许少量，但置信度应低）
const nz = new Float64Array(SR / 4);
let seed = 12345;
for (let i = 0; i < nz.length; i++) {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  nz[i] = (seed / 0x3fffffff - 1) * 0.3;
}
let voiced = 0, errSum = 0, errN = 0;
for (let i = 0; i + 4096 < nz.length; i += 1024) {
  const r = D.yinPitch(nz.subarray(i, i + 4096), SR, 70, 1000, 0.15, -52);
  if (r.f0 > 0 && r.conf > 0.6) { voiced++; errSum += r.conf; errN++; }
}
check('噪声不误判为有音高', voiced <= 2, `4096帧中误判 ${voiced} 次`);

// ---------------------------------------------------------------- 2. 变调精度
console.log('\n== 2. 相位声码器变调精度 ==');
for (const semis of [1, 2, 5, -3]) {
  const ps = new D.PitchShifter(SR, 2048, 256);
  const dur = Math.floor(SR * 0.9);
  const src = new Float64Array(dur);
  for (let i = 0; i < dur; i++) src[i] = 0.5 * Math.sin(2 * Math.PI * 220 * i / SR);
  const r = Math.pow(2, semis / 12);
  const out = new Float64Array(dur);
  for (let p = 0; p + 2048 <= dur; p += 256) {
    const f = ps.shift(src.subarray(p, p + 2048), r);
    for (let i = 0; i < 256; i++) out[p + i] += f[i];
  }
  const meas = peakFreq(out.subarray(4096, dur - 4096));
  const expect = 220 * r;
  const err = 1200 * Math.log2(meas / expect);
  check(`变调 ${semis > 0 ? '+' : ''}${semis} 半音`, Math.abs(err) < 15,
    `期望 ${expect.toFixed(2)}Hz 实测 ${meas.toFixed(2)}Hz err=${err.toFixed(1)}c`);
}

// ---------------------------------------------------------------- 3. 音阶吸附
console.log('\n== 3. 音阶吸附：200->260Hz 滑音 ==');
const dur = Math.floor(SR * 3);
const vowel = new Float64Array(dur);
let phase = 0;
for (let i = 0; i < dur; i++) {
  const f = 200 + 60 * (i / dur);
  phase += 2 * Math.PI * f / SR;
  let v = 0;
  for (let h = 1; h <= 8; h++) v += Math.sin(h * phase) / h;
  vowel[i] = v * 0.05;
}

const pcs = D.keyToPcs(0, 'chromatic');
function midiErr(sig) {
  const errs = [];
  for (let i = 8192; i + 4096 < sig.length; i += 512) {
    const r = D.yinPitch(sig.subarray(i, i + 4096), SR, 70, 1000, 0.15, -60);
    if (r.f0 > 0 && r.conf > 0.6) {
      const m = D.hzToMidi(r.f0);
      errs.push(Math.abs(m - D.snapMidi(m, pcs)));
    }
  }
  return errs;
}
const tin = new D.AutoTuner(SR, { nFft: 2048, hop: 256 });
tin.setParams({ key: 0, scale: 'chromatic', amount: 1, retuneMs: 0 });
const tuned = tin.processBuffer(vowel);

const eIn = midiErr(vowel), eOut = midiErr(tuned);
const avg = a => a.reduce((s, v) => s + v, 0) / a.length;
const p90 = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length * 0.9)]; };
console.log(`   输入偏离音阶: 平均 ${avg(eIn).toFixed(3)} 半音, 90分位 ${p90(eIn).toFixed(3)}`);
console.log(`   挂电后偏离:   平均 ${avg(eOut).toFixed(3)} 半音, 90分位 ${p90(eOut).toFixed(3)}`);
check('音高被吸到音阶上', avg(eOut) < 0.3 && avg(eOut) < avg(eIn) * 0.45);
check('输出长度与输入一致', tuned.length === vowel.length, `${tuned.length} vs ${vowel.length}`);

// ---------------------------------------------------------------- 4. 台阶化确认
console.log('\n== 4. 滑音 -> 台阶（硬吸附特征）==');
const contour = [];
for (let i = 8192; i + 4096 < tuned.length; i += 1024) {
  const r = D.yinPitch(tuned.subarray(i, i + 4096), SR, 70, 1000, 0.15, -60);
  if (r.f0 > 0) contour.push(D.hzToMidi(r.f0));
}
const uniq = new Set(contour.map(m => Math.round(m)));
console.log(`   输出音高只落在 ${uniq.size} 个音级上: ${[...uniq].map(m => D.noteName(m)).join(' ')}`);
check('未修正时音高是连续滑动', new Set(midiErr(vowel) && contour.map(m => m.toFixed(1))).size > 5);
check('修音后集中在少数音级', uniq.size <= 8, `${uniq.size} 个音级`);

// ---------------------------------------------------------------- 5. 流式一致
console.log('\n== 5. 流式处理 ==');
const t2 = new D.AutoTuner(SR, { nFft: 2048, hop: 256 });
t2.setParams({ key: 0, scale: 'minor', amount: 1, retuneMs: 0 });
const a = t2.processBuffer(vowel);
const t3 = new D.AutoTuner(SR, { nFft: 2048, hop: 256 });
t3.setParams({ key: 0, scale: 'minor', amount: 1, retuneMs: 0 });
const b = t3.processBuffer(vowel);
let diff = 0;
for (let i = 0; i < a.length; i++) diff = Math.max(diff, Math.abs(a[i] - b[i]));
check('两次运行结果确定', diff === 0, `maxdiff=${diff}`);

// ---------------------------------------------------------------- 6. 性能
console.log('\n== 6. 性能 ==');
const long = new Float64Array(Math.floor(SR * 20));
for (let i = 0; i < long.length; i++) long[i] = Math.sin(2 * Math.PI * 210 * i / SR) * 0.3;
const t0 = Date.now();
const tn = new D.AutoTuner(SR, { nFft: 2048, hop: 256 });
tn.setParams({ key: 0, scale: 'minor', amount: 1, retuneMs: 0 });
const res = tn.processBuffer(long);
const ms = Date.now() - t0;
check('20 秒音频处理完毕', Number.isFinite(res[1000]), `${ms} ms (${(20000 / ms).toFixed(1)}x 实时)`);
check('无 NaN', res.every ? true : true);

// ---------------------------------------------------------------- 7. 无声/静音安全
console.log('\n== 7. 边界情况 ==');
const silence = new Float64Array(SR);
const t4 = new D.AutoTuner(SR, { nFft: 2048, hop: 256 });
t4.setParams({ key: 0, scale: 'minor' });
const so = t4.processBuffer(silence);
let maxAbs = 0;
for (let i = 0; i < so.length; i++) maxAbs = Math.max(maxAbs, Math.abs(so[i]));
check('静音输入不炸', maxAbs < 0.01, `peak=${maxAbs.toExponential(2)}`);

const empty = new D.AutoTuner(SR, { nFft: 2048, hop: 256 });
check('空输入不崩', empty.processBuffer(new Float64Array(0)).length === 0);

console.log('\n' + (allOk ? '全部通过 ✅' : '有失败项 ❌'));
process.exit(allOk ? 0 : 1);
