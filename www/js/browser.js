// Media browser: midnight-commander style upper (CasparCG media path) / lower (/mnt) panes.
import { $, $$, api, connectWs, durTc, fmtBytes, esc, ask, toast, DND_MEDIA } from "./common.js";

const S = { info: null, favorites: [], jobs: new Map(), active: null, session: {} };
const probeCache = new Map();   // media rel path -> info | "pending" | "error"

// ---------------------------------------------------------------- session (per client IP)
let saveTimer;
function saveSession() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const browser = {};
    for (const p of panes) browser[p.root] = { dir: p.dir, sort: p.sort, desc: p.desc };
    api("session", { browser }).catch(() => {});
  }, 500);
}

// ---------------------------------------------------------------- pane
class Pane {
  constructor(el) {
    this.el = el;
    this.root = el.dataset.root;
    el.append($("#pane-tpl").content.cloneNode(true));
    this.tbody = $("tbody", el);
    this.list = $(".fl", el);
    this.dir = "";
    this.items = [];
    this.view = [];
    this.sel = new Set();     // selected paths
    this.cursor = -1;         // index in view
    this.anchor = -1;
    this.sort = "name"; this.desc = false;
    this.filter = "";
    $(".rootlabel", el).textContent = this.root === "media" ? "CasparCG MEDIA" : "HOST";
    $(".rootlabel", el).title = this.root;
    this._bind();
  }

  get other() { return panes.find(p => p !== this); }
  get base() { return this.root === "media" ? S.info?.media_path : S.info?.host_root; }

  _bind() {
    const el = this.el;
    el.addEventListener("mousedown", () => setActive(this));
    $$(".pane-tools [data-op], .pane-head [data-op]", el).forEach(b => b.onclick = () => this.op(b.dataset.op));
    $(".filter", el).oninput = e => { this.filter = e.target.value.toLowerCase(); this.render(); };
    $(".favs", el).onchange = e => {
      const f = S.favorites[Number(e.target.value)];
      e.target.value = "";
      if (!f) return;
      if (f.root !== this.root) panes.find(p => p.root === f.root)?.open(f.dir);
      else this.open(f.dir);
    };
    $$("th[data-sort]", el).forEach(th => th.onclick = () => {
      const k = th.dataset.sort;
      if (this.sort === k) this.desc = !this.desc; else { this.sort = k; this.desc = false; }
      this.render(); saveSession();
    });
    this.tbody.addEventListener("click", e => {
      const tr = e.target.closest("tr"); if (!tr) return;
      this.clickRow(Number(tr.dataset.i), e);
    });
    this.tbody.addEventListener("dblclick", e => {
      const tr = e.target.closest("tr"); if (!tr) return;
      this.activate(Number(tr.dataset.i));
    });
    this.list.addEventListener("keydown", e => this.key(e));

    // drag rows out (to the other pane or to a player window)
    this.tbody.addEventListener("dragstart", e => {
      const tr = e.target.closest("tr"); if (!tr) return;
      const it = this.view[Number(tr.dataset.i)];
      if (!this.sel.has(it.path)) { this.sel = new Set([it.path]); this.cursor = Number(tr.dataset.i); this.paint(); }
      const paths = this.selected().map(x => x.path);
      e.dataTransfer.setData(DND_MEDIA, JSON.stringify({ root: this.root, paths }));
      e.dataTransfer.setData("text/plain", paths.join("\n"));
      e.dataTransfer.effectAllowed = "copyMove";
      dragSource = this;
    });
    this.tbody.addEventListener("dragend", () => { dragSource = null; });

    // drops: rows from the other pane (copy / Shift = move) or PC files (upload)
    el.addEventListener("dragover", e => {
      const t = e.dataTransfer.types;
      if (t.includes("Files")) { e.preventDefault(); el.classList.add("dragover"); e.dataTransfer.dropEffect = "copy"; }
      else if (t.includes(DND_MEDIA) && dragSource && dragSource !== this) {
        e.preventDefault(); el.classList.add("dragtarget"); e.dataTransfer.dropEffect = e.shiftKey ? "move" : "copy";
      }
    });
    el.addEventListener("dragleave", e => { if (!el.contains(e.relatedTarget)) el.classList.remove("dragover", "dragtarget"); });
    el.addEventListener("drop", e => {
      el.classList.remove("dragover", "dragtarget");
      if (e.dataTransfer.files.length) { e.preventDefault(); upload(this, [...e.dataTransfer.files]); return; }
      const raw = e.dataTransfer.getData(DND_MEDIA);
      if (!raw || !dragSource || dragSource === this) return;
      e.preventDefault();
      const d = JSON.parse(raw);
      transfer(dragSource, d.paths, this, e.shiftKey);
    });
  }

  async open(dir = this.dir, keepSel = false) {
    try {
      const r = await api(`fs/list?root=${this.root}&dir=${encodeURIComponent(dir)}`);
      const changedDir = dir !== this.dir;
      this.dir = dir;
      this.items = r.items;
      if (!keepSel || changedDir) { this.sel.clear(); this.cursor = 0; this.anchor = 0; }
      if (changedDir) { this.filter = ""; $(".filter", this.el).value = ""; }
      this.render();
      saveSession();
    } catch (e) {
      toast(`${this.root}: ${e.message}`);
      if (dir) this.open("");   // folder vanished -> back to root
    }
  }

  parent() { return this.dir.split("/").slice(0, -1).join("/"); }

  render() {
    const key = this.sort, dir = this.desc ? -1 : 1;
    const val = it => key === "dur" ? (probeCache.get(it.path)?.duration ?? -1) : key === "kind" ? (it.kind || "") : it[key];
    let v = this.items.filter(it => !this.filter || it.name.toLowerCase().includes(this.filter));
    v.sort((a, b) => (b.dir - a.dir) || (key === "name"
      ? a.name.localeCompare(b.name, "ko", { numeric: true }) * dir
      : ((val(a) > val(b)) - (val(a) < val(b))) * dir || a.name.localeCompare(b.name, "ko", { numeric: true })));
    if (this.dir) v.unshift({ name: "..", dir: true, up: true, path: this.parent() });
    this.view = v;
    this.cursor = Math.min(Math.max(0, this.cursor), v.length - 1);
    $$("th[data-sort]", this.el).forEach(th => th.className = (th.className.replace(/\bsorted\b|\bdesc\b/g, "").trim() +
      (th.dataset.sort === this.sort ? ` sorted${this.desc ? " desc" : ""}` : "")).trim());
    // breadcrumbs
    const parts = this.dir ? this.dir.split("/") : [];
    $(".crumbs", this.el).innerHTML = `<a data-d="">${esc(this.base || "/")}</a>` +
      parts.map((p, i) => `/<a data-d="${esc(parts.slice(0, i + 1).join("/"))}">${esc(p)}</a>`).join("");
    $$(".crumbs a", this.el).forEach(a => a.onclick = () => this.open(a.dataset.d));
    this.paint();
    this.renderFavs();
    if (this.root === "media") probeVisible(this);
  }

  paint() {
    const rows = this.view.map((it, i) => {
      const cls = [it.dir ? "dir" : "", this.sel.has(it.path) && !it.up ? "sel" : "", i === this.cursor ? "cursor" : ""].join(" ");
      const pr = probeCache.get(it.path);
      const dur = it.dir || !it.kind || it.kind === "image" ? "" :
        pr && typeof pr === "object" ? durTc(pr.frames, pr) : pr === "error" ? "?" : "…";
      const mt = it.up ? "" : new Date(it.mtime * 1000).toLocaleString("ko-KR", { hour12: false, year: "2-digit", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
      return `<tr class="${cls}" data-i="${i}" draggable="${!it.up}">
        <td class="name" title="${esc(it.name)}">${it.dir ? "▸ " : ""}${esc(it.name)}${it.dir && !it.up ? "/" : ""}</td>
        <td class="k-${it.kind || ""}">${it.dir ? "" : esc(it.kind || "")}</td>
        <td class="dur">${dur}</td>
        <td class="r num">${it.dir ? "" : fmtBytes(it.size)}</td>
        <td class="r num">${mt}</td></tr>`;
    });
    this.tbody.innerHTML = rows.join("");
    const nsel = this.sel.size, files = this.items.filter(x => !x.dir);
    const bytes = this.selected().reduce((a, x) => a + (x.size || 0), 0);
    $(".count", this.el).textContent = nsel ? `${nsel} selected · ${fmtBytes(bytes)}` : `${files.length} files`;
    this.tbody.querySelector("tr.cursor")?.scrollIntoView({ block: "nearest" });
    this.renderSendTo();
  }

  selected() {
    const s = this.view.filter(it => !it.up && this.sel.has(it.path));
    if (s.length) return s;
    const c = this.view[this.cursor];
    return c && !c.up ? [c] : [];
  }

  clickRow(i, e) {
    const it = this.view[i];
    if (!it) return;
    if (e.shiftKey && this.anchor >= 0) {
      const [a, b] = [Math.min(this.anchor, i), Math.max(this.anchor, i)];
      if (!e.ctrlKey) this.sel.clear();
      for (let k = a; k <= b; k++) if (!this.view[k].up) this.sel.add(this.view[k].path);
    } else if (e.ctrlKey || e.metaKey) {
      if (!it.up) this.sel.has(it.path) ? this.sel.delete(it.path) : this.sel.add(it.path);
      this.anchor = i;
    } else {
      this.sel = new Set(it.up ? [] : [it.path]);
      this.anchor = i;
    }
    this.cursor = i;
    this.paint();
  }

  activate(i) {
    const it = this.view[i];
    if (!it) return;
    if (it.dir) this.open(it.path);
  }

  key(e) {
    const n = this.view.length;
    const move = d => {
      const i = Math.max(0, Math.min(n - 1, this.cursor + d));
      if (e.shiftKey) {
        if (this.anchor < 0) this.anchor = this.cursor;
        this.sel.clear();
        for (let k = Math.min(this.anchor, i); k <= Math.max(this.anchor, i); k++) if (!this.view[k].up) this.sel.add(this.view[k].path);
      } else { this.sel.clear(); this.anchor = i; const it = this.view[i]; if (it && !it.up) this.sel.add(it.path); }
      this.cursor = i; this.paint();
    };
    const k = e.key;
    let h = true;
    if (k === "ArrowDown") move(1);
    else if (k === "ArrowUp") move(-1);
    else if (k === "PageDown") move(15);
    else if (k === "PageUp") move(-15);
    else if (k === "Home") move(-n);
    else if (k === "End") move(n);
    else if (k === "Enter") this.activate(this.cursor);
    else if (k === "Backspace") { if (this.dir) this.open(this.parent()); }
    else if (k === "Tab") setActive(this.other, true);
    else if (k === "a" && e.ctrlKey) { this.view.forEach(it => !it.up && this.sel.add(it.path)); this.paint(); }
    else if (k === "F2") this.op("rename");
    else if (k === "F5") this.op("copy");
    else if (k === "F6") this.op("move");
    else if (k === "F7") this.op("mkdir");
    else if (k === "F8" || k === "Delete") this.op("delete");
    else if (k === "F9" || (k === "r" && e.ctrlKey)) this.op("refresh");
    else h = false;
    if (h) e.preventDefault();
  }

  async op(op) {
    const sel = this.selected();
    try {
      if (op === "up") { if (this.dir) this.open(this.parent()); }
      else if (op === "refresh") this.open(this.dir, true);
      else if (op === "mkdir") {
        const name = await ask({ title: "새 폴더", message: `${this.base}/${this.dir}`, input: "", ok: "만들기" });
        if (name) { await api("fs/mkdir", { root: this.root, dir: this.dir, name }); this.open(this.dir, true); }
      } else if (op === "rename") {
        if (sel.length !== 1) return toast("이름을 바꿀 항목 하나를 선택하세요");
        const name = await ask({ title: "이름 변경", message: sel[0].name, input: sel[0].name, ok: "변경" });
        if (name && name !== sel[0].name) { await api("fs/rename", { root: this.root, dir: this.dir, path: sel[0].path, name }); this.open(this.dir, true); }
      } else if (op === "copy" || op === "move") {
        if (!sel.length) return;
        transfer(this, sel.map(x => x.path), this.other, op === "move", true);
      } else if (op === "delete") {
        if (!sel.length) return;
        const ok = await ask({ title: `삭제 (${sel.length})`, message: `${this.base}/${this.dir} 에서 영구 삭제합니다. 폴더는 내용까지 삭제됩니다.`,
          list: sel.map(x => x.name + (x.dir ? "/" : "")), ok: "삭제", danger: true });
        if (ok) await api("fs/delete", { root: this.root, paths: sel.map(x => x.path) });
      } else if (op === "fav") toggleFav(this);
    } catch (e) {
      toast(`${op}: ${e.message}`);
    }
  }

  renderFavs() {
    const sel = $(".favs", this.el);
    sel.innerHTML = '<option value="">★ 즐겨찾기</option>' + S.favorites.map((f, i) =>
      `<option value="${i}">${f.root === "media" ? "M" : "H"}: ${esc(f.label || f.dir || "/")}</option>`).join("");
    const on = S.favorites.some(f => f.root === this.root && f.dir === this.dir);
    const b = $("[data-op=fav]", this.el);
    b.textContent = on ? "★" : "☆";
    b.title = on ? "즐겨찾기에서 삭제" : "현재 폴더를 즐겨찾기에 추가";
  }

  renderSendTo() {
    const box = $(".sendto", this.el);
    if (this.root !== "media" || !S.info) { box.innerHTML = ""; return; }
    const files = this.selected().filter(x => !x.dir && x.kind);
    box.innerHTML = S.info.channels.map(c =>
      `<button class="ibtn" data-ch="${c.channel_index}" ${files.length ? "" : "disabled"} title="선택한 파일을 ${esc(c.name)} 플레이리스트 끝에 추가">→ ${esc(c.name)}</button>`).join("");
    $$("[data-ch]", box).forEach(b => b.onclick = async () => {
      const fs = this.selected().filter(x => !x.dir && x.kind).map(x => x.path);
      try {
        await api(`ch/${b.dataset.ch}/playlist/add`, { files: fs });
        toast(`${fs.length} clip(s) → ${b.textContent.slice(2)}`);
      } catch (e) { toast(e.message); }
    });
  }
}

let dragSource = null;
const panes = [new Pane($("#pane-media")), new Pane($("#pane-host"))];

function setActive(p, focus = false) {
  S.active = p;
  panes.forEach(x => x.el.classList.toggle("active", x === p));
  if (focus) p.list.focus();
}
setActive(panes[0]);

// ---------------------------------------------------------------- copy / move / upload
async function transfer(src, paths, dst, move, confirm = false) {
  const verb = move ? "이동" : "복사";
  if (confirm) {
    const ok = await ask({ title: `${verb} (${paths.length})`, message: `→ ${dst.base}/${dst.dir}`, list: paths.map(p => p.split("/").pop()), ok: verb });
    if (!ok) return;
  }
  const body = { root: src.root, paths, dst_root: dst.root, dst_dir: dst.dir, overwrite: false };
  try {
    await api(`fs/${move ? "move" : "copy"}`, body);
  } catch (e) {
    if (e.status === 409) {
      const ok = await ask({ title: "덮어쓰기?", message: "대상 폴더에 같은 이름이 있습니다.", list: e.detail.conflicts, ok: "덮어쓰기", danger: true });
      if (ok) await api(`fs/${move ? "move" : "copy"}`, { ...body, overwrite: true }).catch(x => toast(x.message));
    } else toast(`${verb}: ${e.message}`);
  }
}

let uploadSeq = 0;
async function upload(pane, files) {
  for (const f of files) {
    let overwrite = false;
    if (pane.items.some(it => it.name === f.name)) {
      if (!await ask({ title: "덮어쓰기?", message: `${f.name} 이(가) 이미 있습니다.`, ok: "덮어쓰기", danger: true })) continue;
      overwrite = true;
    }
    const id = `u${++uploadSeq}`;
    const job = { id, kind: "upload", desc: `${f.name} → ${pane.root}:/${pane.dir}`, status: "running", total: f.size, done: 0 };
    S.jobs.set(id, job); renderJobs();
    await new Promise(resolve => {
      const x = new XMLHttpRequest();
      x.open("PUT", `/api/v1/fs/upload?root=${pane.root}&dir=${encodeURIComponent(pane.dir)}&name=${encodeURIComponent(f.name)}&overwrite=${overwrite}`);
      x.upload.onprogress = e => { job.done = e.loaded; renderJobs(); };
      x.onload = () => {
        job.status = x.status < 300 ? "done" : "error";
        if (x.status >= 300) { try { job.error = JSON.parse(x.responseText).detail?.message || JSON.parse(x.responseText).detail; } catch { job.error = x.statusText; } }
        job.done = job.status === "done" ? f.size : job.done;
        renderJobs(); resolve();
      };
      x.onerror = () => { job.status = "error"; job.error = "network error"; renderJobs(); resolve(); };
      job.xhr = x;
      x.send(f);
    });
  }
}

function renderJobs() {
  const box = $("#jobs");
  const list = [...S.jobs.values()].sort((a, b) => (a.status === "running") - (b.status === "running") || 0).reverse().slice(0, 12);
  box.classList.toggle("hidden", !list.length);
  box.innerHTML = list.map(j => {
    const pct = j.total ? Math.min(100, j.done / j.total * 100) : (j.status === "done" ? 100 : 0);
    const prog = j.kind === "delete" ? `${j.done}/${j.total}` : `${fmtBytes(j.done)} / ${fmtBytes(j.total)}`;
    return `<div class="job ${j.status}">
      <span>${esc(j.kind)}</span>
      <span title="${esc(j.desc)}" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(j.desc)} ${j.error ? `<span class="err">${esc(j.error)}</span>` : ""}</span>
      <span class="mono"><span class="bar"><i style="width:${pct}%"></i></span>${prog} ${j.status === "running" ? Math.round(pct) + "%" : esc(j.status)}</span>
      ${j.status === "running" ? `<button class="ibtn" data-cancel="${j.id}">취소</button>` : `<button class="ibtn" data-dismiss="${j.id}">닫기</button>`}
    </div>`;
  }).join("");
  $$("[data-cancel]", box).forEach(b => b.onclick = () => {
    const j = S.jobs.get(isNaN(b.dataset.cancel) ? b.dataset.cancel : Number(b.dataset.cancel));
    if (j?.xhr) j.xhr.abort(); else api(`fs/jobs/${b.dataset.cancel}/cancel`, {});
  });
  $$("[data-dismiss]", box).forEach(b => b.onclick = () => {
    S.jobs.delete(isNaN(b.dataset.dismiss) ? b.dataset.dismiss : Number(b.dataset.dismiss)); renderJobs();
  });
}

// ---------------------------------------------------------------- favorites
async function toggleFav(p) {
  const i = S.favorites.findIndex(f => f.root === p.root && f.dir === p.dir);
  if (i >= 0) S.favorites.splice(i, 1);
  else {
    const label = await ask({ title: "즐겨찾기 추가", message: `${p.base}/${p.dir}`, input: p.dir.split("/").pop() || p.base, ok: "추가" });
    if (label === null) return;
    S.favorites.push({ root: p.root, dir: p.dir, label });
  }
  await api("fs/favorites", { favorites: S.favorites }).catch(e => toast(e.message));
}

// ---------------------------------------------------------------- lazy duration probe (media pane)
let probeQueue = [], probing = 0;
function probeVisible(p) {
  for (const it of p.view) {
    if (it.dir || !it.kind || it.kind === "image" || probeCache.has(it.path)) continue;
    probeCache.set(it.path, "pending");
    probeQueue.push(it.path);
  }
  pump();
}
function pump() {
  while (probing < 3 && probeQueue.length) {
    const path = probeQueue.shift();
    probing++;
    api(`media/probe?file=${encodeURIComponent(path)}`)
      .then(r => probeCache.set(path, r)).catch(() => probeCache.set(path, "error"))
      .finally(() => { probing--; repaintSoon(); pump(); });
  }
}
let repaintT;
function repaintSoon() { clearTimeout(repaintT); repaintT = setTimeout(() => panes[0].paint(), 150); }

// ---------------------------------------------------------------- player window links
function renderPlayers() {
  $("#players").innerHTML = (S.info?.channels ?? []).map(c =>
    `<button class="linkbtn" data-open="${c.channel_index}" title="재생 제어창 열기">${esc(c.name)} ↗</button>`).join("");
  $$("[data-open]").forEach(b => b.onclick = () => window.open(`/player.html?ch=${b.dataset.open}`, `sendust_player_${b.dataset.open}`));
}

// ---------------------------------------------------------------- WS
const dot = (id, on) => $(id).classList.toggle("on", !!on);
let started = false;
connectWs(async m => {
  if (m.type === "hello") {
    S.info = m.info;
    document.title = `${m.info.title} [Media Browser] {${m.info.stamp}}`;
    S.favorites = m.favorites || [];
    for (const j of m.jobs || []) S.jobs.set(j.id, j);
    renderJobs();
    renderPlayers();
    if (!started) {
      started = true;
      try { S.session = (await api("session")).session || {}; } catch { S.session = {}; }
      for (const p of panes) {
        const s = S.session.browser?.[p.root];
        if (s) { p.sort = s.sort || "name"; p.desc = !!s.desc; }
        await p.open(s?.dir || "");
      }
    }
  }
  if (m.type === "hello" || m.type === "tick") dot("#d-amcp", m.amcp);
  if (m.type === "amcp") dot("#d-amcp", m.connected);
  if (m.type === "favorites") { S.favorites = m.favorites; panes.forEach(p => p.renderFavs()); }
  if (m.type === "job") {
    S.jobs.set(m.job.id, m.job); renderJobs();
    if (m.refresh) panes.forEach(p => p.open(p.dir, true));
  }
  if (m.type === "fs") panes.forEach(p => { if (p.root === m.root && p.dir === m.dir) p.open(p.dir, true); });
}, on => dot("#d-ws", on));
