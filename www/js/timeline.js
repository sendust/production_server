// Full-clip timeline: whole length, in/out region, zoom window (±N s), playhead, TC ticks.
// Pointer drag scrubs: onScrub(frame, final) is called (throttled by the caller).
import { framesToTc } from "./common.js";

const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

export class Timeline {
  constructor(canvas, { onScrub, onScrubStart } = {}) {
    this.c = canvas;
    this.ctx = canvas.getContext("2d");
    this.s = { length: 0, fin: 0, fout: 0, pos: null, tcStart: 0, fps: [30000, 1001], drop: true, zoomSec: 5 };
    this.onScrub = onScrub;
    this.onScrubStart = onScrubStart;
    this.dragging = false;
    this.hover = null;
    new ResizeObserver(() => this._resize()).observe(canvas);
    canvas.addEventListener("pointerdown", e => this._down(e));
    canvas.addEventListener("pointermove", e => this._move(e));
    canvas.addEventListener("pointerup", e => this._up(e));
    canvas.addEventListener("pointercancel", e => this._up(e));
    canvas.addEventListener("pointerleave", () => { this.hover = null; this.draw(); });
    this._resize();
  }

  set(s) { Object.assign(this.s, s); this.draw(); }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const r = this.c.getBoundingClientRect();
    this.c.width = Math.max(1, Math.round(r.width * dpr));
    this.c.height = Math.max(1, Math.round(r.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = r.width; this.h = r.height;
    this.draw();
  }

  // horizontal padding so in/out triangles at the ends stay visible
  get pad() { return 8; }
  x(f) { return this.pad + (this.s.length ? f / this.s.length : 0) * (this.w - 2 * this.pad); }
  frameAt(px) {
    const t = (px - this.pad) / (this.w - 2 * this.pad);
    return Math.max(0, Math.min(this.s.length - 1, Math.round(t * this.s.length)));
  }

  _down(e) {
    if (!this.s.length) return;
    this.dragging = true;
    this.c.setPointerCapture(e.pointerId);
    this.onScrubStart?.();
    this.onScrub?.(this.frameAt(e.offsetX), false);
  }
  _move(e) {
    this.hover = e.offsetX;
    if (this.dragging) this.onScrub?.(this.frameAt(e.offsetX), false);
    this.draw();
  }
  _up(e) {
    if (!this.dragging) return;
    this.dragging = false;
    this.onScrub?.(this.frameAt(e.offsetX), true);
  }

  draw() {
    const { ctx, w, h } = this;
    if (!w) return;
    const s = this.s, fpsR = s.fps[0] / s.fps[1];
    ctx.clearRect(0, 0, w, h);
    const trackY = 22, trackH = h - 34;
    ctx.fillStyle = css("--tl-bg");
    ctx.fillRect(0, 0, w, h);
    if (!s.length) {
      ctx.fillStyle = css("--dim"); ctx.font = "12px system-ui"; ctx.textAlign = "center";
      ctx.fillText("no clip loaded", w / 2, h / 2 + 4);
      return;
    }
    // track
    ctx.fillStyle = css("--tl-track");
    ctx.fillRect(this.pad, trackY, w - 2 * this.pad, trackH);
    // in/out region
    const xi = this.x(s.fin), xo = this.x(s.fout);
    ctx.fillStyle = css("--tl-region");
    ctx.fillRect(xi, trackY, Math.max(1, xo - xi), trackH);

    // ticks: pick a step that keeps labels >= 90px apart
    const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
    const pxPerSec = (w - 2 * this.pad) / (s.length / fpsR);
    const step = steps.find(v => v * pxPerSec >= 90) || 7200;
    ctx.font = "11px ui-monospace, Menlo, Consolas, monospace";
    ctx.textAlign = "left";
    for (let sec = 0; sec * fpsR <= s.length; sec += step) {
      const f = Math.round(sec * fpsR), X = this.x(f);
      ctx.fillStyle = css("--tl-tick");
      ctx.fillRect(X, trackY - 6, 1, 6);
      ctx.fillStyle = css("--dim");
      ctx.fillText(framesToTc(s.tcStart + f, s.fps, s.drop), X + 3, 12);
    }
    // minor ticks
    const minor = step / 5;
    if (minor * pxPerSec >= 8) {
      ctx.fillStyle = css("--tl-tick");
      for (let sec = 0; sec * fpsR <= s.length; sec += minor) ctx.fillRect(this.x(sec * fpsR), trackY - 3, 1, 3);
    }

    // zoom window around playhead
    if (s.pos != null && s.zoomSec > 0) {
      const zf = s.zoomSec * fpsR;
      const a = this.x(Math.max(0, s.pos - zf)), b = this.x(Math.min(s.length, s.pos + zf));
      ctx.fillStyle = css("--tl-zoom");
      ctx.fillRect(a, trackY + trackH - 6, Math.max(2, b - a), 6);
      ctx.strokeStyle = css("--tl-zoom-line");
      ctx.lineWidth = 1;
      ctx.strokeRect(a + 0.5, trackY + 0.5, Math.max(2, b - a) - 1, trackH - 1);
    }

    // in/out markers
    const mark = (X, color, dir) => {
      ctx.fillStyle = color;
      ctx.fillRect(X - (dir > 0 ? 0 : 2), trackY, 2, trackH);
      ctx.beginPath();
      ctx.moveTo(X, trackY + trackH);
      ctx.lineTo(X + 7 * dir, trackY + trackH + 8);
      ctx.lineTo(X, trackY + trackH + 8);
      ctx.fill();
    };
    mark(xi, css("--in"), 1);
    mark(xo, css("--out"), -1);

    // hover position
    if (this.hover != null && !this.dragging) {
      const f = this.frameAt(this.hover);
      ctx.fillStyle = css("--tl-hover");
      ctx.fillRect(this.x(f), trackY, 1, trackH);
    }
    // playhead
    if (s.pos != null) {
      const X = Math.round(this.x(s.pos));
      ctx.fillStyle = css("--playhead");
      ctx.fillRect(X - 1, trackY - 4, 2, trackH + 4);
      ctx.beginPath();
      ctx.moveTo(X - 6, trackY - 10); ctx.lineTo(X + 6, trackY - 10); ctx.lineTo(X, trackY - 3);
      ctx.fill();
    }
  }
}
