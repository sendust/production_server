// Horizontal dBFS bar meters, one row per audio channel, with peak hold.
const FLOOR = -60;
const FALL_DB_PER_S = 20;   // bar release
const HOLD_S = 1.5;         // peak-hold time
const SCALE = [-60, -50, -40, -30, -20, -18, -12, -9, -6, -3, 0];

const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

export class Meter {
  constructor(canvas) {
    this.c = canvas;
    this.ctx = canvas.getContext("2d");
    this.n = 8;
    this.val = [];
    this.hold = [];
    this.last = performance.now();
    new ResizeObserver(() => this._resize()).observe(canvas);
    this._resize();
    const loop = () => { this._frame(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1, r = this.c.getBoundingClientRect();
    this.c.width = Math.max(1, Math.round(r.width * dpr));
    this.c.height = Math.max(1, Math.round(r.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = r.width; this.h = r.height;
  }

  setChannels(n) { this.n = Math.max(1, Math.min(16, n || 8)); }

  push(db) {
    const now = performance.now();
    for (let i = 0; i < this.n; i++) {
      const v = Math.max(FLOOR, db?.[i] ?? FLOOR);
      if (v >= (this.val[i] ?? FLOOR)) this.val[i] = v;
      const h = this.hold[i];
      if (!h || v >= h.v || now - h.t > HOLD_S * 1000) this.hold[i] = { v, t: now };
    }
  }

  _x(db) { const L = 26; return L + (this.w - L - 4) * (db - FLOOR) / -FLOOR; }

  _frame() {
    const now = performance.now(), dt = (now - this.last) / 1000;
    this.last = now;
    const { ctx, w, h, n } = this;
    if (!w) return;
    ctx.clearRect(0, 0, w, h);
    const top = 14, rowH = Math.max(4, Math.floor((h - top - 2) / n)), barH = Math.max(3, rowH - 2);
    ctx.font = "10px ui-monospace, Menlo, Consolas, monospace";
    // scale
    ctx.textAlign = "center";
    for (const d of SCALE) {
      const X = this._x(d);
      ctx.fillStyle = d === -18 ? css("--meter-ref") : css("--dim");
      ctx.fillText(String(d), X, 10);
      ctx.fillStyle = css("--meter-grid");
      ctx.fillRect(X, top, 1, rowH * n);
    }
    const g = ctx.createLinearGradient(this._x(FLOOR), 0, this._x(0), 0);
    g.addColorStop(0, css("--meter-low"));
    g.addColorStop((-18 - FLOOR) / -FLOOR, css("--meter-low"));
    g.addColorStop((-9 - FLOOR) / -FLOOR, css("--meter-mid"));
    g.addColorStop((-3 - FLOOR) / -FLOOR, css("--meter-high"));
    g.addColorStop(1, css("--meter-high"));
    ctx.textAlign = "right";
    for (let i = 0; i < n; i++) {
      const y = top + i * rowH;
      this.val[i] = Math.max(FLOOR, (this.val[i] ?? FLOOR) - FALL_DB_PER_S * dt);
      ctx.fillStyle = css("--dim");
      ctx.fillText(String(i + 1), 20, y + barH - 1);
      ctx.fillStyle = css("--meter-bg");
      ctx.fillRect(this._x(FLOOR), y, this._x(0) - this._x(FLOOR), barH);
      ctx.fillStyle = g;
      ctx.fillRect(this._x(FLOOR), y, this._x(this.val[i]) - this._x(FLOOR), barH);
      const hd = this.hold[i];
      if (hd && hd.v > FLOOR) {
        ctx.fillStyle = hd.v > -3 ? css("--meter-high") : css("--fg");
        ctx.fillRect(this._x(hd.v) - 1, y, 2, barH);
      }
    }
  }
}
