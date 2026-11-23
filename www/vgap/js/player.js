// Playback engine: GOP cache + decoder worker pool + clock + WebAudio.
import { openMxf } from './mxf.js';

// libavcodec decoder (wasm/mxfdec.c), not the ffmpeg CLI core: see decoder-worker.js
const CORE_URL = new URL('../vendor/mxfdec.js', import.meta.url).href;
const WASM_URL = new URL('../vendor/mxfdec.wasm', import.meta.url).href;
const WORKER_URL = new URL('./decoder-worker.js', import.meta.url).href;

let wasmModulePromise = null;
function getWasmModule() {
  if (!wasmModulePromise) {
    wasmModulePromise = (async () => {
      const r = await fetch(WASM_URL);
      if (!r.ok) throw new Error('cannot load mxfdec.wasm');
      try { return await WebAssembly.compileStreaming(r); }
      catch (_) { return WebAssembly.compile(await (await fetch(WASM_URL)).arrayBuffer()); }
    })();
  }
  return wasmModulePromise;
}

class DecoderPool {
  constructor(onMessage) {
    this.onMessage = onMessage;
    this.workers = [];
  }
  async resize(n) {
    const mod = await getWasmModule();
    while (this.workers.length > n) {
      const w = this.workers.pop();
      w.worker.terminate();
      if (w.job) this.onMessage({ type: 'cancelled', id: w.job.id }, w);
    }
    const adds = [];
    while (this.workers.length < n) {
      const slot = { worker: new Worker(WORKER_URL), ready: false, job: null };
      slot.readyP = new Promise((res, rej) => {
        slot.worker.onmessage = (e) => {
          if (e.data.type === 'ready') { slot.ready = true; res(); return; }
          this.onMessage(e.data, slot);
        };
        slot.worker.onerror = (e) => { rej(e); this.onMessage({ type: 'error', id: slot.job?.id, message: e.message }, slot); };
      });
      slot.worker.postMessage({ type: 'init', coreUrl: CORE_URL, wasmModule: mod });
      this.workers.push(slot);
      adds.push(slot.readyP);
    }
    await Promise.all(adds);
  }
  idle() { return this.workers.find((w) => w.ready && !w.job); }
  busyCount() { return this.workers.filter((w) => w.job).length; }
}

export class Player extends EventTarget {
  constructor(renderer) {
    super();
    this.r = renderer;
    this.media = null;
    this.cache = new Map();    // gop -> entry
    this.keyCache = new Map(); // gop -> key frame entry (scrub previews)
    this.queue = [];           // jobs not yet dispatched
    this.inflight = new Map(); // id -> job
    this.failures = new Map(); // gop -> error count
    this.jobId = 1;
    this.frame = 0;
    this.shown = -1;
    this.playing = false;
    this.rate = 1;
    this.buffering = false;
    this.scrubbing = false;
    this.lowres = 1;
    this.ahead = 6;
    this.cacheLimit = 768 << 20;
    this.loop = false;
    this.stats = { decoded: 0, decodeMs: 0, fetchMs: 0, bytes: 0, errors: 0, lastError: '' };
    this.pool = new DecoderPool((m, slot) => this._onWorker(m, slot));
    // audio
    this.actx = null;
    this.master = null;
    this.volume = 0.8;
    this.muted = false;
    this.routing = [];         // per track: 'L' | 'R' | 'C' | '-'
    this.audioNodes = new Map(); // gop -> AudioBufferSourceNode
    this.sessionId = 0;
    this._tick = this._tick.bind(this);
    requestAnimationFrame(this._tick);
  }

  async setWorkers(n) { await this.pool.resize(n); this._pump(); }

  // ------------------------------------------------------------------ load
  async load(url, onProgress) {
    this.stop();
    this._cancelAll();
    this.cache.clear();
    this.keyCache.clear();
    this.failures.clear();
    this.media = null;
    this.shown = -1;
    const media = await openMxf(url, onProgress);
    this.media = media;
    this.frame = 0;
    // default routing: track1 -> L, track2 -> R, rest off
    const nTracks = Math.max(media.audio.reduce((n, a) => n + (a.channels || 1), 0), 0);
    this.routing = Array.from({ length: nTracks }, (_, i) => (i === 0 ? 'L' : i === 1 ? 'R' : '-'));
    if (nTracks === 1) this.routing[0] = 'C';
    this._emit('loaded');
    this.seek(0);
    return media;
  }

  // ------------------------------------------------------------- transport
  _clock() { return this.actx && this.actx.state === 'running' && this.rate === 1 ? this.actx.currentTime : performance.now() / 1000; }

  async _ensureAudio() {
    if (!this.actx) {
      try { this.actx = new AudioContext({ sampleRate: 48000, latencyHint: 'playback' }); }
      catch (_) { this.actx = new AudioContext(); }
      this.master = this.actx.createGain();
      this.master.connect(this.actx.destination);
      this._applyVolume();
    }
    if (this.actx.state !== 'running') { try { await this.actx.resume(); } catch (_) {} }
  }

  async play(rate = this.rate) {
    if (!this.media) return;
    await this._ensureAudio();
    this.rate = rate;
    if (rate > 0 && this.frame >= this.media.frames - 1) this.frame = 0;
    if (rate < 0 && this.frame <= 0) this.frame = this.media.frames - 1;
    this.playing = true;
    this._anchor(this.frame);
    this._emit('state');
    this._schedule();
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    this.buffering = false;
    this._stopAudio();
    this.frame = Math.round(this._posNow());
    this.frame = Math.max(0, Math.min(this.media.frames - 1, this.frame));
    this._emit('state');
    this._schedule();
  }

  stop() { this.playing = false; this.buffering = false; this._stopAudio(); this._emit('state'); }

  toggle() { this.playing ? this.pause() : this.play(this.rate < 0 ? 1 : this.rate || 1); }

  setRate(rate) {
    if (!this.media) return;
    const pos = this.playing ? this._posNow() : this.frame;
    this.rate = rate;
    this.frame = Math.round(pos);
    if (this.playing) { this._stopAudio(); this._anchor(this.frame); }
    else this.play(rate);
    this._emit('state');
  }

  seek(frame, { scrub = false } = {}) {
    if (!this.media) return;
    frame = Math.max(0, Math.min(this.media.frames - 1, Math.round(frame)));
    this.frame = frame;
    this.scrubbing = scrub;
    if (this.playing) { this._stopAudio(); this._anchor(frame); }
    if (scrub) this._requestKey(this.media.gopOfFrame[frame]);
    this._schedule();
    this._present(true);
  }

  step(n) { if (this.playing) this.pause(); this.seek(this.frame + n); }

  _anchor(frame) {
    this.anchorFrame = frame;
    this.anchorTime = this._clock();
    this.sessionId++;
    this.audioNodes.clear();
  }

  _posNow() {
    if (!this.playing || this.buffering) return this.frame;
    return this.anchorFrame + (this._clock() - this.anchorTime) * this.media.fps * this.rate;
  }

  // ------------------------------------------------------------ main loop
  _tick() {
    requestAnimationFrame(this._tick);
    const m = this.media;
    if (!m) return;
    if (this.playing) {
      let pos = this._posNow();
      let f = Math.floor(pos);
      if (f >= m.frames || f < 0) {
        if (this.loop) { this.seek(this.rate > 0 ? 0 : m.frames - 1); return; }
        this.frame = Math.max(0, Math.min(m.frames - 1, f));
        this.pause();
        this._present(true);
        return;
      }
      const g = m.gopOfFrame[f];
      if (!this._ready(g)) {
        if (!this.buffering) {
          this.buffering = true;
          this.frame = f;
          this._stopAudio();
          this._emit('state');
        }
      } else if (this.buffering) {
        const ng = g + Math.sign(this.rate);
        const nextOk = ng < 0 || ng >= m.gops.length || this._ready(ng);
        if (nextOk) {
          this.buffering = false;
          this._anchor(this.frame);
          this._emit('state');
        }
      } else {
        this.frame = f;
      }
      this._schedule();
      if (!this.buffering) this._scheduleAudio();
    }
    this._present(false);
    this._emit('tick');
  }

  _ready(g) { const e = this.cache.get(g); return !!(e && (e.status === 'ready' || e.status === 'error')); }

  frameEntry(frame) {
    const m = this.media;
    const g = m.gopOfFrame[frame];
    const e = this.cache.get(g);
    if (e && e.status === 'ready' && e.count) {
      const gop = m.gops[g];
      const len = gop.end - gop.start;
      let idx = frame - gop.start - Math.max(0, len - e.count);
      idx = Math.max(0, Math.min(e.count - 1, idx));
      e.used = performance.now();
      return { ...e, offset: idx * e.frameSize, exact: true };
    }
    const k = this.keyCache.get(g);
    if (k) return { ...k, offset: 0, exact: false };
    return null;
  }

  _present(force) {
    if (!force && this.shown === this.frame && this._shownExact) return;
    const fe = this.frameEntry(this.frame);
    if (!fe) return;
    if (!force && this.shown === this.frame && !fe.exact) return;
    this.r.draw(fe);
    this.shown = this.frame;
    this._shownExact = fe.exact;
  }

  // ----------------------------------------------------------- scheduling
  _window() {
    const m = this.media;
    const g = m.gopOfFrame[this.frame];
    const dir = this.playing && this.rate < 0 ? -1 : 1;
    const ahead = this.playing ? this.ahead : 2;
    const list = [g];
    for (let i = 1; i <= ahead; i++) list.push(g + dir * i);
    list.push(g - dir); // one behind for stepping back
    return list.filter((x) => x >= 0 && x < m.gops.length);
  }

  _schedule() {
    if (!this.media) return;
    // while dragging the scrubber only key-frame previews are decoded
    const want = this.scrubbing ? [] : this._window();
    const wantSet = new Set(want);
    // drop queued GOP jobs that left the window
    this.queue = this.queue.filter((j) => {
      if (j.keyOnly || wantSet.has(j.gop)) return true;
      const e = this.cache.get(j.gop);
      if (e && e.status === 'pending' && !e.job) this.cache.delete(j.gop);
      return false;
    });
    const queued = new Set(this.queue.filter((j) => !j.keyOnly).map((j) => j.gop));
    // cancel far-away in-flight fetches
    for (const j of this.inflight.values()) {
      if (!j.keyOnly && !wantSet.has(j.gop) && !j.cancelled) {
        const g = this.media.gopOfFrame[this.frame];
        if (Math.abs(j.gop - g) > this.ahead + 2) { j.cancelled = true; j.slot?.worker.postMessage({ type: 'cancel', id: j.id }); }
      }
    }
    want.forEach((g, prio) => {
      const e = this.cache.get(g);
      if (e && (e.status !== 'pending' || e.job || queued.has(g))) return;
      this.cache.set(g, { status: 'pending', lowres: this.lowres });
      this.queue.push({ gop: g, keyOnly: false, prio });
    });
    // priorities follow window order
    const order = new Map(want.map((g, i) => [g, i]));
    this.queue.sort((a, b) => (a.keyOnly === b.keyOnly ? (order.get(a.gop) ?? 99) - (order.get(b.gop) ?? 99) : a.keyOnly ? -1 : 1));
    this._evict(wantSet);
    this._pump();
  }

  _requestKey(g) {
    if (this._ready(g) || this.keyCache.has(g)) return;
    if ([...this.inflight.values()].some((j) => j.keyOnly && j.gop === g)) return;
    // keep only the newest scrub request queued
    this.queue = this.queue.filter((j) => !j.keyOnly);
    this.queue.unshift({ gop: g, keyOnly: true, prio: -1 });
    this._pump();
  }

  _pump() {
    const m = this.media;
    if (!m) return;
    let slot;
    while (this.queue.length && (slot = this.pool.idle())) {
      const j = this.queue.shift();
      if (!j.keyOnly) {
        const e = this.cache.get(j.gop);
        if (!e || e.status !== 'pending' || e.job) continue;
        e.job = j;
      }
      const gop = m.gops[j.gop];
      const [start, end] = j.keyOnly ? m.byteRange(gop.start, gop.start + 1) : m.byteRange(gop.start, gop.end);
      j.id = this.jobId++;
      j.media = m;
      j.slot = slot;
      j.lowres = j.keyOnly ? Math.max(2, this.lowres) : this.lowres;
      slot.job = j;
      this.inflight.set(j.id, j);
      slot.worker.postMessage({
        type: 'decode', id: j.id, gop: j.gop, keyOnly: j.keyOnly, url: m.url, start, end,
        frames: gop.end - gop.start, lowres: j.lowres, audioDesc: m.audio,
        srcW: m.picture?.storedWidth, srcH: m.picture?.storedHeight,
      });
    }
  }

  _onWorker(msg, slot) {
    const j = this.inflight.get(msg.id);
    if (slot) slot.job = null;
    if (j) this.inflight.delete(msg.id);
    if (j && j.media !== this.media) { this._pump(); return; } // result for a previously opened file
    if (j && !j.keyOnly) {
      const e = this.cache.get(j.gop);
      if (e && e.job === j) {
        if (msg.type === 'done' && msg.lowres === this.lowres) {
          Object.assign(e, {
            status: 'ready', job: null, yuv: msg.yuv, count: msg.count, frameSize: msg.frameSize,
            w: msg.w, h: msg.h, cw: msg.cw, ch: msg.ch, pix: msg.pix, srcH: msg.srcH, srcW: msg.srcW,
            progressive: msg.progressive, audio: msg.audio, used: performance.now(),
            bytes: msg.yuv.byteLength + msg.audio.reduce((n, a) => n + a.byteLength, 0),
          });
          if (msg.audio.length && msg.audio.length !== this.routing.length) {
            // descriptors can under-report the track count; trust the essence
            this.routing = msg.audio.map((_, i) => this.routing[i] ?? (i === 0 ? (msg.audio.length === 1 ? 'C' : 'L') : i === 1 ? 'R' : '-'));
            this._emit('tracks');
          }
          this.codecInfo = { codec: msg.codec, pix: msg.pix, w: msg.srcW, h: msg.srcH, progressive: msg.progressive };
          if (Math.abs(this.media.gopOfFrame[this.frame] - j.gop) <= 1) this._present(true);
        } else if (msg.type === 'error') {
          const n = (this.failures.get(j.gop) || 0) + 1;
          this.failures.set(j.gop, n);
          if (n >= 3) {
            Object.assign(e, { status: 'error', job: null, bytes: 0 });
            setTimeout(() => { if (this.cache.get(j.gop) === e) { this.cache.delete(j.gop); this.failures.delete(j.gop); this._schedule(); } }, 2000);
          } else this.cache.delete(j.gop);
        } else {
          this.cache.delete(j.gop);
        }
      }
    } else if (j && j.keyOnly && msg.type === 'done' && msg.count) {
      this.keyCache.set(j.gop, {
        yuv: msg.yuv, frameSize: msg.frameSize, count: 1, w: msg.w, h: msg.h, cw: msg.cw, ch: msg.ch,
        srcH: msg.srcH, progressive: msg.progressive, bytes: msg.yuv.byteLength,
      });
      if (this.keyCache.size > 120) this.keyCache.delete(this.keyCache.keys().next().value);
      if (this.media.gopOfFrame[this.frame] === j.gop) this._present(true);
    }
    if (msg.type === 'done') {
      this.stats.decoded += msg.keyOnly ? 1 : msg.count;
      this.stats.decodeMs = this.stats.decodeMs * 0.8 + msg.tDecode * 0.2;
      this.stats.fetchMs = this.stats.fetchMs * 0.8 + msg.tFetch * 0.2;
      this.stats.bytes += msg.bytes;
      this.stats.lastJob = msg;
    } else if (msg.type === 'error') {
      this.stats.errors++;
      this.stats.lastError = msg.message;
      console.warn('decode error', msg.message);
    }
    this._schedule();
  }

  _cancelAll() {
    this.queue = [];
    for (const j of this.inflight.values()) { j.cancelled = true; j.slot?.worker.postMessage({ type: 'cancel', id: j.id }); }
    for (const e of this.cache.values()) if (e.status === 'pending') e.job = null;
  }

  _evict(keep) {
    let total = 0;
    for (const e of this.cache.values()) total += e.bytes || 0;
    if (total <= this.cacheLimit) return;
    const g0 = this.media.gopOfFrame[this.frame];
    const cand = [...this.cache.entries()].filter(([g, e]) => e.status === 'ready' && !keep.has(g))
      .sort((a, b) => Math.abs(b[0] - g0) - Math.abs(a[0] - g0));
    for (const [g, e] of cand) {
      if (total <= this.cacheLimit * 0.85) break;
      total -= e.bytes || 0;
      this.cache.delete(g);
    }
  }

  cacheBytes() {
    let t = 0;
    for (const e of this.cache.values()) t += e.bytes || 0;
    for (const e of this.keyCache.values()) t += e.bytes || 0;
    return t;
  }

  setLowres(l) {
    if (l === this.lowres) return;
    this.lowres = l;
    this._cancelAll();
    this.cache.clear();
    this._schedule();
  }

  // ---------------------------------------------------------------- audio
  setRouting(i, v) { this.routing[i] = v; for (const e of this.cache.values()) e.abuf = null; if (this.playing) { this._stopAudio(); this._anchor(Math.round(this._posNow())); } }
  setVolume(v) { this.volume = v; this._applyVolume(); }
  setMuted(m) { this.muted = m; this._applyVolume(); }
  _applyVolume() { if (this.master) this.master.gain.value = this.muted ? 0 : this.volume; }

  _audioBuffer(e) {
    if (e.abuf) return e.abuf;
    if (!e.audio || !e.audio.length) return null;
    const n = e.audio[0].length;
    if (!n) return null;
    const sr = this.media.audio[0]?.sampleRate || 48000;
    const buf = this.actx.createBuffer(2, n, sr);
    const L = buf.getChannelData(0), R = buf.getChannelData(1);
    const active = this.routing.map((r, i) => [r, e.audio[i]]).filter(([r, a]) => r !== '-' && a);
    const nl = active.filter(([r]) => r === 'L' || r === 'C').length || 1;
    const nr = active.filter(([r]) => r === 'R' || r === 'C').length || 1;
    for (const [r, a] of active) {
      const len = Math.min(n, a.length);
      if (r === 'L' || r === 'C') for (let i = 0; i < len; i++) L[i] += a[i] / nl;
      if (r === 'R' || r === 'C') for (let i = 0; i < len; i++) R[i] += a[i] / nr;
    }
    e.abuf = buf;
    return buf;
  }

  _scheduleAudio() {
    if (!this.actx || this.actx.state !== 'running' || this.rate !== 1) return;
    const m = this.media;
    const now = this.actx.currentTime;
    const g0 = m.gopOfFrame[this.frame];
    for (let g = g0; g < Math.min(m.gops.length, g0 + 3); g++) {
      if (this.audioNodes.has(g)) continue;
      const e = this.cache.get(g);
      if (!e || e.status === 'pending') break;
      if (e.status !== 'ready') { this.audioNodes.set(g, null); continue; }
      const buf = this._audioBuffer(e);
      if (!buf) { this.audioNodes.set(g, null); continue; }
      const gop = m.gops[g];
      const when = this.anchorTime + (gop.start - this.anchorFrame) / m.fps;
      const src = this.actx.createBufferSource();
      src.buffer = buf;
      src.connect(this.master);
      if (when < now) {
        const off = now - when;
        if (off >= buf.duration) { this.audioNodes.set(g, null); continue; }
        src.start(now, off);
      } else {
        src.start(when);
      }
      this.audioNodes.set(g, src);
    }
  }

  _stopAudio() {
    for (const n of this.audioNodes.values()) { try { n && n.stop(); } catch (_) {} }
    this.audioNodes.clear();
  }

  /** peak level (linear) of each track during the given frame */
  levels(frame) {
    const m = this.media;
    if (!m) return [];
    const g = m.gopOfFrame[frame];
    const e = this.cache.get(g);
    if (!e || e.status !== 'ready' || !e.audio) return null;
    const sr = m.audio[0]?.sampleRate || 48000;
    const spf = sr / m.fps;
    const s0 = Math.floor((frame - m.gops[g].start) * spf);
    const s1 = Math.floor(s0 + spf);
    return e.audio.map((a) => {
      let pk = 0;
      for (let i = s0; i < s1 && i < a.length; i++) { const v = Math.abs(a[i]); if (v > pk) pk = v; }
      return pk;
    });
  }

  gopStates() {
    const m = this.media;
    if (!m) return null;
    const st = new Uint8Array(m.gops.length);
    for (const g of this.keyCache.keys()) st[g] = 1;
    for (const [g, e] of this.cache) st[g] = e.status === 'ready' ? 3 : 2;
    return st;
  }

  _emit(type) { this.dispatchEvent(new Event(type)); }
}
