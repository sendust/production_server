// Zoomed timeline under the main timeline: scene-change score + audio peak of every frame around
// the playhead (skill: playhead-scene-audio-strip). Frame k = source frame k (same as player pos).
// Cut = frame whose score >= threshold = FIRST frame of the new shot: IN there starts the new shot,
// OUT there ends on the last frame of the old one (out is exclusive).
import { $, api, toast, framesToTc, tcToFrames } from "./common.js";

const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

export class Scenes {
  /* host: {loaded(), pos(), status(), seek(frame), pause(), focus()} */
  constructor(host, defaults) {
    this.h = host;
    this.data = null;
    this.busy = false;
    this.key = null;
    this.hot = null;
    this.cv = $("#sc-canvas");
    this.box = $("#sc-box");
    this.range = $("#sc-range");
    this.th = $("#sc-th");
    this.auto = $("#sc-auto");
    this.range.value = store.get("sp.scRange", defaults.seconds ?? 5);
    this.th.value = store.get("sp.scTh", 0.3);
    this.auto.checked = store.get("sp.scAuto", "0") === "1";
    this.range.onchange = () => store.set("sp.scRange", this.range.value);
    this.th.oninput = () => { store.set("sp.scTh", this.th.value); this.key = null; };
    this.auto.onchange = () => store.set("sp.scAuto", this.auto.checked ? "1" : "0");
    // buttons that disable/hide themselves must not take keyboard focus (shortcuts would die)
    for (const [id, fn] of [["#sc-run", () => this.run()], ["#sc-close", () => this.clear()]]) {
      if (!$(id)) continue;   // the playback window has no ✕ (folding the strip replaces it)
      $(id).addEventListener("mousedown", e => e.preventDefault());
      $(id).onclick = () => { this.h.focus(); fn(); };
    }
    this.cv.addEventListener("mousedown", e => e.preventDefault());
    this.cv.addEventListener("click", e => this.click(e));
    this.cv.addEventListener("mousemove", e => this.hover(e));
    this.cv.addEventListener("mouseleave", () => { $("#sc-hover").hidden = true; this.hot = null; this.key = null; });
    new ResizeObserver(() => { this.key = null; }).observe(this.box);
  }

  sideSec() { return Math.max(1, Math.min(30, parseFloat(this.range.value) || 5)); }
  threshold() { return Math.max(0.01, Math.min(1, parseFloat(this.th.value) || 0.3)); }
  cuts() { const t = this.threshold(); return this.data ? this.data.frames.filter(([, s]) => s >= t).map(([k]) => k) : []; }

  async run(frame) {
    const ld = this.h.loaded();
    if (!ld || ld.info.kind !== "video") return toast("비디오 클립을 먼저 로드하세요");
    if (this.busy) return;
    const f = frame ?? this.h.pos();
    if (f == null) return;
    const r = this.sideSec();
    this.range.value = r;
    this.busy = true;
    $("#sc-run").disabled = true;
    this.box.classList.add("busy");   // overlay: moving bar + "SCENE 분석 중" over the strip
    const t0 = performance.now();
    const tick = () => {
      const s = `${((performance.now() - t0) / 1000).toFixed(0)}s`;
      $("#sc-info").textContent = `분석 중… ${s}`;
      $("#sc-busy-t").textContent = `SCENE 분석 중 · ±${r}s · ${s}`;
    };
    tick();
    const timer = setInterval(tick, 250);
    try {
      // a request stuck in the browser (all connections to the server busy, network stall) must not
      // leave the strip "analysing" forever
      const d = await api("media/scenes", { file: ld.file, frame: f, before: r, after: r }, { timeout: 30000 });
      if (this.h.loaded()?.file !== ld.file) return;   // another clip was loaded meanwhile
      this.data = d;
      this.key = null;
    } catch (e) {
      $("#sc-info").textContent = "";
      toast(`scene: ${e.message}`);
    } finally {
      clearInterval(timer);
      this.busy = false;
      this.box.classList.remove("busy");
      $("#sc-run").disabled = false;
    }
  }

  clear() {
    this.data = null;
    this.key = null;
    $("#sc-info").textContent = "";
  }

  // ---- geometry -----------------------------------------------------------
  slot() { return this.cv.clientWidth / (this.data.to - this.data.from + 1); }
  frameAt(e) {
    const r = this.cv.getBoundingClientRect();
    const k = this.data.from + Math.floor((e.clientX - r.left) / this.slot());
    return Math.max(this.data.from, Math.min(this.data.to, k));
  }
  pick(e) {   // the cut within 6 px of the pointer, else the frame itself
    const k = this.frameAt(e), px = 6 / this.slot();
    let best = null;
    for (const c of this.cuts()) if (Math.abs(c - k) <= px && (best == null || Math.abs(c - k) < Math.abs(best - k))) best = c;
    return { k: best ?? k, cut: best != null };
  }

  // ---- interaction --------------------------------------------------------
  park(k) { this.h.pause(); this.h.seek(k); }
  // playback window (host.clickSeek): a click moves the playhead like the main timeline, PLAY stays
  // PLAY and PAUSE stays PAUSE. Preview editor: park (pause) on the frame. Cut keys always park.
  click(e) {
    if (!this.data || this.busy) return;
    const k = this.pick(e).k;
    this.h.clickSeek ? this.h.clickSeek(k) : this.park(k);
    this.h.focus();
  }

  step(dir) {   // Ctrl+← / Ctrl+→
    const cur = this.h.pos() ?? 0, cuts = this.cuts();
    const k = dir > 0 ? cuts.find(c => c > cur) : cuts.filter(c => c < cur).pop();
    if (k == null) return toast(dir > 0 ? "다음 컷이 없습니다" : "이전 컷이 없습니다");
    this.park(k);
  }

  jump(n, off = 0) {   // 1-9, Shift = the frame before the cut
    const k = this.cuts()[n - 1];
    if (k == null) return toast(`컷 ${n}번이 없습니다 (컷 ${this.cuts().length}개)`);
    this.park(Math.max(0, k + off));
  }

  tc(k) {
    const ld = this.h.loaded();
    const i = ld.info;
    const base = this.h.tcBase ? this.h.tcBase() : (tcToFrames(i.tc_start, i.fps) ?? 0);   // follows the TC mode
    return framesToTc(base + k, i.fps, i.drop);
  }

  hover(e) {
    if (!this.data) return;
    const { k, cut } = this.pick(e);
    const h = $("#sc-hover");
    const score = (this.data.frames.find(([f]) => f === k) || [, 0])[1];
    const db = this.data.peaks?.[k - this.data.from];
    h.hidden = false;
    h.style.left = `${(k - this.data.from + 0.5) * this.slot()}px`;
    h.textContent = `${this.tc(k)}${cut ? `  ✂ 컷 (${score.toFixed(2)})` : `  ${score.toFixed(2)}`}` +
      (db != null ? `  ♪ ${db <= -90 ? "-∞" : db.toFixed(1)} dB` : "");
    if (this.hot !== (cut ? k : null)) { this.hot = cut ? k : null; this.key = null; }
  }

  // ---- render (every animation frame; canvas only redrawn when something changed) ----------
  render() {
    const d = this.data, ld = this.h.loaded();
    $("#sc-th-v").textContent = this.threshold().toFixed(2);
    if (d && (!ld || ld.file !== d.file)) this.clear();
    const pos = this.h.pos();
    // AUTO: re-analyse when parked outside the analysed span
    if (this.auto.checked && ld?.info.kind === "video" && !this.busy && pos != null && this.h.status() === "paused" &&
        (!this.data || pos < this.data.from || pos > this.data.to) && performance.now() - (this._autoT || 0) > 1500) {
      this._autoT = performance.now();
      this.run(pos);
    }
    $("#sc-empty").hidden = !!this.data;
    const head = $("#sc-head");
    if (!this.data) { head.hidden = true; this._draw(null); return; }
    const slot = this.slot();
    head.hidden = pos == null || pos < d.from || pos > d.to;
    if (!head.hidden) head.style.left = `${(pos - d.from + 0.5) * slot}px`;
    const cuts = this.cuts();
    if (!this.busy) $("#sc-info").textContent = `${this.tc(d.from)} – ${this.tc(d.to)} · 컷 ${cuts.length}개 · ${d.elapsed}s`;
    this._draw(cuts);
  }

  _draw(cuts) {
    const d = this.data, ld = this.h.loaded();
    const mi = ld?.in ?? null, mo = ld?.out ?? null;
    const W = this.cv.clientWidth, H = this.cv.clientHeight;
    const key = `${W}|${H}|${this.threshold()}|${mi}|${mo}|${d?.from}|${d?.to}|${d?.file}|${this.hot}|${this.h.tcBase?.()}`;
    if (key === this.key) return;
    this.key = key;
    const dpr = devicePixelRatio || 1;
    this.cv.width = W * dpr; this.cv.height = H * dpr;
    const g = this.cv.getContext("2d");
    g.scale(dpr, dpr);
    g.clearRect(0, 0, W, H);
    if (!d) return;
    const slot = this.slot(), fpsR = d.fps[0] / d.fps[1];
    const th = this.threshold(), base = H - 14;
    const aH = Math.max(20, Math.round(H * 0.3)), sBase = base - aH - 4;
    const y = v => sBase - Math.sqrt(Math.min(1, v)) * (sBase - 4);
    const ay = db => base - Math.max(0, Math.min(1, (db + 60) / 60)) * aH;
    const w = Math.max(1, slot - 1);
    // second ticks with the source TC
    g.fillStyle = "#6b7c8f";
    g.font = "10px ui-monospace, monospace";
    g.textAlign = "left";
    const nom = Math.round(fpsR);
    const ts = this.h.tcBase ? this.h.tcBase() : (tcToFrames(ld.info.tc_start, ld.info.fps) ?? 0);
    for (let k = d.from; k <= d.to + 1; k++) {
      if ((ts + k) % nom !== 0) continue;   // whole source-TC seconds
      const x = (k - d.from) * slot;
      g.fillRect(x, base, 1, 4);
      g.fillText(this.tc(k).slice(3, 8), x + 2, H - 2);
    }
    g.fillStyle = "#26303c"; g.fillRect(0, sBase + 2, W, 1);
    g.fillStyle = "#1c2530";
    for (const db of [-20, -6]) g.fillRect(0, Math.round(ay(db)), W, 1);
    // scores + threshold
    g.fillStyle = "#4fd1c5";
    for (const [k, s] of d.frames) g.fillRect((k - d.from) * slot, y(s), w, Math.max(1, sBase - y(s)));
    g.strokeStyle = "#e8b931"; g.setLineDash([4, 3]);
    g.beginPath(); g.moveTo(0, Math.round(y(th)) + 0.5); g.lineTo(W, Math.round(y(th)) + 0.5); g.stroke();
    g.setLineDash([]);
    // audio peaks
    (d.peaks || []).forEach((db, i) => {
      if (db == null || db <= -60) return;
      g.fillStyle = db > -6 ? "#f0524f" : db > -20 ? "#e8c547" : "#4cc26e";
      g.fillRect(i * slot, ay(db), w, base - ay(db));
    });
    g.fillStyle = "#6b7c8f"; g.textBaseline = "top";
    g.fillText("AUDIO 1+2", 3, sBase + 4);
    g.fillText("SCENE", 3, 2);
    // mark in / out (out is exclusive: draw at the left edge of the out frame)
    const css = getComputedStyle(document.documentElement);
    for (const [m, c] of [[mi, css.getPropertyValue("--in")], [mo, css.getPropertyValue("--out")]]) {
      if (m == null || m < d.from || m > d.to + 1) continue;
      g.fillStyle = c.trim();
      g.fillRect((m - d.from) * slot, 0, 2, H);
    }
    // cuts through both bands, numbered 1-9
    for (const k of cuts) {
      g.fillStyle = k === this.hot ? "#fff" : "#ff4fa3";
      g.fillRect((k - d.from) * slot, 0, Math.max(2, slot - 1), base);
    }
    g.font = "bold 12px ui-monospace, monospace";
    cuts.slice(0, 9).forEach((k, i) => {
      g.fillStyle = k === this.hot ? "#fff" : "#ff4fa3";
      g.fillText(String(i + 1), (k - d.from) * slot + Math.max(2, slot - 1) + 2, 2);
    });
  }
}
