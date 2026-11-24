// Media browser (uBrowser-like): upper pane = CasparCG media path, lower pane = one favourite path,
// each with a folder tree and a file list; "전송하기" copies the lower selection into the upper folder.
import { $, $$, api, connectWs, durTc, fmtBytes, esc, ask, toast, DND_MEDIA, addLogout, openWin } from "./common.js";
import { initTheme } from "./theme.js";

const S = { info: null, favorites: [], jobs: new Map(), session: {}, active: null };
const probeCache = new Map();   // media rel path -> probe | "pending" | "error"
let dragSource = null;

const extOf = n => { const i = n.lastIndexOf("."); return i > 0 ? n.slice(i + 1).toLowerCase() : ""; };
const fmtDate = t => new Date(t * 1000).toLocaleString("ko-KR", { hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

let saveT;
function saveSession() {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    api("session", { browser2: { mediaDir: media.dir, favIdx: fav.favIdx, favDir: fav.dir,
      sort: Object.fromEntries(panes.map(p => [p.el.id, [p.sort, p.desc]])) } }).catch(() => {});
  }, 500);
}

// ================================================================ pane = tree + list
class Pane {
  constructor(el) {
    this.el = el;
    this.root = el.dataset.root;
    this.tree = $(".tree", el);
    this.list = $(".fl", el);
    this.tbody = $("tbody", el);
    this.top = "";              // tree root (rel to the root): "" for media, the favourite dir for the lower pane
    this.dir = "";
    this.items = []; this.view = [];
    this.sel = new Set(); this.cursor = 0; this.anchor = 0;
    this.sort = "name"; this.desc = false; this.filter = "";
    this.nodes = new Map();     // rel dir -> {open, kids: [rel] | null}
    this._bind();
  }

  get base() { return this.root === "media" ? S.info?.media_path : S.info?.host_root; }
  absLabel(rel) { return `${this.base}${rel ? "/" + rel : ""}`; }

  _bind() {
    const el = this.el;
    el.addEventListener("mousedown", () => setActive(this));
    $$("[data-op]", el).forEach(b => { b.addEventListener("mousedown", e => e.preventDefault()); b.onclick = () => this.op(b.dataset.op); });
    $(".filter", el).oninput = e => { this.filter = e.target.value.toLowerCase(); this.render(); };
    $$("th[data-sort]", el).forEach(th => th.onclick = () => {
      const k = th.dataset.sort;
      if (this.sort === k) this.desc = !this.desc; else { this.sort = k; this.desc = false; }
      this.render(); saveSession();
    });
    this.tbody.addEventListener("click", e => { const tr = e.target.closest("tr"); if (tr) this.clickRow(Number(tr.dataset.i), e); });
    this.tbody.addEventListener("dblclick", e => { const tr = e.target.closest("tr"); if (tr) this.activate(Number(tr.dataset.i)); });
    this.list.addEventListener("keydown", e => this.key(e));
    this.tree.addEventListener("click", e => {
      const n = e.target.closest(".tnode"); if (!n) return;
      const rel = n.dataset.rel;
      if (e.target.closest(".tw")) this.toggle(rel); else this.open(rel);
    });
    this.tree.addEventListener("dblclick", e => { const n = e.target.closest(".tnode"); if (n) this.toggle(n.dataset.rel); });

    // drag rows out: to a playback window's playlist, or from the favourite pane up to the media pane
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
    if (this.root !== "media") return;
    el.addEventListener("dragover", e => {
      const t = e.dataTransfer.types;
      if (t.includes("Files")) { e.preventDefault(); el.classList.add("dragover"); }
      else if (t.includes(DND_MEDIA) && dragSource && dragSource !== this) { e.preventDefault(); el.classList.add("dragtarget"); }
    });
    el.addEventListener("dragleave", e => { if (!el.contains(e.relatedTarget)) el.classList.remove("dragover", "dragtarget"); });
    el.addEventListener("drop", e => {
      el.classList.remove("dragover", "dragtarget");
      if (e.dataTransfer.files.length) { e.preventDefault(); upload(this, [...e.dataTransfer.files]); return; }
      const raw = e.dataTransfer.getData(DND_MEDIA);
      if (!raw || !dragSource || dragSource === this) return;
      e.preventDefault();
      transfer(dragSource, JSON.parse(raw).paths);
    });
  }

  // ---- tree ------------------------------------------------------------
  async kids(rel) {
    let n = this.nodes.get(rel);
    if (!n) this.nodes.set(rel, n = { open: false, kids: null });
    if (n.kids) return n.kids;
    try {
      const r = await api(`fs/list?root=${this.root}&dir=${encodeURIComponent(rel)}`);
      n.kids = r.items.filter(i => i.dir).map(i => i.path).sort((a, b) => a.localeCompare(b, "ko", { numeric: true }));
    } catch { n.kids = []; }
    return n.kids;
  }
  async toggle(rel) {
    const n = this.nodes.get(rel) || { open: false, kids: null };
    this.nodes.set(rel, n);
    n.open = !n.open;
    if (n.open) await this.kids(rel);
    this.renderTree();
  }
  async reveal(rel) {   // expand every ancestor of rel (below top)
    const parts = rel.slice(this.top ? this.top.length + 1 : 0).split("/").filter(Boolean);
    let cur = this.top;
    for (let i = 0; i <= parts.length; i++) {
      const n = this.nodes.get(cur) || { open: false, kids: null };
      this.nodes.set(cur, n);
      n.open = true;   // the opened folder unfolds too (one click shows its files and subfolders)
      await this.kids(cur);
      if (i < parts.length) cur = cur ? `${cur}/${parts[i]}` : parts[i];
    }
    this.renderTree();
  }
  renderTree() {
    const out = [];
    const walk = (rel, depth) => {
      const n = this.nodes.get(rel);
      const name = rel === this.top ? (this.root === "media" ? this.absLabel(this.top) : this.absLabel(this.top)) : rel.split("/").pop();
      const hasKids = !n || n.kids === null || n.kids.length > 0;
      out.push(`<div class="tnode ${rel === this.dir ? "cur" : ""}" data-rel="${esc(rel)}" style="padding-left:${6 + depth * 16}px">
        <span class="tw">${hasKids ? (n?.open ? "▾" : "▸") : ""}</span><span class="ic">▰</span><span>${esc(name)}</span></div>`);
      if (n?.open && n.kids) for (const k of n.kids) walk(k, depth + 1);
    };
    walk(this.top, 0);
    this.tree.innerHTML = out.join("");
    this.tree.querySelector(".tnode.cur")?.scrollIntoView({ block: "nearest" });
  }
  async setTop(top) {
    this.top = top;
    this.nodes.clear();
    await this.kids(top);
    this.nodes.get(top).open = true;
    await this.open(top);
  }

  // ---- list ------------------------------------------------------------
  async open(dir = this.dir, keepSel = false) {
    try {
      const r = await api(`fs/list?root=${this.root}&dir=${encodeURIComponent(dir)}`);
      const changed = dir !== this.dir;
      this.dir = dir;
      this.items = r.items;
      const n = this.nodes.get(dir);
      if (n) n.kids = r.items.filter(i => i.dir).map(i => i.path).sort((a, b) => a.localeCompare(b, "ko", { numeric: true }));
      if (!keepSel || changed) { this.sel.clear(); this.cursor = 0; this.anchor = 0; }
      if (changed) { this.filter = ""; $(".filter", this.el).value = ""; }
      await this.reveal(dir);
      this.render();
      saveSession();
    } catch (e) {
      toast(`${this.root}: ${e.message}`);
      if (dir !== this.top) this.open(this.top);
    }
  }
  parent() { return this.dir === this.top ? this.top : this.dir.split("/").slice(0, -1).join("/"); }

  render() {
    const key = this.sort, dir = this.desc ? -1 : 1;
    const val = it => key === "dur" ? (probeCache.get(it.path)?.duration ?? -1) : key === "ext" ? extOf(it.name) : it[key];
    const v = this.items.filter(it => !this.filter || it.name.toLowerCase().includes(this.filter));
    v.sort((a, b) => (b.dir - a.dir) || (key === "name"
      ? a.name.localeCompare(b.name, "ko", { numeric: true }) * dir
      : ((val(a) > val(b)) - (val(a) < val(b))) * dir || a.name.localeCompare(b.name, "ko", { numeric: true })));
    if (this.dir !== this.top) v.unshift({ name: "..", dir: true, up: true, path: this.parent() });
    this.view = v;
    this.cursor = Math.min(Math.max(0, this.cursor), v.length - 1);
    $$("th[data-sort]", this.el).forEach(th => {
      th.classList.toggle("sorted", th.dataset.sort === this.sort);
      th.classList.toggle("desc", th.dataset.sort === this.sort && this.desc);
    });
    const rel = this.dir.slice(this.top.length).split("/").filter(Boolean);
    $(".crumbs", this.el).innerHTML = `<a data-d="${esc(this.top)}">${esc(this.absLabel(this.top))}</a>` +
      rel.map((p, i) => `/<a data-d="${esc([this.top, ...rel.slice(0, i + 1)].filter(Boolean).join("/"))}">${esc(p)}</a>`).join("");
    $$(".crumbs a", this.el).forEach(a => a.onclick = () => this.open(a.dataset.d));
    this.paint();
    if (this.root === "media") probeVisible(this);
  }

  paint() {
    this.tbody.innerHTML = this.view.map((it, i) => {
      const cls = [it.dir ? "dir" : `k-${it.kind || ""}`, this.sel.has(it.path) && !it.up ? "sel" : "", i === this.cursor ? "cursor" : ""].join(" ");
      const pr = probeCache.get(it.path);
      const dur = this.root !== "media" || it.dir || !it.kind || it.kind === "image" ? "" :
        pr && typeof pr === "object" ? durTc(pr.frames, pr) : pr === "error" ? "?" : "…";
      return `<tr class="${cls}" data-i="${i}" draggable="${!it.up}">
        <td class="name" title="${esc(it.name)}">${it.dir ? "▰ " : ""}${esc(it.dir ? it.name : it.name.replace(/\.[^.]+$/, ""))}</td>
        <td class="ext">${it.dir ? "" : esc(extOf(it.name))}</td>
        <td class="r dur">${dur}</td>
        <td class="r num">${it.dir ? "" : fmtBytes(it.size)}</td>
        <td class="r num">${it.up ? "" : fmtDate(it.mtime)}</td></tr>`;
    }).join("");
    const nsel = this.sel.size, bytes = this.selected().reduce((a, x) => a + (x.size || 0), 0);
    $(".count", this.el).textContent = nsel ? `${nsel} 선택 · ${fmtBytes(bytes)}` : `${this.items.filter(x => !x.dir).length} files`;
    this.tbody.querySelector("tr.cursor")?.scrollIntoView({ block: "nearest" });
    renderSendTo();
  }

  selected() {
    const s = this.view.filter(it => !it.up && this.sel.has(it.path));
    if (s.length) return s;
    const c = this.view[this.cursor];
    return c && !c.up ? [c] : [];
  }

  clickRow(i, e) {
    const it = this.view[i]; if (!it) return;
    if (e.shiftKey) {
      if (!e.ctrlKey) this.sel.clear();
      for (let k = Math.min(this.anchor, i); k <= Math.max(this.anchor, i); k++) if (!this.view[k].up) this.sel.add(this.view[k].path);
    } else if (e.ctrlKey || e.metaKey) {
      if (!it.up) this.sel.has(it.path) ? this.sel.delete(it.path) : this.sel.add(it.path);
      this.anchor = i;
    } else { this.sel = new Set(it.up ? [] : [it.path]); this.anchor = i; }
    this.cursor = i;
    this.paint();
  }
  activate(i) { const it = this.view[i]; if (it?.dir) this.open(it.path); }

  key(e) {
    const n = this.view.length;
    const move = d => {
      const i = Math.max(0, Math.min(n - 1, this.cursor + d));
      if (e.shiftKey) {
        this.sel.clear();
        for (let k = Math.min(this.anchor, i); k <= Math.max(this.anchor, i); k++) if (!this.view[k].up) this.sel.add(this.view[k].path);
      } else { this.sel.clear(); this.anchor = i; const it = this.view[i]; if (it && !it.up) this.sel.add(it.path); }
      this.cursor = i; this.paint();
    };
    const k = e.key; let h = true;
    if (k === "ArrowDown") move(1);
    else if (k === "ArrowUp") move(-1);
    else if (k === "PageDown") move(15);
    else if (k === "PageUp") move(-15);
    else if (k === "Home") move(-n);
    else if (k === "End") move(n);
    else if (k === "Enter") this.activate(this.cursor);
    else if (k === "Backspace") { if (this.dir !== this.top) this.open(this.parent()); }
    else if (k === "Tab") setActive(this === media ? fav : media, true);
    else if (k === "a" && e.ctrlKey) { this.view.forEach(it => !it.up && this.sel.add(it.path)); this.paint(); }
    else if (k === "F2") this.op("rename");
    else if (k === "F5") this.op("transfer");
    else if (k === "F7") this.op("mkdir");
    else if (k === "Delete" || k === "F8") this.op("delete");
    else if (k === "F9") this.op("refresh");
    else h = false;
    if (h) e.preventDefault();
  }

  async op(op) {
    const sel = this.selected();
    try {
      if (op === "refresh") { this.nodes.forEach(n => { n.kids = null; }); await this.open(this.dir, true); }
      else if (op === "transfer") { if (this !== media && sel.length) transfer(this, sel.map(x => x.path)); }
      else if (op === "favadd") toggleFav(this.dir, true);
      else if (op === "favdel") removeFav();
      else if (this.root !== "media") return;   // file operations only in the CasparCG media pane
      else if (op === "mkdir") {
        const name = await ask({ title: "새 폴더", message: this.absLabel(this.dir), input: "", ok: "만들기" });
        if (name) { await api("fs/mkdir", { root: this.root, dir: this.dir, name }); this.nodes.forEach(n => { n.kids = null; }); this.open(this.dir, true); }
      } else if (op === "rename") {
        if (sel.length !== 1) return toast("이름을 바꿀 항목 하나를 선택하세요");
        const name = await ask({ title: "이름 변경", message: sel[0].name, input: sel[0].name, ok: "변경" });
        if (name && name !== sel[0].name) { await api("fs/rename", { root: this.root, dir: this.dir, path: sel[0].path, name }); this.open(this.dir, true); }
      } else if (op === "delete") {
        if (!sel.length) return;
        const ok = await ask({ title: `삭제 (${sel.length})`, message: `${this.absLabel(this.dir)} 에서 영구 삭제합니다. 폴더는 내용까지 삭제됩니다.`,
          list: sel.map(x => x.name + (x.dir ? "/" : "")), ok: "삭제", danger: true });
        if (ok) await api("fs/delete", { root: this.root, paths: sel.map(x => x.path) });
      }
    } catch (e) { toast(`${op}: ${e.message}`); }
  }
}

const media = new Pane($("#pane-media"));
const fav = new Pane($("#pane-fav"));
fav.favIdx = 0;
const panes = [media, fav];
function setActive(p, focus = false) {
  S.active = p;
  panes.forEach(x => x.el.classList.toggle("active", x === p));
  if (focus) p.list.focus();
}
setActive(media);

// ================================================================ favourites (lower pane root)
function favList() {
  const host = S.favorites.filter(f => f.root === "host");
  return host.length ? host : [{ root: "host", dir: "", label: S.info?.host_root || "/mnt" }];
}
function renderFavSel() {
  const sel = $(".favsel", fav.el);
  const list = favList();
  sel.innerHTML = list.map((f, i) => `<option value="${i}">${esc(f.label || f.dir || "/")}</option>`).join("");
  sel.value = String(Math.min(fav.favIdx, list.length - 1));
}
$(".favsel", fav.el).onchange = e => { fav.favIdx = Number(e.target.value); fav.setTop(favList()[fav.favIdx].dir); saveSession(); };
async function toggleFav(dir) {
  if (S.favorites.some(f => f.root === "host" && f.dir === dir)) return toast("이미 즐겨찾기에 있습니다");
  const label = await ask({ title: "즐겨찾기 추가", message: fav.absLabel(dir), input: dir.split("/").pop() || "/", ok: "추가" });
  if (label === null) return;
  S.favorites.push({ root: "host", dir, label });
  await api("fs/favorites", { favorites: S.favorites });
  fav.favIdx = favList().findIndex(f => f.dir === dir);
}
async function removeFav() {
  const f = favList()[fav.favIdx];
  const i = S.favorites.indexOf(f);
  if (i < 0) return toast("기본 경로는 지울 수 없습니다");
  if (!await ask({ title: "즐겨찾기 삭제", message: f.label || f.dir, ok: "삭제", danger: true })) return;
  S.favorites.splice(i, 1);
  await api("fs/favorites", { favorites: S.favorites });
  fav.favIdx = 0;
  fav.setTop(favList()[0].dir);
}

// ================================================================ transfer (copy into the media pane folder)
async function transfer(src, paths) {
  const body = { root: src.root, paths, dst_root: "media", dst_dir: media.dir, overwrite: false };
  try {
    await api("fs/copy", body);
  } catch (e) {
    if (e.status === 409) {
      if (await ask({ title: "덮어쓰기?", message: `${media.absLabel(media.dir)} 에 같은 이름이 있습니다.`, list: e.detail.conflicts, ok: "덮어쓰기", danger: true }))
        await api("fs/copy", { ...body, overwrite: true }).catch(x => toast(x.message));
    } else toast(`전송: ${e.message}`);
  }
}

let upSeq = 0;
async function upload(pane, files) {
  for (const f of files) {
    let overwrite = false;
    if (pane.items.some(it => it.name === f.name)) {
      if (!await ask({ title: "덮어쓰기?", message: `${f.name} 이(가) 이미 있습니다.`, ok: "덮어쓰기", danger: true })) continue;
      overwrite = true;
    }
    const id = `u${++upSeq}`;
    const job = { id, kind: "upload", src: `PC: ${f.name}`, dst: pane.absLabel(pane.dir), status: "running", total: f.size, done: 0, started: Date.now() / 1000 };
    S.jobs.set(id, job); renderJobs();
    await new Promise(resolve => {
      const x = new XMLHttpRequest();
      x.open("PUT", `/api/v1/fs/upload?root=${pane.root}&dir=${encodeURIComponent(pane.dir)}&name=${encodeURIComponent(f.name)}&overwrite=${overwrite}`);
      x.upload.onprogress = e => { job.done = e.loaded; renderJobs(); };
      x.onload = () => {
        job.status = x.status < 300 ? "done" : "error";
        if (x.status >= 300) { try { const d = JSON.parse(x.responseText).detail; job.error = d?.message || d; } catch { job.error = x.statusText; } }
        if (job.status === "done") job.done = f.size;
        renderJobs(); resolve();
      };
      x.onerror = () => { job.status = "error"; job.error = "network error"; renderJobs(); resolve(); };
      job.xhr = x;
      x.send(f);
    });
  }
}

const ST = { running: "전송중", done: "전송완료", error: "오류", cancelled: "취소" };
function renderJobs() {
  const list = [...S.jobs.values()].filter(j => j.kind !== "delete").sort((a, b) => (b.started || 0) - (a.started || 0));
  $("#xbody").innerHTML = list.map(j => {
    const pct = j.total ? Math.min(100, j.done / j.total * 100) : (j.status === "done" ? 100 : 0);
    const id = esc(String(j.id));
    return `<tr class="${j.status}" title="${esc(j.error || "")}">
      <td title="${esc(j.src || j.desc)}">${esc(j.src || j.desc)}</td>
      <td class="c arrow">${j.kind === "move" ? "⇒" : "➜"}</td>
      <td title="${esc(j.dst || "")}">${esc(j.dst || "")}</td>
      <td><div class="xbar"><span class="b"><i style="width:${pct}%"></i></span><span class="mono">${Math.round(pct)}%</span></div></td>
      <td class="r mono">${fmtBytes(j.total || 0)}</td>
      <td class="c st">${esc(ST[j.status] || j.status)}${j.error ? " ⚠" : ""}</td>
      <td>${j.status === "running" ? `<button class="ibtn" data-cancel="${id}">취소</button>` : ""}</td></tr>`;
  }).join("") || '<tr><td colspan="7" class="dim" style="text-align:center">전송 내역이 없습니다 · 아래 판넬에서 선택 후 "전송하기" (F5) 또는 위 판넬로 끌어다 놓기</td></tr>';
  $$("[data-cancel]").forEach(b => b.onclick = () => {
    const k = isNaN(b.dataset.cancel) ? b.dataset.cancel : Number(b.dataset.cancel);
    const j = S.jobs.get(k);
    if (j?.xhr) j.xhr.abort(); else api(`fs/jobs/${k}/cancel`, {});
  });
}
$("#x-clear").onclick = () => { for (const [k, j] of S.jobs) if (j.status !== "running") S.jobs.delete(k); renderJobs(); };

// ================================================================ duration probe (media pane)
const probeQ = []; let probing = 0;
function probeVisible(p) {
  for (const it of p.view) {
    if (it.dir || !it.kind || it.kind === "image" || probeCache.has(it.path)) continue;
    probeCache.set(it.path, "pending"); probeQ.push(it.path);
  }
  pump();
}
function pump() {
  while (probing < 2 && probeQ.length) {   // keep browser connections (6 per server, all windows) free
    const path = probeQ.shift(); probing++;
    api(`media/probe?file=${encodeURIComponent(path)}`).then(r => probeCache.set(path, r)).catch(() => probeCache.set(path, "error"))
      .finally(() => { probing--; clearTimeout(pump.t); pump.t = setTimeout(() => media.paint(), 150); pump(); });
  }
}

// ================================================================ playback windows
// Title bar: per channel "+ PLAY n" (add the files selected in the CasparCG MEDIA panel to the end of
// that channel's playlist) and "↗" (open its playback window). The same add buttons sit under the panel.
function renderPlayers() {
  $("#players").innerHTML = (S.info?.channels ?? []).map(c => `<span class="pgrp">
    <button class="ubtn sm cyan" data-add="${c.channel_index}" title="CasparCG MEDIA 에서 선택한 클립을 ${esc(c.name)} 플레이리스트 끝에 추가">+ ${esc(c.name)}</button>
    <button class="ubtn sm" data-open="${c.channel_index}" title="${esc(c.name)} 재생 창 열기">↗</button></span>`).join("");
  $$("[data-open]").forEach(b => b.onclick = () => openWin(`/player.html?ch=${b.dataset.open}`, `sendust_player_${b.dataset.open}`, 885, 1050));
  $$("#players [data-add]").forEach(b => b.onclick = () => addTo(Number(b.dataset.add)));
  renderSendTo();
}
const selectedClips = () => media.selected().filter(x => !x.dir && x.kind).map(x => x.path);
async function addTo(ch) {
  const fs = selectedClips(), name = S.info.channels.find(c => c.channel_index === ch)?.name ?? `CH ${ch}`;
  if (!fs.length) return toast("CasparCG MEDIA 판넬에서 클립을 먼저 선택하세요");
  try { await api(`ch/${ch}/playlist/add`, { files: fs }); toast(`${fs.length} clip(s) → ${name}`, 1500); }
  catch (e) { toast(e.message); }
}
function renderSendTo() {
  const box = $(".sendto", media.el);
  if (!S.info) return;
  const n = selectedClips().length;
  box.innerHTML = S.info.channels.map(c =>
    `<button class="ubtn sm cyan" data-ch="${c.channel_index}" ${n ? "" : "disabled"} title="선택한 파일을 ${esc(c.name)} 플레이리스트 끝에 추가">→ ${esc(c.name)}</button>`).join("");
  $$("[data-ch]", box).forEach(b => b.onclick = () => addTo(Number(b.dataset.ch)));
  $$("#players [data-add]").forEach(b => b.classList.toggle("dim", !n));
}

// ================================================================ WS
const dot = (id, on) => $(id).classList.toggle("on", !!on);
let started = false;
connectWs(async m => {
  if (m.type === "hello") {
    S.info = m.info;
    document.title = `${m.info.title} [Media Browser] {${m.info.stamp}}`;
    S.favorites = m.favorites || [];
    for (const j of m.jobs || []) S.jobs.set(j.id, j);
    renderJobs(); renderPlayers();
    addLogout(m.info, $(".ub-title"));
    if (!started) {
      started = true;
      try { S.session = (await api("session")).session?.browser2 || {}; } catch { S.session = {}; }
      for (const p of panes) { const s = S.session.sort?.[p.el.id]; if (s) [p.sort, p.desc] = [s[0], !!s[1]]; }
      fav.favIdx = Math.min(S.session.favIdx ?? 0, favList().length - 1);
      renderFavSel();
      await media.setTop("");
      if (S.session.mediaDir) await media.open(S.session.mediaDir);
      await fav.setTop(favList()[fav.favIdx].dir);
      if (S.session.favDir && S.session.favDir.startsWith(fav.top)) await fav.open(S.session.favDir);
    }
  }
  if (m.type === "hello" || m.type === "tick") dot("#d-amcp", m.amcp);
  if (m.type === "amcp") dot("#d-amcp", m.connected);
  if (m.type === "favorites") { S.favorites = m.favorites; renderFavSel(); }
  if (m.type === "job") {
    const prev = S.jobs.get(m.job.id);
    S.jobs.set(m.job.id, { ...prev, ...m.job }); renderJobs();
    if (m.refresh) panes.forEach(p => p.open(p.dir, true));
  }
  if (m.type === "fs") panes.forEach(p => { if (p.root === m.root && p.dir === m.dir) p.open(p.dir, true); });
}, on => dot("#d-ws", on));


// ---------------------------------------------------------------- pane heights
// The three panels (CasparCG media / favourite / transfer status) are separated by two drag bars.
// Heights are kept as flex-grow weights (= px at the time of the drag), so the split stays
// proportional when the window is resized; remembered per browser, double-click = default.
{
  const panes = [$("#pane-media"), $("#pane-fav"), $(".xfers")];
  const MIN = 90, KEY = "sp.ubPanes";
  const apply = hs => panes.forEach((p, i) => { p.style.flex = hs ? `${hs[i]} 1 0` : ""; });
  try { const hs = JSON.parse(localStorage.getItem(KEY)); if (Array.isArray(hs) && hs.length === 3) apply(hs); } catch { /* none */ }
  for (const bar of $$(".ub > .vsplit")) {
    const k = Number(bar.dataset.split);   // between panes[k] and panes[k + 1]
    bar.addEventListener("pointerdown", e => {
      e.preventDefault();
      const hs = panes.map(p => p.getBoundingClientRect().height), y0 = e.clientY;
      const pair = hs[k] + hs[k + 1];
      bar.setPointerCapture(e.pointerId);
      bar.classList.add("drag");
      const move = ev => {
        const a = Math.max(MIN, Math.min(pair - MIN, hs[k] + ev.clientY - y0));
        const cur = [...hs]; cur[k] = a; cur[k + 1] = pair - a;
        apply(cur);
        bar._hs = cur;
      };
      const up = () => {
        bar.removeEventListener("pointermove", move); bar.removeEventListener("pointerup", up);
        bar.classList.remove("drag");
        if (bar._hs) try { localStorage.setItem(KEY, JSON.stringify(bar._hs.map(Math.round))); } catch { /* private mode */ }
      };
      bar.addEventListener("pointermove", move);
      bar.addEventListener("pointerup", up);
    });
    bar.addEventListener("dblclick", () => { apply(null); try { localStorage.removeItem(KEY); } catch { /* */ } });
  }
}

initTheme(document.getElementById("btn-theme"), "sp.theme.browser");
