/* app.js —— 挂电 Studio 界面与音频调度 */
(function () {
  'use strict';

  // ---------------------------------------------------------- 载入 DSP
  const dspSrc = document.getElementById('dsp-src').textContent;
  (0, eval)(dspSrc);
  const D = window.ATDSP;

  // file:// 页面里 blob: 的 origin 是 null，addModule 会被拒；data: URL 可以。
  const workletURL = 'data:application/javascript;charset=utf-8,' + encodeURIComponent(dspSrc);

  async function loadWorklet(c) {
    try {
      await c.audioWorklet.addModule(workletURL);
    } catch (e) {
      const url = URL.createObjectURL(new Blob([dspSrc], { type: 'application/javascript' }));
      await c.audioWorklet.addModule(url);
    }
  }

  // ---------------------------------------------------------- 状态
  const S = {
    key: 0,
    scale: 'minor',
    octave: 0,
    amount: 100,
    retune: 0,
    drive: 12,
    chorus: 18,
    echo: 14,
    reverb: 20,
    lowOpt: false,
    autoGain: true,
    monitor: 70,
    ab: 'wet',
    dry: null,
    wet: null,
    wetGain: 1,
    sr: 44100,
    preset: 'tpain',
  };

  const PRESETS = {
    tpain:  { label: 'T-Pain 硬挂电', amount: 100, retune: 0,  drive: 8,  chorus: 12, echo: 10, reverb: 16 },
    trap:   { label: 'Trap 主流',     amount: 100, retune: 6,  drive: 22, chorus: 22, echo: 20, reverb: 22 },
    hard:   { label: '重电失真',       amount: 100, retune: 0,  drive: 40, chorus: 30, echo: 22, reverb: 26 },
    future: { label: 'Future 迷幻',   amount: 100, retune: 0,  drive: 16, chorus: 38, echo: 30, reverb: 32 },
    subtle: { label: '轻度修音',       amount: 85,  retune: 45, drive: 4,  chorus: 8,  echo: 8,  reverb: 14 },
    dry:    { label: '只修音',         amount: 100, retune: 0,  drive: 0,  chorus: 0,  echo: 0,  reverb: 0 },
  };

  const SCALE_CN = {
    chromatic: '全音阶（不限调·最电）',
    major: '大调',
    minor: '自然小调',
    harmonic_minor: '和声小调',
    major_pentatonic: '大调五声',
    minor_pentatonic: '小调五声（说唱常用）',
    blues: '布鲁斯',
    dorian: '多利亚',
    phrygian: '弗里吉亚（暗黑 Trap）',
    mixolydian: '混合利底亚',
  };

  const $ = (id) => document.getElementById(id);

  // ---------------------------------------------------------- 提示
  let toastTimer = null;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }
  function status(text, kind) {
    $('statusText').textContent = text;
    const el = $('status');
    el.className = 'status' + (kind ? ' ' + kind : '');
  }
  function overlay(on, text) {
    const o = $('overlay');
    o.hidden = !on;
    if (text) $('overlayText').textContent = text;
  }

  // ---------------------------------------------------------- 参数
  function workletParams() {
    return {
      key: S.key,
      scale: S.scale,
      octave: S.octave,
      amount: S.amount / 100,
      retuneMs: S.retune,
      maxShift: 6,
    };
  }
  function pcs() { return D.keyToPcs(S.key, S.scale); }

  // ---------------------------------------------------------- 预设 / 控件
  function buildPresets() {
    const box = $('presets');
    Object.keys(PRESETS).forEach((k) => {
      const b = document.createElement('button');
      b.textContent = PRESETS[k].label;
      b.dataset.preset = k;
      if (k === S.preset) b.classList.add('on');
      b.onclick = () => applyPreset(k);
      box.appendChild(b);
    });
  }

  function applyPreset(k) {
    const p = PRESETS[k];
    S.preset = k;
    S.amount = p.amount; S.retune = p.retune;
    S.drive = p.drive; S.chorus = p.chorus; S.echo = p.echo; S.reverb = p.reverb;
    syncControls();
    document.querySelectorAll('#presets button').forEach((b) => {
      b.classList.toggle('on', b.dataset.preset === k);
    });
    updateLiveParams();
    scheduleRender();
  }

  function buildKeys() {
    const box = $('keys');
    D.NOTE_NAMES.forEach((n, i) => {
      const b = document.createElement('button');
      b.textContent = n;
      b.dataset.key = i;
      if (n.includes('#')) b.classList.add('black');
      if (i === S.key) b.classList.add('on');
      b.onclick = () => {
        S.key = i;
        document.querySelectorAll('#keys button').forEach((x) => {
          x.classList.toggle('on', +x.dataset.key === i);
        });
        updateLiveParams();
        scheduleRender();
      };
      box.appendChild(b);
    });
  }

  function buildScales() {
    const sel = $('scale');
    Object.keys(D.SCALES).forEach((k) => {
      const o = document.createElement('option');
      o.value = k;
      o.textContent = SCALE_CN[k] || k;
      if (k === S.scale) o.selected = true;
      sel.appendChild(o);
    });
    sel.onchange = () => {
      S.scale = sel.value;
      updateLiveParams();
      scheduleRender();
    };
  }

  function syncControls() {
    const map = [
      ['amount', S.amount, (v) => v + '%'],
      ['retune', S.retune, (v) => (v <= 0 ? '瞬跳' : v + 'ms')],
      ['drive', S.drive, (v) => String(v)],
      ['chorus', S.chorus, (v) => String(v)],
      ['echo', S.echo, (v) => String(v)],
      ['reverb', S.reverb, (v) => String(v)],
    ];
    for (const [id, val, fmt] of map) {
      const el = $(id);
      el.value = val;
      $(id + 'V').textContent = fmt(val);
    }
  }

  function bindSliders() {
    const on = (id, setter) => {
      const el = $(id);
      el.addEventListener('input', () => {
        setter(+el.value);
        $('presets').querySelectorAll('button').forEach((b) => b.classList.remove('on'));
        S.preset = null;
        if (id === 'amount') $('amountV').textContent = el.value + '%';
        else if (id === 'retune') $('retuneV').textContent = el.value <= 0 ? '瞬跳' : el.value + 'ms';
        else $(id + 'V').textContent = el.value;
        if (id === 'amount' || id === 'retune') updateLiveParams();
        else scheduleRender();
      });
    };
    on('amount', (v) => (S.amount = v));
    on('retune', (v) => (S.retune = v));
    on('drive', (v) => (S.drive = v));
    on('chorus', (v) => (S.chorus = v));
    on('echo', (v) => (S.echo = v));
    on('reverb', (v) => (S.reverb = v));

    $('octave').onchange = (e) => {
      S.octave = +e.target.value;
      updateLiveParams();
      scheduleRender();
    };

    $('lowOpt').onchange = (e) => {
      S.lowOpt = e.target.checked;
      toast(S.lowOpt ? '低音优化已开：下次录音生效（延迟 +23ms）' : '低音优化已关');
    };

    // 监听音量：只影响耳机里听到的自己，不参与录音和出片
    const mon = $('monitor');
    const applyMon = () => {
      if (!live.gain) return;
      const g = monitorGain(S.ag);
      live.gain.gain.setTargetAtTime(g, 0, 0.02);
    };
    mon.addEventListener('input', () => {
      S.monitor = +mon.value;
      $('monitorV').textContent = mon.value;
      applyMon();
    });

    $('autoGain').onchange = (e) => {
      S.autoGain = e.target.checked;
      toast(S.autoGain ? '自动增益开：麦克风偏小会自动补' : '自动增益关：保持麦克风原始电平');
    };
  }

  // ---------------------------------------------------------- 音频上下文
  let ctx = null;

  async function getCtx() {
    if (!ctx) {
      try {
        ctx = new AudioContext({ sampleRate: 44100, latencyHint: 'interactive' });
      } catch (e) {
        ctx = new AudioContext();
      }
      await loadWorklet(ctx);
      S.sr = ctx.sampleRate;
      $('srBadge').textContent = (S.sr / 1000).toFixed(1) + ' kHz';
    }
    if (ctx.state === 'suspended') await ctx.resume();
    return ctx;
  }

  // ---------------------------------------------------------- 效果链
  function driveCurve(amount) {
    const n = 2048;
    const curve = new Float32Array(n);
    const k = 1 + amount * 30;
    const t = Math.tanh(k);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.tanh(x * k) / t;
    }
    return curve;
  }

  function makeIR(c, seconds) {
    const len = Math.max(1, Math.floor(c.sampleRate * seconds));
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    let seed = 20240501;
    let lp = 0;
    for (let i = 0; i < len; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const noise = seed / 0x3fffffff - 1;
      const env = Math.exp(-6.9 * i / len);
      lp = 0.72 * lp + 0.28 * noise;
      d[i] = lp * env;
    }
    // 归一化
    let e = 0;
    for (let i = 0; i < len; i++) e += d[i] * d[i];
    const g = 1 / (Math.sqrt(e) + 1e-9);
    for (let i = 0; i < len; i++) d[i] *= g;
    return buf;
  }

  /** 把 src 串过效果链接到 dest */
  function buildFX(c, src, dest) {
    let node = src;

    if (S.drive > 1) {
      const ws = c.createWaveShaper();
      ws.curve = driveCurve(S.drive / 100);
      ws.oversample = '2x';
      node.connect(ws);
      node = ws;
    }

    if (S.chorus > 1) {
      const d = c.createDelay(0.08);
      d.delayTime.value = 0.017;
      const lfo = c.createOscillator();
      lfo.frequency.value = 0.29;
      const lg = c.createGain();
      lg.gain.value = 0.0042;
      lfo.connect(lg);
      lg.connect(d.delayTime);
      lfo.start(0);

      const wet = c.createGain();
      wet.gain.value = 0.55 * (S.chorus / 100);
      const mix = c.createGain();

      node.connect(d);
      d.connect(wet);
      wet.connect(mix);
      node.connect(mix);
      node = mix;
    }

    if (S.echo > 1) {
      const d = c.createDelay(2);
      d.delayTime.value = 0.14;
      const fb = c.createGain();
      fb.gain.value = 0.32;
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 3200;

      const wet = c.createGain();
      wet.gain.value = 0.7 * (S.echo / 100);
      const mix = c.createGain();

      node.connect(d);
      d.connect(lp);
      lp.connect(fb);
      fb.connect(d);
      d.connect(wet);
      wet.connect(mix);
      node.connect(mix);
      node = mix;
    }

    if (S.reverb > 1) {
      const conv = c.createConvolver();
      conv.buffer = makeIR(c, 1.7);
      const wet = c.createGain();
      wet.gain.value = 0.6 * (S.reverb / 100);
      const mix = c.createGain();

      node.connect(conv);
      conv.connect(wet);
      wet.connect(mix);
      node.connect(mix);
      node = mix;
    }

    // 末端限幅，避免叠加后削波
    const lim = c.createDynamicsCompressor();
    lim.threshold.value = -6;
    lim.knee.value = 0;
    lim.ratio.value = 20;
    lim.attack.value = 0.001;
    lim.release.value = 0.08;

    const out = c.createGain();
    out.gain.value = 0.97;

    node.connect(lim);
    lim.connect(out);
    out.connect(dest);
    return out;
  }

  // ---------------------------------------------------------- 录音
  const live = {
    stream: null,
    src: null,
    tune: null,
    rec: null,
    chunks: [],
    recording: false,
    gain: null,
    analyser: null,
    raf: 0,
    doneResolve: null,
    note: '—',
    inGain: null,
    agTimer: 0,
    ag: 1,
    peakDb: null,
  };

  function liveNfft() { return S.lowOpt ? 2048 : 1024; }

  /**
   * 耳机里听到的监听电平。
   * 麦克风被自动补响之后，监听不能再跟着放大——否则耳机漏音进麦、
   * 或者耳机自带直通监听时，会听到"自己的声音有两遍"。
   */
  function monitorGain(ag) {
    const comp = 1 / Math.sqrt(Math.max(1, ag || 1));
    return Math.max(0.1, Math.min(1.2, (S.monitor / 100) * comp));
  }

  function updateLiveParams() {
    if (live.tune) {
      live.tune.port.postMessage({ type: 'params', params: workletParams() });
    }
  }

  async function startRecording() {
    let c;
    try {
      c = await getCtx();
    } catch (e) {
      toast('音频引擎启动失败：' + e.message);
      return;
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
      });
    } catch (e) {
      if (isFramed()) {
        showFramedTip();
        toast('预览窗口不允许用麦克风，点上方黄条在独立窗口打开');
      } else if (e && e.name === 'NotAllowedError') {
        toast('麦克风权限被拒绝：点地址栏左侧的锁/图标，把麦克风改成「允许」，然后刷新');
      } else if (e && e.name === 'NotFoundError') {
        toast('没检测到麦克风设备，检查系统声音设置里是否插好麦克风');
      } else {
        toast('拿不到麦克风：' + (e && e.message ? e.message : e));
      }
      status('麦克风不可用 · 可改用「选择音频文件」', 'err');
      return;
    }

    const src = c.createMediaStreamSource(stream);
    const nFft = liveNfft();
    const tune = new AudioWorkletNode(c, 'autotune', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      processorOptions: { nFft, hop: 256, params: workletParams() },
    });
    const rec = new AudioWorkletNode(c, 'recorder', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
    });

    const gain = c.createGain();
    gain.gain.value = monitorGain(1);
    const analyser = c.createAnalyser();
    analyser.fftSize = 2048;

    // 自动输入增益：桌面麦克风普遍比手机低 10~25dB，先量再补，两端听感才一致
    const raw = c.createAnalyser();
    raw.fftSize = 1024;
    const inGain = c.createGain();
    inGain.gain.value = 1;
    src.connect(raw);
    src.connect(inGain);
    inGain.connect(rec);
    inGain.connect(tune);

    const rawBuf = new Float32Array(raw.fftSize);
    let ag = 1;
    const setAg = (v) => {
      ag = v;
      live.ag = ag;
      inGain.gain.setTargetAtTime(ag, c.currentTime, 0.04);
      gain.gain.setTargetAtTime(monitorGain(ag), c.currentTime, 0.06);
    };
    const agTimer = setInterval(() => {
      if (!live.recording) return;
      raw.getFloatTimeDomainData(rawBuf);
      let pk = 0;
      for (let i = 0; i < rawBuf.length; i++) {
        const v = rawBuf[i] < 0 ? -rawBuf[i] : rawBuf[i];
        if (v > pk) pk = v;
      }
      // 原始输入峰值，用来判断到底是不是设备/麦克风的问题
      if (pk > 1e-5) live.peakDb = 20 * Math.log10(pk);

      if (!S.autoGain) {
        if (ag !== 1) setAg(1);          // 关掉后立刻回到麦克风原始电平
        return;
      }
      if (pk < 1e-4) return;                       // 静音段不动
      // 上限从 ×16 降到 ×8：补太多会把底噪一起抬上来，手机端尤其明显
      const want = Math.max(1, Math.min(8, 0.42 / pk));
      setAg(want < ag ? want : ag + (want - ag) * 0.3);  // 变响立即压，变轻慢慢补
    }, 120);

    const sink = c.createGain();
    sink.gain.value = 0;
    rec.connect(sink);
    sink.connect(c.destination);

    tune.connect(gain);
    gain.connect(analyser);
    gain.connect(c.destination);

    rec.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'chunk') live.chunks.push(new Float32Array(m.data));
      else if (m.type === 'done' && live.doneResolve) {
        live.doneResolve();
        live.doneResolve = null;
      }
    };

    tune.port.onmessage = (e) => {
      const { f0, ratio } = e.data;
      if (f0 > 0) {
        const midi = D.hzToMidi(f0);
        const snapped = D.snapMidi(midi, pcs());
        const cents = Math.round((midi - snapped) * 100);
        live.note = `${D.noteName(midi)} → ${D.noteName(snapped)}  (${cents > 0 ? '+' : ''}${cents}音分)`;
      }
    };

    live.stream = stream;
    live.src = src;
    live.tune = tune;
    live.rec = rec;
    live.gain = gain;
    live.analyser = analyser;
    live.inGain = inGain;
    live.agTimer = agTimer;
    live.ag = 1;
    live.chunks = [];
    live.recording = true;

    $('recBtn').classList.add('recording');
    $('hint').textContent = '录音中… 再点一次停止（戴耳机，否则会啸叫）';
    status('录音中 · 实时挂电 ' + (nFft === 1024 ? '（低延迟模式）' : '（低音优化模式）'));
    drawLive();
  }

  function stopRecording() {
    return new Promise((resolve) => {
      if (!live.recording) return resolve(null);
      live.recording = false;
      cancelAnimationFrame(live.raf);
      live.doneResolve = () => {
        const total = live.chunks.reduce((s, c) => s + c.length, 0);
        const out = new Float32Array(total);
        let o = 0;
        for (const c of live.chunks) { out.set(c, o); o += c.length; }
        cleanupLive();
        resolve(out);
      };
      live.rec.port.postMessage('stop');
    });
  }

  function cleanupLive() {
    clearInterval(live.agTimer);
    live.agTimer = 0;
    try { live.stream && live.stream.getTracks().forEach((t) => t.stop()); } catch (e) {}
    try { live.src && live.src.disconnect(); } catch (e) {}
    try { live.inGain && live.inGain.disconnect(); } catch (e) {}
    try { live.tune && live.tune.disconnect(); } catch (e) {}
    try { live.rec && live.rec.disconnect(); } catch (e) {}
    try { live.gain && live.gain.disconnect(); } catch (e) {}
    live.stream = live.src = live.tune = live.rec = live.gain = live.analyser = live.inGain = null;
    live.chunks = [];
    live.peakDb = null;
    $('recBtn').classList.remove('recording');
    $('hint').textContent = '点红点开始录音 · 或把音频文件拖到这里';
    $('wave').getContext('2d').clearRect(0, 0, $('wave').width, $('wave').height);
  }

  // 录音时滚动波形
  function drawLive() {
    if (!live.recording || !live.analyser) return;
    const cv = $('wave');
    const { g, w, h } = fit(cv);
    const buf = new Float32Array(live.analyser.fftSize);
    live.analyser.getFloatTimeDomainData(buf);

    g.fillStyle = '#0a0c10';
    g.fillRect(0, 0, w, h);
    g.strokeStyle = '#ff2d55';
    g.lineWidth = 1.4;
    g.beginPath();
    const n = buf.length;
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * w;
      const y = h / 2 - buf[i] * h * 0.42;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();

    g.fillStyle = '#858b96';
    g.font = '12px ui-monospace, monospace';
    g.fillText(live.note, 12, 20);

    // 左下角：原始输入电平 + 自动增益倍数（判断是不是麦克风本身太小）
    const bits = [];
    if (typeof live.peakDb === 'number') bits.push('输入 ' + live.peakDb.toFixed(0) + 'dB');
    if (live.ag > 1.05) bits.push('增益 ×' + live.ag.toFixed(1));
    if (bits.length) {
      g.fillStyle = live.ag > 1.05 ? '#ffb020' : '#5c636e';
      g.fillText(bits.join('  '), 12, h - 10);
    }

    live.raf = requestAnimationFrame(drawLive);
  }

  // ---------------------------------------------------------- 画布
  function fit(cv) {
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth || 600;
    const h = cv.clientHeight || 100;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { g, w, h };
  }

  function drawWave(dry, wet) {
    const cv = $('wave');
    const { g, w, h } = fit(cv);
    g.fillStyle = '#0a0c10';
    g.fillRect(0, 0, w, h);

    const draw = (data, color, alpha, span) => {
      if (!data || !data.length) return;
      const cols = Math.floor(w);
      const per = span / cols;
      g.fillStyle = color;
      g.globalAlpha = alpha;
      for (let x = 0; x < cols; x++) {
        let mn = 0, mx = 0;
        const s = Math.floor(x * per);
        const e = Math.min(data.length, Math.floor((x + 1) * per) + 1);
        for (let i = s; i < e; i++) {
          const v = data[i];
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
        const y0 = h / 2 - mx * h * 0.46;
        const y1 = h / 2 - mn * h * 0.46;
        g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
      }
      g.globalAlpha = 1;
    };

    const span = Math.max(dry ? dry.length : 0, wet ? wet.length : 0) || 1;
    draw(dry, '#3a4150', 1, span);
    draw(wet, '#ff2d55', 0.75, span);

    g.fillStyle = '#5d636e';
    g.font = '10px ui-monospace, monospace';
    g.fillText('原声', 8, 13);
    g.fillStyle = '#ff2d55';
    g.fillText('挂电', 42, 13);
  }

  function analyzePitch(x, sr) {
    const win = 2048;
    const pts = [];
    const step = Math.max(1024, Math.floor(x.length / 1100));
    for (let i = 0; i + win < x.length; i += step) {
      const r = D.yinPitch(x.subarray(i, i + win), sr, 65, 900, 0.15, -55);
      if (r.f0 > 0 && r.conf > 0.55) {
        const m = D.hzToMidi(r.f0);
        pts.push({ t: i / sr, midi: m, snap: D.snapMidi(m, pcs()) });
      } else {
        pts.push({ t: i / sr, midi: NaN, snap: NaN });
      }
    }
    return pts;
  }

  function drawPitch(pts, dur) {
    const cv = $('pitch');
    const { g, w, h } = fit(cv);
    g.fillStyle = '#0a0c10';
    g.fillRect(0, 0, w, h);

    const valid = pts.filter((p) => !isNaN(p.midi));
    if (!valid.length) return;

    let lo = Infinity, hi = -Infinity;
    for (const p of valid) { lo = Math.min(lo, p.midi); hi = Math.max(hi, p.midi); }
    lo = Math.floor(lo) - 1;
    hi = Math.ceil(hi) + 1;
    if (hi - lo < 8) { const m = (hi + lo) / 2; lo = m - 4; hi = m + 4; }

    const padL = 40, padR = 10, padT = 14, padB = 20;
    const X = (t) => padL + (t / dur) * (w - padL - padR);
    const Y = (m) => padT + (1 - (m - lo) / (hi - lo)) * (h - padT - padB);

    // 音阶网格
    const allPcs = pcs();
    g.font = '9px ui-monospace, monospace';
    for (let m = Math.ceil(lo); m <= hi; m++) {
      const pc = ((m % 12) + 12) % 12;
      const inScale = allPcs.indexOf(pc) >= 0;
      g.strokeStyle = inScale ? 'rgba(255,255,255,.07)' : 'rgba(255,255,255,.025)';
      g.beginPath();
      g.moveTo(padL, Y(m));
      g.lineTo(w - padR, Y(m));
      g.stroke();
      if (inScale && hi - lo < 22) {
        g.fillStyle = 'rgba(133,139,150,.55)';
        g.fillText(D.noteName(m), 4, Y(m) + 3);
      }
    }

    // 原始音高
    g.strokeStyle = 'rgba(160,168,180,.55)';
    g.lineWidth = 1;
    g.beginPath();
    let started = false;
    for (const p of pts) {
      if (isNaN(p.midi)) { started = false; continue; }
      const x = X(p.t), y = Y(p.midi);
      if (!started) { g.moveTo(x, y); started = true; } else g.lineTo(x, y);
    }
    g.stroke();

    // 吸附后的台阶
    g.strokeStyle = '#ff2d55';
    g.lineWidth = 2;
    g.lineJoin = 'round';
    g.beginPath();
    started = false;
    let prev = null;
    for (const p of pts) {
      if (isNaN(p.snap)) { started = false; prev = null; continue; }
      const x = X(p.t);
      if (!started) {
        g.moveTo(x, Y(p.snap));
        started = true;
      } else {
        if (p.snap !== prev) {
          g.lineTo(x, Y(prev));
          g.lineTo(x, Y(p.snap));
        } else {
          g.lineTo(x, Y(p.snap));
        }
      }
      prev = p.snap;
    }
    g.stroke();

    // 图例
    g.font = '10px ui-monospace, monospace';
    g.fillStyle = 'rgba(160,168,180,.75)';
    g.fillText('原声', padL + 4, h - 5);
    g.fillStyle = '#ff2d55';
    g.fillText('吸附后', padL + 40, h - 5);
  }

  // ---------------------------------------------------------- 离线处理
  /**
   * 把整段素材的电平统一到目标峰值。
   * 手机麦克风通常很烫（peak 0.6~0.9），桌面头戴麦常常只有 0.02~0.1，
   * 不做这一步同一套参数在两端出来能差 20dB。
   */
  function normalize(data, target = 0.89, maxGain = 12) {
    let pk = 0;
    for (let i = 0; i < data.length; i++) {
      const v = data[i] < 0 ? -data[i] : data[i];
      if (v > pk) pk = v;
    }
    if (pk < 1e-6) return { data, gain: 1 };
    let g = target / pk;
    g = Math.max(1 / 4, Math.min(maxGain, g));
    if (Math.abs(g - 1) < 0.06) return { data, gain: 1 };
    const out = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) out[i] = data[i] * g;
    return { data: out, gain: g };
  }

  async function renderOffline(dry, sr) {
    const nFft = 2048, hop = 256;
    const tail = Math.floor(sr * 1.4);
    const len = dry.length + nFft + tail;
    const octx = new OfflineAudioContext(1, len, sr);
    await loadWorklet(octx);

    const node = new AudioWorkletNode(octx, 'autotune', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      processorOptions: { nFft, hop, params: workletParams() },
    });

    const b = octx.createBuffer(1, dry.length, sr);
    b.copyToChannel(dry, 0);
    const src = octx.createBufferSource();
    src.buffer = b;
    src.connect(node);
    buildFX(octx, node, octx.destination);
    src.start(0);

    const rendered = await octx.startRendering();
    return rendered.getChannelData(0).slice(nFft);
  }

  let renderToken = 0;
  let renderTimer = null;

  function scheduleRender() {
    if (!S.dry) return;
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => { doRender(); }, 320);
  }

  async function doRender() {
    if (!S.dry) return;
    const token = ++renderToken;
    overlay(true, '正在挂电…');
    status('处理中…', 'busy');
    const t0 = performance.now();

    try {
      const wet = await renderOffline(S.dry, S.sr);
      if (token !== renderToken) return;

      const norm = normalize(wet);
      S.wet = norm.data;
      S.wetGain = norm.gain;
      const el = performance.now() - t0;
      overlay(false);

      $('viz').hidden = false;
      $('transport').hidden = false;

      drawWave(S.dry, S.wet);

      const dur = S.dry.length / S.sr;
      $('durV').textContent = fmtTime(dur);

      const pts = analyzePitch(S.dry, S.sr);
      S.pitchPts = pts;
      drawPitch(pts, dur);

      // 唱到最多的音
      const counts = new Map();
      for (const p of pts) {
        if (isNaN(p.snap)) continue;
        counts.set(p.snap, (counts.get(p.snap) || 0) + 1);
      }
      let top = null, topN = 0;
      for (const [k, v] of counts) if (v > topN) { topN = v; top = k; }
      $('noteV').textContent = top === null ? '—' : D.noteName(top);
      $('scaleV').textContent =
        D.NOTE_NAMES[((S.key % 12) + 12) % 12] + ' ' + (SCALE_CN[S.scale] || S.scale).split('（')[0];

      status(`完成 · ${(dur).toFixed(1)}s 音频 · 耗时 ${el.toFixed(0)}ms · ${S.sr / 1000}kHz` +
        (Math.abs(norm.gain - 1) > 0.06
          ? ` · 音量${norm.gain > 1 ? '补' : '压'} ${(20 * Math.log10(norm.gain)).toFixed(1)}dB`
          : ''));
      stopPlayback();
    } catch (e) {
      if (token === renderToken) {
        overlay(false);
        status('处理失败：' + e.message, 'err');
        toast('处理失败：' + e.message);
      }
    }
  }

  function fmtTime(s) {
    const m = Math.floor(s / 60);
    const r = s - m * 60;
    return `${m}:${r.toFixed(1).padStart(4, '0')}`;
  }

  async function setDry(data, label) {
    if (!data || !data.length) { toast('没收到声音'); return; }
    S.dry = data;
    S.wet = null;
    $('dropzone').hidden = true;
    $('viz').hidden = false;
    $('transport').hidden = false;
    status(`已载入 ${label} · ${(data.length / S.sr).toFixed(1)}s`);
    await doRender();
  }

  // ---------------------------------------------------------- 播放
  let playNode = null;
  let playGain = null;
  let playing = false;

  function stopPlayback() {
    if (playNode) {
      try { playNode.onended = null; playNode.stop(); } catch (e) {}
      try { playNode.disconnect(); } catch (e) {}
      playNode = null;
    }
    if (playGain) {
      try { playGain.disconnect(); } catch (e) {}
      playGain = null;
    }
    playing = false;
    $('playBtn').textContent = '▶ 播放';
  }

  async function togglePlay() {
    if (playing) { stopPlayback(); return; }
    const data = S.ab === 'wet' ? S.wet : S.dry;
    if (!data) { toast('还没有处理结果'); return; }
    const c = await getCtx();
    const buf = c.createBuffer(1, data.length, S.sr);
    buf.copyToChannel(data, 0);

    // 原声没做标准化，用挂电版的补偿量对齐，A/B 切换不会突然变小
    let gval = 1;
    if (S.ab !== 'wet' && S.wetGain > 1) {
      let pk = 0;
      for (let i = 0; i < data.length; i++) {
        const v = data[i] < 0 ? -data[i] : data[i];
        if (v > pk) pk = v;
      }
      if (pk > 1e-6) gval = Math.max(1, Math.min(S.wetGain, 0.95 / pk));
    }
    const gn = c.createGain();
    gn.gain.value = gval;

    const node = c.createBufferSource();
    node.buffer = buf;
    node.connect(gn);
    gn.connect(c.destination);
    node.onended = () => { playing = false; $('playBtn').textContent = '▶ 播放'; };
    node.start(0);
    playNode = node;
    playGain = gn;
    playing = true;
    $('playBtn').textContent = '■ 停止';

    const dur = data.length / S.sr;
    $('durV').textContent = fmtTime(dur) + ' · 播放中';
  }

  // ---------------------------------------------------------- WAV 导出
  function encodeWav(float32, sr, bitDepth) {
    bitDepth = bitDepth || 24;
    const n = float32.length;
    const bytes = bitDepth / 8;
    const buf = new ArrayBuffer(44 + n * bytes);
    const v = new DataView(buf);

    const str = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
    str(0, 'RIFF');
    v.setUint32(4, 36 + n * bytes, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, sr, true);
    v.setUint32(28, sr * bytes, true);
    v.setUint16(32, bytes, true);
    v.setUint16(34, bitDepth, true);
    str(36, 'data');
    v.setUint32(40, n * bytes, true);

    let o = 44;
    if (bitDepth === 16) {
      for (let i = 0; i < n; i++) {
        let s = Math.max(-1, Math.min(1, float32[i]));
        v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        o += 2;
      }
    } else {
      for (let i = 0; i < n; i++) {
        let s = Math.max(-1, Math.min(1, float32[i]));
        let x = Math.round(s * 8388607);
        if (x < 0) x += 16777216;
        v.setUint8(o, x & 0xff);
        v.setUint8(o + 1, (x >> 8) & 0xff);
        v.setUint8(o + 2, (x >> 16) & 0xff);
        o += 3;
      }
    }
    return new Blob([buf], { type: 'audio/wav' });
  }

  function download() {
    if (!S.wet) { toast('还没有处理结果'); return; }
    const blob = encodeWav(S.wet, S.sr, 24);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const d = new Date();
    const pad = (x) => String(x).padStart(2, '0');
    a.href = url;
    a.download = `挂电_${D.NOTE_NAMES[((S.key % 12) + 12) % 12]}${S.scale}_${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}.wav`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    status('已导出 WAV（24bit / ' + S.sr + 'Hz 单声道）');
  }

  // ---------------------------------------------------------- 事件绑定
  function bindStage() {
    $('recBtn').onclick = async () => {
      if (live.recording) {
        const data = await stopRecording();
        if (data && data.length > 1000) await setDry(data, '录音');
        else { toast('录得太短了'); status('就绪'); }
      } else {
        await startRecording();
      }
    };

    $('pickBtn').onclick = () => $('fileInput').click();
    $('fileInput').onchange = async (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) await loadFile(f);
      e.target.value = '';
    };

    const dz = $('dropzone');
    ['dragenter', 'dragover'].forEach((ev) =>
      dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('over'); })
    );
    ['dragleave', 'drop'].forEach((ev) =>
      dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('over'); })
    );
    dz.addEventListener('drop', async (e) => {
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) await loadFile(f);
    });

    $('playBtn').onclick = togglePlay;

    $('ab').onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      S.ab = b.dataset.ab;
      $('ab').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      if (playing) { stopPlayback(); togglePlay(); }
    };

    $('dlBtn').onclick = download;

    $('resetBtn').onclick = () => {
      stopPlayback();
      S.dry = null; S.wet = null; S.wetGain = 1;
      $('dropzone').hidden = false;
      $('viz').hidden = true;
      $('transport').hidden = true;
      status('就绪');
    };

    window.addEventListener('resize', () => {
      if (S.dry) {
        drawWave(S.dry, S.wet);
        if (S.pitchPts) drawPitch(S.pitchPts, S.dry.length / S.sr);
      }
    });
  }

  async function loadFile(file) {
    try {
      status('解码中…', 'busy');
      const c = await getCtx();
      const buf = await file.arrayBuffer();
      const audio = await c.decodeAudioData(buf);
      // 混为单声道
      const ch = audio.numberOfChannels;
      let data;
      if (ch === 1) {
        data = audio.getChannelData(0).slice();
      } else {
        data = new Float32Array(audio.length);
        for (let k = 0; k < ch; k++) {
          const src = audio.getChannelData(k);
          for (let i = 0; i < data.length; i++) data[i] += src[i] / ch;
        }
      }
      await setDry(data, file.name);
    } catch (e) {
      status('解码失败：' + e.message, 'err');
      toast('这个文件解不开（' + e.message + '）。试试 WAV / MP3。');
    }
  }

  // ---------------------------------------------------------- 启动
  // ---------------------------------------------------------- 环境探测
  /** 是否被嵌在 iframe / 预览面板里（这类容器默认没有麦克风权限策略） */
  function isFramed() {
    try { return window.self !== window.top; } catch (e) { return true; }
  }

  const ONLINE_URL = 'https://chouxiangboshi.github.io/autotune-studio/';

  function showFramedTip() {
    if (document.querySelector('.framed-tip')) return;
    const bar = document.createElement('div');
    bar.className = 'framed-tip';
    bar.innerHTML =
      '<span><b>麦克风不可用</b>：现在是在聊天窗口的内嵌预览里，浏览器不允许这里开麦。' +
      '录音请点右边按钮；只处理现成音频（拖入文件）则不受影响。</span>' +
      '<a href="' + ONLINE_URL + '" target="_blank" rel="noopener">在独立窗口打开 →</a>';
    const main = document.querySelector('main');
    main.parentNode.insertBefore(bar, main);
  }

  function boot() {
    buildPresets();
    buildKeys();
    buildScales();
    bindSliders();
    bindStage();
    $('scaleV').textContent = D.NOTE_NAMES[S.key] + ' ' + (SCALE_CN[S.scale] || S.scale).split('（')[0];

    if (isFramed()) {
      showFramedTip();
      status('内嵌预览不授权麦克风 · 拖入音频文件可用');
    } else if (!window.isSecureContext) {
      status('当前不是安全上下文，麦克风可能不可用；文件处理不受影响', 'err');
    } else {
      status('就绪 · 点红点录音，或拖入音频文件');
    }

    // ---------------------------------------------------- PWA
    // 注册 Service Worker，让「安装为应用」生效（file:// 不支持，静默跳过）
    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }
    // 应用快捷方式「开始录音」：?rec=1 打开即触发录音按钮
    if (new URLSearchParams(location.search).get('rec') === '1') {
      setTimeout(() => {
        const b = $('recBtn');
        if (b && !b.classList.contains('recording')) b.click();
      }, 500);
    }

    // 调试/自动化测试入口
    window.__AT = { S, D, workletURL, renderOffline, setDry, getCtx, pcs, encodeWav, loadFile };
  }

  boot();
})();
