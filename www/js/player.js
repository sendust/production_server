// Playback control window: one page per playback channel (?ch=<channel_index>).
import { $, $$, api, connectWs, framesToTc, durTc, tcToFrames, fmtBytes, esc } from "./common.js";
import { Timeline } from "./timeline.js";
import { Meter } from "./meter.js";

const CH = Number(new URLSearchParams(location.search).get("ch") ?? 0);
const S = {
  info: null,         // /api/v1/info
  p: null,            // latest player snapshot
  recvAt: 0,          // performance.now() when p arrived
  engine: null,
  logs: [],
};

// ---------------------------------------------------------------- helpers
function toast(msg) {
  const t = document.createElement("div");
  t.className = "toast"; t.textContent = msg;
  document.body.append(t);
  setTimeout(() => t.remove(), 3500);
}

async function cmd(action, body) {
  try {
    const r = await api(`ch/${CH}/${action}`, body ?? {});
    if (r.player) applyPlayer(r.player);
    return r;
  } catch (e) {
    toast(`${action}: ${e.message}`);
  }
}

const loaded = () => S.p?.loaded;
const fpsOf = () => loaded()?.info?.fps || [30000, 1001];
const fpsR = () => { const f = fpsOf(); return f[0] / f[1]; };
const tcStart = () => { const l = loaded(); return l ? (tcToFrames(l.info.tc_start, l.info.fps) ?? 0) : 0; };

// position interpolated between 20 Hz ticks while playing
function livePos() {
  const p = S.p;
  if (!p || p.pos == null) return null;
  if (p.status !== "playing") return p.pos;
  const f = p.pos + (performance.now() - S.recvAt) / 1000 * fpsR();
  const l = p.loaded;
  if (p.loop) return f;  // wraps at next tick
  return Math.min(Math.floor(f), l.out - 1);
}

// ---------------------------------------------------------------- UI build
const timeline = new Timeline($("#timeline"), {
  onScrubStart: () => { if (S.p?.status === "playing") cmd("pause"); },
  onScrub: (f, final) => scrubTo(f, final),
});
const meter = new Meter($("#meter"));

let scrubBusy = false, scrubPending = null;
async function scrubTo(f, final) {
  if (S.p) { S.p.pos = f; S.recvAt = performance.now(); }   // optimistic playhead
  scrubPending = f;
  if (scrubBusy) return;
  scrubBusy = true;
  while (scrubPending != null) {
    const g = scrubPending; scrubPending = null;
    await cmd("seek", { frame: g });
    await new Promise(r => setTimeout(r, final ? 0 : 40));
  }
  scrubBusy = false;
}

function renderStatic() {
  const p = S.p, l = p?.loaded;
  const title = `${S.info?.title ?? "sendust playlist"} [${p?.name ?? `CH ${CH}`}] {${S.info?.stamp ?? ""}}`;
  if (document.title !== title) document.title = title;
  $("#chname").textContent = p?.name ?? `CH ${CH}`;
  const dl = a => a?.length ? `DeckLink ${a.join(",")}` : "—";
  $("#route").innerHTML = p ? [
    `<span class="tag">CLEAN <b>CH${p.clean}-${p.layer}</b> → ${dl(p.decklink)}</span>`,
    p.osd ? `<span class="tag">OSD <b>CH${p.osd}</b> → ${dl(p.osd_decklink)}</span>` : "",
  ].join("") : "";

  const st = p?.status ?? "empty";
  const se = $("#state");
  se.textContent = st; se.className = `state ${st}`;
  const pb = $("#btn-play");
  pb.classList.toggle("active", st === "playing");
  pb.querySelector("span").textContent = st === "playing" ? "PAUSE" : "PLAY";
  pb.querySelector("svg").innerHTML = st === "playing" ? '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>' : '<path d="M7 5v14l12-7z"/>';

  $("#fname").textContent = l ? l.file : "—";
  if (l) {
    const i = l.info, v = i.video, a = i.audio;
    const parts = [
      `<span><b>${esc(i.kind)}</b> ${esc(i.format)}</span>`,
      v ? `<span><b>${esc(v.codec)}</b> ${esc(v.profile ?? "")} ${v.width}×${v.height} ${esc(v.field_order ?? "")}</span>` : "",
      i.kind !== "image" ? `<span>${(i.fps[0] / i.fps[1]).toFixed(2)} fps${i.drop ? " DF" : ""}</span>` : "",
      v?.bitrate ? `<span>${(v.bitrate / 1e6).toFixed(0)} Mb/s</span>` : "",
      a.channels ? `<span>audio <b>${a.channels}ch</b> ${esc(a.codec)} ${a.sample_rate / 1000}k</span>` : "",
      i.kind !== "image" ? `<span>dur <b class="mono">${durTc(i.frames, i)}</b></span>` : "",
      `<span>start TC <b class="mono">${esc(i.tc_start)}</b></span>`,
      `<span>${fmtBytes(i.size)}</span>`,
    ];
    $("#meta").innerHTML = parts.join("");
    meter.setChannels(Math.min(a.channels || 8, 16));
  } else {
    $("#meta").innerHTML = '<span>no clip loaded</span>';
  }
  $("#loopmode").value = p?.loop_mode ?? "none";
}

function renderLive() {
  const p = S.p, l = p?.loaded;
  const pos = livePos();
  if (l && pos != null && l.info.kind !== "image") {
    const i = l.info, ts = tcStart();
    $("#tc").textContent = framesToTc(ts + pos, i.fps, i.drop);
    $("#tc-el").textContent = durTc(Math.max(0, pos - l.in), i);
    const rem = Math.max(0, l.out - pos - 1);
    $("#tc-rem").textContent = durTc(rem, i);
    $("#box-rem").classList.toggle("alert", p.status === "playing" && rem < fpsR() * 10);
    $("#tc-in").textContent = framesToTc(ts + l.in, i.fps, i.drop);
    $("#tc-out").textContent = `${framesToTc(ts + l.out, i.fps, i.drop)} · ${durTc(l.out - l.in, i)}`;
  } else {
    for (const id of ["#tc-el", "#tc-rem", "#tc-in", "#tc-out"]) $(id).textContent = "--";
    $("#tc").textContent = "--:--:--:--";
  }
  timeline.set(l && l.info.kind !== "image" ? {
    length: l.info.frames, fin: l.in, fout: l.out, pos, tcStart: tcStart(),
    fps: l.info.fps, drop: l.info.drop, zoomSec: S.info?.zoom_timeline?.seconds ?? 5,
  } : { length: 0, pos: null });
  requestAnimationFrame(renderLive);
}

function applyPlayer(p) {
  const prevKey = JSON.stringify([S.p?.status, S.p?.loaded, S.p?.loop_mode, S.p?.decklink, S.p?.osd_decklink]);
  const vol = p.volume;
  S.p = p; S.recvAt = performance.now();
  if (vol?.length) meter.push(vol);
  if (JSON.stringify([p.status, p.loaded, p.loop_mode, p.decklink, p.osd_decklink]) !== prevKey) renderStatic();
}

// ---------------------------------------------------------------- logs
const fmtTime = t => new Date(t * 1000).toLocaleTimeString("ko-KR", { hour12: false });
function addLog(e) {
  S.logs.push(e);
  if (S.logs.length > 200) S.logs.shift();
  $("#status-t").textContent = fmtTime(e.t);
  const m = $("#status-msg");
  m.textContent = e.msg; m.className = `msg ${e.level}`;
  const pane = $("#logpane");
  const d = document.createElement("div");
  d.className = e.level; d.textContent = `${fmtTime(e.t)}  ${e.msg}`;
  pane.prepend(d);
  while (pane.childElementCount > 200) pane.lastChild.remove();
}
$("#status").onclick = () => $("#logpane").classList.toggle("hidden");

// ---------------------------------------------------------------- WS
const dot = (id, on) => $(id).classList.toggle("on", !!on);
connectWs(m => {
  if (m.type === "hello") {
    S.info = m.info;
    $("#logpane").innerHTML = "";
    S.logs = [];
    (m.logs?.[CH] ?? []).forEach(addLog);
  }
  if (m.type === "hello" || m.type === "tick") {
    S.engine = m.engine;
    dot("#d-amcp", m.amcp); dot("#d-osc", m.engine?.osc_alive);
    const p = m.players?.find(x => x.idx === CH);
    if (p) applyPlayer(p);
    if (m.type === "hello") renderStatic();
  }
  if (m.type === "amcp") dot("#d-amcp", m.connected);
  if (m.type === "log" && m.ch === CH) addLog(m.entry);
}, on => dot("#d-ws", on));

// ---------------------------------------------------------------- transport
$$("[data-act]").forEach(b => b.onclick = () => cmd(b.dataset.act));
const stepVal = v => v.endsWith("s") ? Math.round(parseFloat(v) * fpsR()) : parseInt(v, 10);
$$("[data-step]").forEach(b => b.onclick = () => cmd("step", { delta: stepVal(b.dataset.step) }));
$("#btn-goin").onclick = () => loaded() && cmd("seek", { frame: loaded().in });
$("#btn-goout").onclick = () => loaded() && cmd("seek", { frame: loaded().out - 1 });
$("#loopmode").onchange = e => cmd("loop", { mode: e.target.value });
$("#btn-browser").onclick = () => window.open("/browser.html", "sendust_browser");

document.addEventListener("keydown", e => {
  if (e.target.closest?.("input, select, textarea")) return;
  const k = e.key.toLowerCase();
  const sec = Math.round(fpsR());
  let handled = true;
  if (k === " ") cmd("toggle");
  else if (k === "arrowleft") cmd("step", { delta: e.shiftKey ? -sec : -1 });
  else if (k === "arrowright") cmd("step", { delta: e.shiftKey ? sec : 1 });
  else if (k === "j") cmd("step", { delta: -sec });
  else if (k === "k") cmd("pause");
  else if (k === "l") cmd(S.p?.status === "playing" ? "step" : "play", { delta: sec });
  else if (k === "i" && e.ctrlKey) $("#btn-goin").click();
  else if (k === "o" && e.ctrlKey) $("#btn-goout").click();
  else if (k === "i") cmd("mark_in");
  else if (k === "o") cmd("mark_out");
  else if (k === "home") cmd("top");
  else handled = false;
  if (handled) e.preventDefault();
});

// ---------------------------------------------------------------- temporary media list (replaced by playlist in phase 2)
let mediaDir = "";
async function loadMedia(dir = "") {
  try {
    const r = await api(`media/list?dir=${encodeURIComponent(dir)}`);
    mediaDir = dir;
    const rows = [];
    if (dir) rows.push(`<tr data-dir="${esc(dir.split("/").slice(0, -1).join("/"))}"><td colspan="4">..</td></tr>`);
    for (const it of r.items) {
      rows.push(it.dir
        ? `<tr data-dir="${esc(it.path)}"><td><b>▸ ${esc(it.name)}/</b></td><td></td><td></td><td></td></tr>`
        : `<tr data-file="${esc(it.path)}"><td>${esc(it.name)}</td><td class="dim">${it.kind}</td><td class="num">${fmtBytes(it.size)}</td><td class="num">${new Date(it.mtime * 1000).toLocaleString("ko-KR", { hour12: false })}</td></tr>`);
    }
    $("#medialist").innerHTML = `<table><thead><tr><th>Name</th><th>Kind</th><th>Size</th><th>Modified</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
  } catch (e) { toast(`media list: ${e.message}`); }
}
$("#medialist").addEventListener("click", e => {
  const tr = e.target.closest("tr[data-file],tr[data-dir]");
  if (!tr) return;
  $$("#medialist tr.sel").forEach(x => x.classList.remove("sel"));
  tr.classList.add("sel");
});
$("#medialist").addEventListener("dblclick", e => {
  const tr = e.target.closest("tr");
  if (!tr) return;
  if (tr.dataset.dir !== undefined) loadMedia(tr.dataset.dir);
  else if (tr.dataset.file) cmd("load", { file: tr.dataset.file });
});

loadMedia();
renderStatic();
requestAnimationFrame(renderLive);
