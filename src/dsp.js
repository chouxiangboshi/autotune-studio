/*
 * dsp.js —— 挂电（Auto-Tune）核心引擎
 *
 * 同一份代码跑在三处：
 *   1. AudioWorklet（实时监听 / 离线渲染）
 *   2. 主线程（音阶计算、界面）
 *   3. Node（自动化测试）
 *
 * 算法：YIN 基频检测 -> 音阶吸附 -> 相位声码器变调
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ATDSP = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const TAU = Math.PI * 2;
  const EPS = 1e-12;

  // ------------------------------------------------------------ 音阶

  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  const SCALES = {
    chromatic:        [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    major:            [0, 2, 4, 5, 7, 9, 11],
    minor:            [0, 2, 3, 5, 7, 8, 10],
    harmonic_minor:   [0, 2, 3, 5, 7, 8, 11],
    major_pentatonic: [0, 2, 4, 7, 9],
    minor_pentatonic: [0, 3, 5, 7, 10],
    blues:            [0, 3, 5, 6, 7, 10],
    dorian:           [0, 2, 3, 5, 7, 9, 10],
    phrygian:         [0, 1, 3, 5, 7, 8, 10],
    mixolydian:       [0, 2, 4, 5, 7, 9, 10],
  };

  function keyToPcs(key, scale) {
    const sc = SCALES[scale] || SCALES.chromatic;
    const set = new Set();
    for (const s of sc) set.add(((key + s) % 12 + 12) % 12);
    return Array.from(set).sort((a, b) => a - b);
  }

  function midiToHz(m) { return 440 * Math.pow(2, (m - 69) / 12); }
  function hzToMidi(f) { return 69 + 12 * Math.log2(Math.max(f, 1e-6) / 440); }

  function snapMidi(midi, pcs) {
    const lo = Math.floor(midi);
    let best = lo, bestD = Infinity;
    for (let off = -1; off <= 2; off++) {
      const cand = lo + off;
      const pc = ((cand % 12) + 12) % 12;
      if (pcs.indexOf(pc) < 0) continue;
      const d = Math.abs(cand - midi);
      if (d < bestD) { bestD = d; best = cand; }
    }
    return best;
  }

  function noteName(midi) {
    const m = Math.round(midi);
    return NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
  }

  // ------------------------------------------------------------ FFT

  function makeFFT(n) {
    const levels = Math.round(Math.log2(n));
    const rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let x = i, r = 0;
      for (let j = 0; j < levels; j++) { r = (r << 1) | (x & 1); x >>= 1; }
      rev[i] = r;
    }
    const half = n >> 1;
    const cos = new Float64Array(half);
    const sin = new Float64Array(half);
    for (let i = 0; i < half; i++) {
      cos[i] = Math.cos(TAU * i / n);
      sin[i] = Math.sin(TAU * i / n);
    }
    return { n, rev, cos, sin };
  }

  function fft(t, re, im, inverse) {
    const n = t.n, rev = t.rev, cos = t.cos, sin = t.sin;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let a = re[i]; re[i] = re[j]; re[j] = a;
        let b = im[i]; im[i] = im[j]; im[j] = b;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let k = 0, idx = 0; k < half; k++, idx += step) {
          const wr = cos[idx];
          const wi = inverse ? sin[idx] : -sin[idx];
          const p = i + k + half;
          const ar = re[p], ai = im[p];
          const tr = ar * wr - ai * wi;
          const ti = ar * wi + ai * wr;
          re[p] = re[i + k] - tr;
          im[p] = im[i + k] - ti;
          re[i + k] += tr;
          im[i + k] += ti;
        }
      }
    }
    if (inverse) {
      const inv = 1 / n;
      for (let i = 0; i < n; i++) { re[i] *= inv; im[i] *= inv; }
    }
  }

  // ------------------------------------------------------------ YIN 基频检测

  function yinPitch(x, sr, fmin, fmax, threshold, gateDb) {
    const n = x.length;
    fmin = fmin || 70; fmax = fmax || 1000;
    threshold = threshold || 0.15; gateDb = gateDb === undefined ? -52 : gateDb;
    if (n < 128) return { f0: 0, conf: 0 };

    let energy = 0;
    for (let i = 0; i < n; i++) energy += x[i] * x[i];
    const rms = Math.sqrt(energy / n);
    if (20 * Math.log10(rms + EPS) < gateDb) return { f0: 0, conf: 0 };

    const tauMin = Math.max(2, Math.floor(sr / fmax));
    const tauMax = Math.min(Math.floor(sr / fmin), n >> 1);
    if (tauMax <= tauMin + 2) return { f0: 0, conf: 0 };

    // 去直流
    let mean = 0;
    for (let i = 0; i < n; i++) mean += x[i];
    mean /= n;

    const N = n << 1;
    const size = 1 << Math.ceil(Math.log2(N));
    const t = getFFT(size);
    const re = new Float64Array(size);
    const im = new Float64Array(size);
    for (let i = 0; i < n; i++) re[i] = x[i] - mean;
    fft(t, re, im, false);
    for (let i = 0; i < size; i++) {
      re[i] = re[i] * re[i] + im[i] * im[i];
      im[i] = 0;
    }
    fft(t, re, im, true);
    // re[tau] 即为自相关

    // 累积平方和
    const cs = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) {
      const v = x[i] - mean;
      cs[i + 1] = cs[i] + v * v;
    }
    const total = cs[n];
    const corr = re;

    const d = new Float64Array(tauMax + 1);
    for (let tau = 1; tau <= tauMax; tau++) {
      const w = n - tau;
      const e1 = cs[w];
      const e2 = total - cs[tau];
      let v = e1 + e2 - 2 * corr[tau];
      if (v < 0) v = 0;
      d[tau] = v;
    }

    const cmnd = new Float64Array(tauMax + 1);
    cmnd[0] = 1;
    let running = 0;
    for (let tau = 1; tau <= tauMax; tau++) {
      running += d[tau];
      cmnd[tau] = running > EPS ? d[tau] * tau / running : 1;
    }

    let idx = -1;
    for (let t2 = tauMin; t2 < tauMax; t2++) {
      if (cmnd[t2] < threshold) {
        let k = t2;
        while (k + 1 <= tauMax && cmnd[k + 1] < cmnd[k]) k++;
        idx = k;
        break;
      }
    }
    if (idx < 0) {
      let best = Infinity;
      for (let k = tauMin; k <= tauMax; k++) {
        if (cmnd[k] < best) { best = cmnd[k]; idx = k; }
      }
      if (best > 0.55) return { f0: 0, conf: 0 };
    }

    let shift = 0;
    if (idx > 0 && idx < tauMax) {
      const a = cmnd[idx - 1], b = cmnd[idx], c = cmnd[idx + 1];
      const den = a - 2 * b + c;
      if (Math.abs(den) > EPS) {
        shift = Math.max(-1, Math.min(1, 0.5 * (a - c) / den));
      }
    }
    const period = idx + shift;
    if (period <= 0) return { f0: 0, conf: 0 };
    return { f0: sr / period, conf: Math.max(0, Math.min(1, 1 - cmnd[idx])) };
  }

  const fftCache = new Map();
  function getFFT(size) {
    let t = fftCache.get(size);
    if (!t) { t = makeFFT(size); fftCache.set(size, t); }
    return t;
  }

  // ------------------------------------------------------------ 相位声码器变调

  function PitchShifter(sr, nFft, hop) {
    if (nFft % hop !== 0) throw new Error('nFft 必须是 hop 的整数倍');
    this.n = nFft;
    this.hop = hop;
    this.half = nFft >> 1;

    this.win = new Float64Array(nFft);
    let wsum = 0;
    for (let i = 0; i < nFft; i++) {
      const w = 0.5 - 0.5 * Math.cos(TAU * i / nFft);
      this.win[i] = w;
      wsum += w * w;
    }
    this.norm = wsum / hop;

    this.omega = new Float64Array(this.half + 1);
    for (let k = 0; k <= this.half; k++) this.omega[k] = TAU * k / nFft;

    this.t = getFFT(nFft);
    this.re = new Float64Array(nFft);
    this.im = new Float64Array(nFft);
    this.mag = new Float64Array(this.half + 1);
    this.phase = new Float64Array(this.half + 1);
    this.prevPhase = new Float64Array(this.half + 1);
    this.sumPhase = new Float64Array(this.half + 1);
    this.inst = new Float64Array(this.half + 1);

    // 变调落位用的累加器
    this.oMag = new Float64Array(this.half + 1);
    this.oNum = new Float64Array(this.half + 1);
    this.oDen = new Float64Array(this.half + 1);
    this.out = new Float64Array(nFft);
  }

  PitchShifter.prototype.reset = function () {
    this.prevPhase.fill(0);
    this.sumPhase.fill(0);
  };

  PitchShifter.prototype.shift = function (frame, ratio) {
    const n = this.n, half = this.half, hop = this.hop;
    const re = this.re, im = this.im, win = this.win;

    for (let i = 0; i < n; i++) { re[i] = frame[i] * win[i]; im[i] = 0; }
    fft(this.t, re, im, false);

    const mag = this.mag, phase = this.phase, prev = this.prevPhase;
    const omega = this.omega, inst = this.inst, sumPhase = this.sumPhase;

    for (let k = 0; k <= half; k++) {
      const rr = re[k], ii = im[k];
      mag[k] = Math.sqrt(rr * rr + ii * ii);
      phase[k] = Math.atan2(ii, rr);
    }

    for (let k = 0; k <= half; k++) {
      let dp = phase[k] - prev[k] - omega[k] * hop;
      dp -= TAU * Math.round(dp / TAU);
      inst[k] = omega[k] + dp / hop;
      prev[k] = phase[k];
    }

    if (Math.abs(ratio - 1) < 1e-9) {
      for (let k = 0; k <= half; k++) {
        sumPhase[k] += inst[k] * hop;
        const m = mag[k];
        re[k] = m * Math.cos(sumPhase[k]);
        im[k] = m * Math.sin(sumPhase[k]);
      }
    } else {
      const oMag = this.oMag, oNum = this.oNum, oDen = this.oDen;
      oMag.fill(0); oNum.fill(0); oDen.fill(0);

      const scale = n / TAU;
      for (let k = 0; k <= half; k++) {
        const fb = inst[k] * ratio * scale;
        if (fb < 0 || fb > half) continue;
        const lo = fb | 0;
        const frac = fb - lo;
        const m = mag[k];
        const m0 = m * (1 - frac);
        oMag[lo] += m0; oNum[lo] += inst[k] * ratio * m0; oDen[lo] += m0;
        if (lo + 1 <= half) {
          const m1 = m * frac;
          oMag[lo + 1] += m1; oNum[lo + 1] += inst[k] * ratio * m1; oDen[lo + 1] += m1;
        }
      }

      for (let k = 0; k <= half; k++) {
        const f = oDen[k] > 1e-9 ? oNum[k] / oDen[k] : 0;
        sumPhase[k] += f * hop;
        const m = oMag[k];
        re[k] = m * Math.cos(sumPhase[k]);
        im[k] = m * Math.sin(sumPhase[k]);
      }
    }

    // 补共轭对称
    for (let k = 1; k < half; k++) {
      re[n - k] = re[k];
      im[n - k] = -im[k];
    }

    fft(this.t, re, im, true);

    const out = this.out, inv = 1 / this.norm;
    for (let i = 0; i < n; i++) out[i] = re[i] * win[i] * inv;
    return out;
  };

  // ------------------------------------------------------------ 挂电处理器

  function AutoTuner(sr, opts) {
    opts = opts || {};
    this.sr = sr;
    this.nFft = opts.nFft || 2048;
    this.hop = opts.hop || 256;
    this.ps = new PitchShifter(sr, this.nFft, this.hop);
    this.obuf = new Float64Array(this.nFft);
    this.setParams(opts);
    this.corr = 0;
    this.lastF0 = 0;
    this.lastRatio = 1;
  }

  AutoTuner.prototype.setParams = function (p) {
    this.key = p.key | 0;
    this.scale = p.scale || 'minor';
    this.amount = p.amount === undefined ? 1 : p.amount;
    this.retuneMs = p.retuneMs === undefined ? 0 : p.retuneMs;
    this.maxShift = p.maxShift === undefined ? 6 : p.maxShift;
    this.octave = p.octave | 0;
    this.gateDb = p.gateDb === undefined ? -52 : p.gateDb;
    this.fmin = Math.max(45, this.sr / (this.nFft / 2));
    this.fmax = Math.min(1100, this.sr * 0.45);
    this.pcs = keyToPcs(this.key, this.scale);
  };

  AutoTuner.prototype.ratioFor = function (frame) {
    const r = yinPitch(frame, this.sr, this.fmin, this.fmax, 0.15, this.gateDb);
    this.lastF0 = r.f0;
    let target = 0;
    if (r.f0 > 0) {
      const midi = hzToMidi(r.f0);
      const snapped = snapMidi(midi, this.pcs);
      target = (snapped + 12 * this.octave - midi) * this.amount;
      if (target > this.maxShift) target = this.maxShift;
      if (target < -this.maxShift) target = -this.maxShift;
    }
    if (this.retuneMs <= 0.5) {
      this.corr = target;
    } else {
      const tau = this.retuneMs / 1000;
      const coef = 1 - Math.exp(-(this.hop / this.sr) / tau);
      this.corr += coef * (target - this.corr);
    }
    this.lastRatio = Math.pow(2, this.corr / 12);
    return this.lastRatio;
  };

  AutoTuner.prototype.processFrame = function (frame) {
    const ratio = this.ratioFor(frame);
    const out = this.ps.shift(frame, ratio);
    const obuf = this.obuf, hop = this.hop, n = this.nFft;
    for (let i = 0; i < n; i++) obuf[i] += out[i];
    const emit = obuf.slice(0, hop);
    obuf.copyWithin(0, hop);
    obuf.fill(0, n - hop);
    return emit;
  };

  /** 一次性处理整段音频（离线），返回同长度结果（已补偿 nFft 延迟） */
  AutoTuner.prototype.processBuffer = function (x) {
    const n = this.nFft, hop = this.hop;
    const total = x.length;
    const padded = new Float64Array(total + n);
    padded.set(x, n);                       // 前面垫 n 个零，抵消处理延迟
    const outLen = total + n;
    const out = new Float64Array(outLen);
    let pos = 0;
    while (pos + n <= outLen) {
      const frame = padded.subarray(pos, pos + n);
      const emit = this.processFrame(frame);
      out.set(emit, pos);
      pos += hop;
    }
    return out.slice(n, n + total);
  };

  // ------------------------------------------------------------ AudioWorklet

  if (typeof AudioWorkletProcessor !== 'undefined') {

    class AutotuneProcessor extends AudioWorkletProcessor {
      constructor(options) {
        super();
        const o = (options && options.processorOptions) || {};
        this.sr = sampleRate;
        this.nFft = o.nFft || 1024;
        this.hop = o.hop || 256;
        this.tuner = new AutoTuner(this.sr, { nFft: this.nFft, hop: this.hop });
        this.tuner.setParams(o.params || {});

        this.window = new Float64Array(this.nFft);
        this.sinceHop = 0;

        // 输出环形缓冲：写指针先跳过 nFft 个位置，这 nFft 个空位就是处理延迟
        this.cap = Math.max(this.nFft * 8, 8192);
        this.outBuf = new Float32Array(this.cap);
        this.wp = this.nFft;
        this.rp = 0;

        this.frames = 0;
        this.port.onmessage = (e) => {
          if (e.data && e.data.type === 'params') this.tuner.setParams(e.data.params);
          else if (e.data && e.data.type === 'reset') {
            this.tuner.ps.reset();
            this.tuner.corr = 0;
          }
        };
      }

      process(inputs, outputs) {
        const out = outputs[0][0];
        if (!out) return true;
        const blk = out.length;

        for (let i = 0; i < blk; i++) {
          out[i] = this.outBuf[this.rp];
          this.rp = (this.rp + 1) % this.cap;
        }

        const inp = inputs[0] && inputs[0][0];
        const win = this.window, n = this.nFft;
        win.copyWithin(0, blk);
        if (inp) win.set(inp, n - blk);
        else win.fill(0, n - blk, n);

        this.sinceHop += blk;
        while (this.sinceHop >= this.hop) {
          const emit = this.tuner.processFrame(win);
          for (let i = 0; i < emit.length; i++) {
            this.outBuf[this.wp] = emit[i];
            this.wp = (this.wp + 1) % this.cap;
          }
          this.sinceHop -= this.hop;
        }

        this.frames++;
        if (this.frames % 12 === 0) {
          this.port.postMessage({
            f0: this.tuner.lastF0,
            ratio: this.tuner.lastRatio,
          });
        }
        return true;
      }
    }

    class RecorderProcessor extends AudioWorkletProcessor {
      constructor() {
        super();
        this.buf = [];
        this.len = 0;
        this.on = true;
        this.port.onmessage = (e) => {
          if (e.data === 'stop') {
            if (this.len > 0) this.flush();
            this.on = false;
            this.port.postMessage({ type: 'done' });
          }
        };
      }
      flush() {
        const merged = new Float32Array(this.len);
        let o = 0;
        for (const c of this.buf) { merged.set(c, o); o += c.length; }
        this.buf = [];
        this.len = 0;
        this.port.postMessage({ type: 'chunk', data: merged }, [merged.buffer]);
      }
      process(inputs) {
        if (!this.on) return false;
        const ch = inputs[0] && inputs[0][0];
        if (ch) {
          this.buf.push(new Float32Array(ch));
          this.len += ch.length;
          if (this.len >= 16384) this.flush();
        }
        return true;
      }
    }

    registerProcessor('autotune', AutotuneProcessor);
    registerProcessor('recorder', RecorderProcessor);
  }

  return {
    TAU, SCALES, NOTE_NAMES,
    keyToPcs, midiToHz, hzToMidi, snapMidi, noteName,
    yinPitch, PitchShifter, AutoTuner, makeFFT, fft,
  };
});
