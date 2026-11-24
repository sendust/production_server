// Playlist panel of the playback window.
import { $, $$, api, esc, ask, toast, durTc, framesToTc, tcToFrames, DND_MEDIA, openWin, resizableColumns } from "./common.js";

const DND_PL = "application/x-sendust-plitem";
const SLOTS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "A", "B", "C", "D"];

const itemFrames = it => it.type === "clip" ? Math.max(0, it.out - it.in) : 0;
const itemSec = it => it.type === "clip" && it.fps ? itemFrames(it) * it.fps[1] / it.fps[0] : 0;

export function secTc(sec) {
  // duration display for mixed-rate totals: 29.97 DF
  return durTc(Math.round(sec * 30000 / 1001), { fps: [30000, 1001], drop: true });
}

export class PlaylistUI {
  constructor(ch, { getPlayer, onCue }) {
    this.ch = ch;
    this.getPlayer = getPlayer;
    this.onCue = onCue;
    this.pl = null;
    this.sel = new Set();
    this.anchor = null;
    this.list = $("#pl");
    this.tbody = $("#pl tbody");
    this._bind();
    resizableColumns($("table", this.list), `sp.plCols.ch${this.ch}`);
  }

  op(op, body = {}) {
    return api(`ch/${this.ch}/playlist/${op}`, body).then(r => { if (r.playlist) this.set(r.playlist); return r; })
      .catch(e => { toast(`playlist ${op}: ${e.message}`); throw e; });
  }

  set(pl) {
    this.pl = pl;
    const ids = new Set(pl.items.map(i => i.id));
    for (const id of [...this.sel]) if (!ids.has(id)) this.sel.delete(id);
    $("#pl-enable").checked = pl.enabled;
    const slotSel = $("#pl-slot");
    slotSel.innerHTML = SLOTS.map(s => `<option value="${s}">LIST ${s}</option>`).join("");
    slotSel.value = pl.slot;
    const nameEl = $("#pl-name");
    if (nameEl) nameEl.textContent = pl.name || "";
    this.render();
  }

  // id of the item that plays after the current one (for the NEXT marker)
  render() {
    const pl = this.pl;
    if (!pl) return;
    const p = this.getPlayer();
    const cur = pl.current_id;
    const pre = p?.preloaded;
    let n = 0;
    const rows = pl.items.map((it, i) => {
      const cls = [it.type === "pause" ? "pause" : "", it.id === cur ? "cur" : "", it.id === pre ? "next" : "",
        this.sel.has(it.id) ? "sel" : "", it.missing ? "missing" : ""].join(" ");
      if (it.type === "pause") {
        return `<tr class="${cls}" data-id="${it.id}" data-i="${i}" draggable="true"><td colspan="7">PAUSE</td></tr>`;
      }
      n++;
      const img = it.kind === "image";   // IN / OUT: clip start = 00:00:00:00, not the MXF timecode
      return `<tr class="${cls}" data-id="${it.id}" data-i="${i}" draggable="true">
        <td class="c-n">${n}</td>
        <td class="name" title="${esc(it.file)}">${esc(it.name)}</td>
        <td class="dim">${esc(it.kind)}${it.audio_ch ? ` · ${it.audio_ch}ch` : ""}</td>
        <td class="r tc in">${img ? "" : framesToTc(it.in, it.fps, it.drop)}</td>
        <td class="r tc out">${img ? "" : framesToTc(it.out, it.fps, it.drop)}</td>
        <td class="r tc">${durTc(itemFrames(it), it)}</td>
        <td class="r tc dim" data-eta="${it.id}"></td></tr>`;
    });
    this.tbody.innerHTML = rows.join("");
    $(".pl-empty", this.list).classList.toggle("hidden", pl.items.length > 0);
    const clips = pl.items.filter(i => i.type === "clip");
    const total = clips.reduce((a, it) => a + itemSec(it), 0);
    $("#pl-total").textContent = `${clips.length} clips · ${secTc(total)}`;
    const one = this.previewItem();
    const pb = $("#pl-preview");
    pb.disabled = !one;
    pb.title = one ? `VGA 프리뷰: ${one.name}` : "VGA 프리뷰: MXF 클립 하나를 선택하세요";
    this.renderLive();
  }

  // On-air estimate (wall clock) for the current item and the ones chained after it, and
  // this.live = {nth, count, afterSec} for the playback window's playlist REM (null when
  // Playlist play is off or the loaded clip is not the playlist's current item). Called on every tick.
  renderLive() {
    const pl = this.pl, p = this.getPlayer();
    if (!pl) return;
    const clips = pl.items.filter(i => i.type === "clip");
    const curIdx = pl.items.findIndex(i => i.id === pl.current_id);
    $$("[data-eta]", this.tbody).forEach(td => td.textContent = "");
    this.live = null;
    if (curIdx < 0 || !p?.loaded || p.loaded.item_id !== pl.current_id) return;
    const cur = pl.items[curIdx];
    const fps = cur.fps[0] / cur.fps[1];
    const pos = p.pos ?? cur.in;
    let remain = Math.max(0, (cur.out - pos) / fps);
    let t = Date.now() + remain * 1000;
    const fmt = ms => new Date(ms).toLocaleTimeString("ko-KR", { hour12: false });
    const curTd = $(`[data-eta="${cur.id}"]`, this.tbody);
    if (curTd) curTd.textContent = p.status === "playing" ? `→ ${fmt(t)}` : "";
    if (pl.enabled && p.loop_mode !== "single") {
      const n = pl.items.length;
      for (let k = 1; k < n; k++) {
        let j = curIdx + k;
        if (j >= n) { if (p.loop_mode !== "playlist") break; j %= n; }
        const it = pl.items[j];
        if (it.type === "pause") break;
        if (it.missing) continue;
        const td = $(`[data-eta="${it.id}"]`, this.tbody);
        if (td && p.status === "playing") td.textContent = fmt(t);
        remain += itemSec(it);
        t += itemSec(it) * 1000;
      }
    }
    if (pl.enabled) {   // everything after the current clip to the end of the list (PAUSE lines skipped)
      const afterSec = pl.items.slice(curIdx + 1).filter(it => it.type === "clip" && !it.missing)
        .reduce((a, it) => a + itemSec(it), 0);
      this.live = { nth: clips.findIndex(i => i.id === cur.id) + 1, count: clips.length, afterSec };
    }
  }

  exportCsv() {
    const rows = [["#", "type", "file", "in_tc", "out_tc", "duration_tc", "in_frame", "out_frame"]];
    let n = 0;
    for (const it of this.pl.items) {
      if (it.type === "pause") { rows.push(["", "PAUSE", "", "", "", "", "", ""]); continue; }
      const ts = tcToFrames(it.tc_start || "00:00:00:00", it.fps) ?? 0;
      rows.push([++n, it.kind, it.file, framesToTc(ts + it.in, it.fps, it.drop), framesToTc(ts + it.out, it.fps, it.drop),
        durTc(itemFrames(it), it), it.in, it.out]);
    }
    const csv = "\ufeff" + rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `${(this.pl.name || "playlist").replace(/[\\/:*?"<>|]/g, "_")}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  previewItem() {
    const ids = this.selectedIds();
    const it = ids.length === 1 ? this.pl.items.find(i => i.id === ids[0]) : null;
    return it && it.type === "clip" && !it.missing && /\.mxf$/i.test(it.file) ? it : null;
  }

  openPreview() {
    const it = this.previewItem();
    if (it) openWin(`/preview.html?ch=${this.ch}&id=${it.id}`, `sendust_preview_${this.ch}`, 1280, 900);
  }

  selectedIds() { return this.pl ? this.pl.items.filter(i => this.sel.has(i.id)).map(i => i.id) : []; }

  _click(id, e) {
    const items = this.pl.items;
    if (e.shiftKey && this.anchor) {
      const a = items.findIndex(i => i.id === this.anchor), b = items.findIndex(i => i.id === id);
      if (!e.ctrlKey) this.sel.clear();
      for (let k = Math.min(a, b); k <= Math.max(a, b); k++) this.sel.add(items[k].id);
    } else if (e.ctrlKey || e.metaKey) {
      this.sel.has(id) ? this.sel.delete(id) : this.sel.add(id);
      this.anchor = id;
    } else {
      this.sel = new Set([id]);
      this.anchor = id;
    }
    this.render();
  }

  // double click: CUE at once, except while the channel is playing (an accidental double click must not
  // replace the clip on air; use the CUE button then)
  dblCue(id) {
    if (this.getPlayer()?.status === "playing") return toast("재생 중에는 더블클릭 CUE 를 하지 않습니다 — CUE 버튼을 쓰세요", 2500);
    this.sel = new Set([id]);
    this.cueSelected(false);
  }

  async cueSelected(play = false) {
    const ids = this.selectedIds();
    const it = this.pl.items.find(i => i.id === ids[0]);
    if (!it || it.type !== "clip") return;
    try {
      await api(`ch/${this.ch}/cue`, { id: it.id, on: play });
      this.onCue?.();
    } catch (e) { toast(`cue: ${e.message}`); }
  }

  _moveSel(delta) {
    const ids = this.selectedIds();
    if (!ids.length) return;
    const items = this.pl.items;
    const idx = ids.map(id => items.findIndex(i => i.id === id));
    const to = delta < 0 ? Math.max(0, Math.min(...idx) - 1) : Math.min(items.length, Math.max(...idx) + 2);
    this.op("move", { ids, at: to });
  }

  _dropIndex(e) {
    const tr = e.target.closest("tbody tr");
    if (!tr) return this.pl.items.length;
    const r = tr.getBoundingClientRect();
    const i = Number(tr.dataset.i);
    return e.clientY > r.top + r.height / 2 ? i + 1 : i;
  }

  _markDrop(at) {
    $$("tr.dropbefore", this.tbody).forEach(t => t.classList.remove("dropbefore"));
    this.list.classList.toggle("dropend", at >= (this.pl?.items.length ?? 0) && at !== null);
    if (at !== null) this.tbody.querySelector(`tr[data-i="${at}"]`)?.classList.add("dropbefore");
  }

  _bind() {
    const tb = this.tbody, list = this.list;
    let last = { id: null, t: 0 };
    tb.addEventListener("click", e => {
      const tr = e.target.closest("tr"); if (!tr) return;
      const id = tr.dataset.id, now = performance.now();
      const dbl = !e.shiftKey && !e.ctrlKey && last.id === id && now - last.t < 450;
      last = dbl ? { id: null, t: 0 } : { id, t: now };
      this._click(id, e);
      list.focus();
      if (dbl) this.dblCue(id);
    });
    tb.addEventListener("dragstart", e => {
      const tr = e.target.closest("tr"); if (!tr) return;
      if (!this.sel.has(tr.dataset.id)) { this.sel = new Set([tr.dataset.id]); this.render(); }
      e.dataTransfer.setData(DND_PL, JSON.stringify({ ch: this.ch, ids: this.selectedIds() }));
      e.dataTransfer.effectAllowed = "move";
    });
    list.addEventListener("dragover", e => {
      const t = e.dataTransfer.types;
      if (!t.includes(DND_PL) && !t.includes(DND_MEDIA)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = t.includes(DND_PL) ? "move" : "copy";
      list.classList.add("dragover");
      this._markDrop(this._dropIndex(e));
    });
    list.addEventListener("dragleave", e => { if (!list.contains(e.relatedTarget)) { list.classList.remove("dragover"); this._markDrop(null); } });
    list.addEventListener("drop", async e => {
      list.classList.remove("dragover");
      const at = this._dropIndex(e);
      this._markDrop(null);
      const pli = e.dataTransfer.getData(DND_PL), media = e.dataTransfer.getData(DND_MEDIA);
      e.preventDefault();
      if (pli) {
        const d = JSON.parse(pli);
        if (d.ch === this.ch) this.op("move", { ids: d.ids, at });
        return;
      }
      if (media) {
        const d = JSON.parse(media);
        if (d.root !== "media") return toast("HOST 판넬의 파일은 먼저 CasparCG MEDIA 로 복사하세요");
        const files = d.paths.filter(p => /\.[a-z0-9]+$/i.test(p));
        if (!files.length) return toast("폴더는 추가할 수 없습니다");
        const r = await this.op("add", { files, at }).catch(() => null);
        if (r) toast(`${files.length} clip(s) added`, 1500);
      }
    });
    list.addEventListener("keydown", e => {
      const items = this.pl?.items ?? [];
      const k = e.key;
      let h = true;
      const curI = items.findIndex(i => i.id === this.anchor);
      const go = d => {
        const i = Math.max(0, Math.min(items.length - 1, (curI < 0 ? -1 : curI) + d));
        if (!items[i]) return;
        this._click(items[i].id, { shiftKey: e.shiftKey, ctrlKey: false });
        if (!e.shiftKey) this.anchor = items[i].id;
        tb.querySelector(`tr[data-i="${i}"]`)?.scrollIntoView({ block: "nearest" });
      };
      if (k === "ArrowDown" && e.ctrlKey) this._moveSel(1);
      else if (k === "ArrowUp" && e.ctrlKey) this._moveSel(-1);
      else if (k === "ArrowDown") go(1);
      else if (k === "ArrowUp") go(-1);
      else if (k === "Enter") this.cueSelected(false);
      else if (k === "Delete") $("#pl-del").click();
      else if (k === "p" && !e.ctrlKey) $("#pl-pause").click();
      else if (k === "v" && !e.ctrlKey) this.openPreview();
      else if (k === "a" && e.ctrlKey) { this.sel = new Set(items.map(i => i.id)); this.render(); }
      else h = false;
      if (h) { e.preventDefault(); e.stopPropagation(); }
    });

    $("#pl-enable").onchange = e => this.op("enable", { on: e.target.checked });
    $("#pl-slot").onchange = e => this.op("slot", { slot: e.target.value });
    $("#pl-save").onclick = async () => {
      const s = this.pl.slot, shared = /[A-D]/.test(s);
      if (this.pl.slots?.[s] && !await ask({ title: `저장: ${shared ? "Shared" : "List"} ${s}`, message: "기존 내용을 덮어씁니다." + (shared ? " (다른 호스트와 공유되는 리스트)" : ""), ok: "저장" })) return;
      this.op("save", { slot: s }).then(() => toast(`saved to ${s}`, 1500)).catch(() => {});
    };
    $("#pl-load").onclick = async () => {
      const s = this.pl.slot;
      if (!this.pl.slots?.[s]) return toast(`slot ${s} is empty`);
      if (this.pl.items.length && !await ask({ title: `불러오기: ${s}`, message: "현재 플레이리스트를 교체합니다.", ok: "불러오기" })) return;
      const r = await this.op("load", { slot: s }).catch(() => null);
      if (r?.missing) toast(`${r.missing} clip(s) missing on this host`);
    };
    $("#pl-cue").onclick = () => this.cueSelected(false);
    $("#pl-preview").onclick = () => this.openPreview();
    $("#pl-up") && ($("#pl-up").onclick = () => this._moveSel(-1));
    $("#pl-down") && ($("#pl-down").onclick = () => this._moveSel(1));
    $("#pl-rename") && ($("#pl-rename").onclick = async () => {
      const name = await ask({ title: "리스트 이름", message: "SAVE 하면 이 이름으로 저장됩니다", input: this.pl.name || "", ok: "변경" });
      if (name) this.op("rename", { name });
    });
    $("#pl-export") && ($("#pl-export").onclick = () => this.exportCsv());
    $("#pl-pause").onclick = () => {
      const ids = this.selectedIds();
      const at = ids.length ? this.pl.items.findIndex(i => i.id === ids[0]) : this.pl.items.length;
      this.op("pause", { at });
    };
    $("#pl-del").onclick = () => {
      const ids = this.selectedIds();
      if (!ids.length) return;
      if (ids.includes(this.pl.current_id) && this.getPlayer()?.status === "playing") return toast("재생 중인 항목은 삭제할 수 없습니다");
      this.op("delete", { ids });
    };
    $("#pl-clear").onclick = async () => {
      if (!this.pl.items.length) return;
      if (await ask({ title: "플레이리스트 전체 삭제", message: `${this.pl.items.length} 항목을 지웁니다 (저장된 슬롯은 그대로).`, ok: "전체 삭제", danger: true })) this.op("clear");
    };
  }
}
