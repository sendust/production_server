// Playback window (uMP-style layout, sized for HD): one page per playback channel (?ch=<channel_index>).
import { $, $$, api, connectWs, framesToTc, durTc, tcToFrames, esc, toast, addLogout } from "./common.js";
import { PlaylistUI } from "./playlist_ui.js";
import { Scenes } from "./scenes.js";
import { Timeline } from "./timeline.js";
import { GridMeter } from "./meter.js";
import { WhepView } from "./whep.js";

const CH = Number(new URLSearchParams(location.search).get("ch") ?? 0);
const S = { info: null, p: null, recvAt: 0, engine: null, logs: [] };
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

// ---------------------------------------------------------------- helpers
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
const NO_TC = "--:--:--;--";

// position interpolated between 20 Hz ticks while playing
function livePos() {
  const p = S.p;
  if (!p || p.pos == null) return null;
  if (p.status !== "playing") return p.pos;
  const f = p.pos + (performance.now() - S.recvAt) / 1000 * fpsR();
  if (p.loop) return f;
  return Math.min(Math.floor(f), p.loaded.out - 1);
}

// big state word, like the uMP panel
function stateWord(p) {
  const st = p?.status ?? "empty";
  if (st === "empty") return ["EJECT", "eject"];
  if (st === "loading") return ["LOAD", "loading"];
  if (st === "playing") return ["PLAY", "playing"];
  if (st === "ended") return ["END", "ended"];
  if (st === "paused") return p.pos != null && p.loaded && p.pos <= p.loaded.in ? ["CUED", "cued"] : ["PAUSE", "paused"];
  return [st.toUpperCase(), st];
}

// ---------------------------------------------------------------- components
const timeline = new Timeline($("#timeline"), {
  onScrubStart: () => { if (S.p?.status === "playing") cmd("pause"); },
  onScrub: (f, final) => scrubTo(f, final),
});
const meter = new GridMeter($("#meter"), 2);
const plui = new PlaylistUI(CH, { getPlayer: () => S.p });
let scenes = null;
function makeScenes() {
  scenes = new Scenes({
    loaded: () => loaded(),
    pos: () => { const f = livePos(); return f == null ? null : Math.floor(f); },
    status: () => S.p?.status,
    seek: f => seekTo(f),
    pause: () => { if (S.p?.status === "playing") cmd("pause"); },
    focus: () => document.body.focus({ preventScroll: true }),
  }, S.info?.zoom_timeline ?? {});
}

function seekTo(f) {
  if (S.p) { S.p.pos = f; S.recvAt = performance.now(); }   // optimistic playhead
  return cmd("seek", { frame: f });
}

let scrubBusy = false, scrubPending = null;
async function scrubTo(f, final) {
  if (S.p) { S.p.pos = f; S.recvAt = performance.now(); }
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

// ---------------------------------------------------------------- preview (clip info <-> WebRTC)
const whep = new WhepView($("#pv-video"), {
  onState: st => {
    const el = $("#pv-live");
    el.textContent = st === "connected" ? "● LIVE" : st;
    el.classList.toggle("bad", st !== "connected");
  },
});
let pvWanted = false;
function renderPreview() {
  const sp = S.p?.sdi_preview;
  const on = !!sp?.enabled;
  $("#pv-enable").checked = on;
  $("#pv-video").hidden = !on;
  $("#pv-live").hidden = !on;
  $("#info").hidden = on;
  if (on && sp.active) whep.start(`${location.protocol}//${location.hostname}:${sp.webrtc_port}/${sp.path}/whep`);
  else if (on) { $("#pv-live").textContent = "starting…"; }
  else whep.stop();
}
$("#pv-enable").onchange = async e => {
  pvWanted = e.target.checked;
  try { await api(`ch/${CH}/sdi_preview`, { on: pvWanted, source: "clean" }); }
  catch (err) { toast(`preview: ${err.message}`); e.target.checked = !pvWanted; }
};

function codecName(c) {
  return { mpeg2video: "MPEG-2", h264: "H.264", hevc: "HEVC", prores: "ProRes", dnxhd: "DNxHD", pcm_s24le: "PCM 24bit",
    pcm_s16le: "PCM 16bit", aac: "AAC", mp2: "MPEG-1 L2", ac3: "AC-3", mp3: "MP3", png: "PNG", mjpeg: "JPEG" }[c] || (c || "").toUpperCase();
}

function renderInfo() {
  const l = loaded(), el = $("#info");
  if (!l) { el.className = "info empty"; el.innerHTML = '<div class="fn">NO CLIP</div>'; return; }
  const i = l.info, v = i.video, a = i.audio;
  const name = l.name, dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot + 1).toUpperCase() : "";
  const fps = i.fps[0] / i.fps[1];
  const scan = v ? (v.field_order && !["progressive", "unknown"].includes(v.field_order) ? "i" : "p") : "";
  el.className = "info";
  el.innerHTML = `
    <div class="fn">${esc(base)}${ext ? `<span class="ext">.${esc(ext.toLowerCase())}</span>` : ""}</div>
    <div class="row"><span class="k">FORMAT</span>${esc(ext || i.format)} <span class="sub">${esc(i.kind)}${i.kind !== "image" ? ` · ${durTc(i.frames, i)}` : ""}</span></div>
    ${v ? `<div class="row"><span class="k">VIDEO</span>${esc(codecName(v.codec))} ${esc(v.profile ?? "")}
      <span class="sub">${v.width}×${v.height}${scan} ${fps.toFixed(2)}${v.bitrate ? ` · ${(v.bitrate / 1e6).toFixed(0)} Mb/s` : ""}</span></div>` : ""}
    ${a.channels ? `<div class="row"><span class="k">AUDIO</span>${esc(codecName(a.codec))}
      <span class="sub">${a.channels} ch · ${a.sample_rate / 1000} kHz${a.streams > 1 ? ` · ${a.streams} tracks` : ""}</span></div>`
      : '<div class="row"><span class="k">AUDIO</span><span class="sub">none</span></div>'}`;
}

// ---------------------------------------------------------------- render
const osdCls = s => !s?.configured ? "" : !s.enabled ? "off" : s.route && s.overlay ? "ok" : "bad";

function renderStatic() {
  const p = S.p, l = p?.loaded;
  const title = `${S.info?.title ?? "sendust playlist"} [${p?.name ?? `CH ${CH}`}] {${S.info?.stamp ?? ""}}`;
  if (document.title !== title) document.title = title;
  $("#chname").textContent = (p?.name ?? `CH ${CH}`).replace(/\s+/g, "-");
  const dl = a => a?.length ? `DL${a.join(",")}` : "—";
  $("#route").innerHTML = p ? [
    `<span class="tag">CH${p.clean} → ${dl(p.decklink)}</span>`,
    p.osd ? `<span class="tag ${osdCls(p.osd_state)}">OSD CH${p.osd} → ${dl(p.osd_decklink)}</span>` : "",
  ].join("") : "";
  const [word, cls] = stateWord(p);
  const se = $("#state");
  se.textContent = word; se.className = `state ${cls}`;
  $("#btn-play").classList.toggle("on", p?.status === "playing");
  $("#btn-pause").classList.toggle("on", p?.status === "paused");
  renderInfo();
  meter.setChannels(Math.min(l?.info.audio.channels || 8, 8));
  $("#loopmode").value = p?.loop_mode ?? "none";
  renderPreview();
}

function renderLive() {
  const p = S.p, l = p?.loaded;
  const pos = livePos();
  if (l && pos != null && l.info.kind !== "image") {
    const i = l.info, ts = tcStart();
    $("#tc").textContent = framesToTc(ts + pos, i.fps, i.drop);
    $("#tc-el").textContent = durTc(Math.max(0, pos - l.in), i);
    const rem = Math.max(0, l.out - pos - 1);
    const re = $("#tc-rem");
    re.textContent = durTc(rem, i);
    re.classList.toggle("alert", p.status === "playing" && rem < fpsR() * 5);
    re.classList.toggle("warn", p.status === "playing" && rem >= fpsR() * 5 && rem < fpsR() * 10);
    $("#tc-in").textContent = framesToTc(ts + l.in, i.fps, i.drop);
    $("#tc-out").textContent = framesToTc(ts + l.out, i.fps, i.drop);
    $("#tc-dur").textContent = durTc(l.out - l.in, i);
  } else if (l && l.info.kind === "image" && pos != null) {
    const i = l.info;
    $("#tc").textContent = durTc(pos, i);
    $("#tc-el").textContent = durTc(pos, i);
    $("#tc-rem").textContent = durTc(Math.max(0, l.out - pos - 1), i);
    $("#tc-dur").textContent = durTc(l.out - l.in, i);
    $("#tc-in").textContent = $("#tc-out").textContent = NO_TC;
  } else {
    for (const id of ["#tc", "#tc-el", "#tc-rem", "#tc-in", "#tc-out", "#tc-dur"]) $(id).textContent = NO_TC;
    $("#tc-rem").classList.remove("alert", "warn");
  }
  const sd = scenes?.data;
  timeline.set(l && l.info.kind !== "image" ? {
    length: l.info.frames, fin: l.in, fout: l.out, pos, tcStart: tcStart(),
    fps: l.info.fps, drop: l.info.drop, zoomSec: scenes && !$("#zoomwrap").classList.contains("closed") ? scenes.sideSec() : 0,
    span: sd ? [sd.from, sd.to] : null, cuts: sd ? scenes.cuts() : [],
  } : { length: 0, pos: null });
  scenes?.render();
  requestAnimationFrame(renderLive);
}

function applyPlayer(p) {
  const key = x => JSON.stringify([x?.status, x?.loaded, x?.loop_mode, x?.decklink, x?.osd_decklink, x?.osd_state, x?.sdi_preview,
    x?.status === "paused" && x?.loaded ? x.pos <= x.loaded.in : 0]);
  const prevKey = key(S.p);
  const prevPre = S.p?.preloaded;
  for (const k of ["sdi_preview", "osd_state", "volume"]) if (p[k] === undefined && S.p?.[k] !== undefined) p[k] = S.p[k];
  S.p = p; S.recvAt = performance.now() - (p.age || 0) * 1000;
  if (p.volume?.length) meter.push(p.volume);
  if (key(p) !== prevKey) renderStatic();
  if (p.preloaded !== prevPre) plui.render(); else plui.renderLive();
}

// ---------------------------------------------------------------- logs (status line)
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
    if (m.playlists?.[CH]) plui.set(m.playlists[CH]);
    if (!scenes) makeScenes();
    addLogout(m.info, $(".pb-title"));
  }
  if (m.type === "playlist" && m.ch === CH) plui.set(m.playlist);
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
const noFocus = b => b.addEventListener("mousedown", e => e.preventDefault());   // keep shortcuts alive
$$(".ubtn, .ibtn").forEach(noFocus);
$$("[data-act]").forEach(b => b.onclick = () => cmd(b.dataset.act));
const stepVal = v => v.endsWith("s") ? Math.round(parseFloat(v) * fpsR()) : parseInt(v, 10);
$$("[data-step]").forEach(b => b.onclick = () => cmd("step", { delta: stepVal(b.dataset.step) }));
$("#btn-goin").onclick = () => loaded() && seekTo(loaded().in);
$("#btn-goout").onclick = () => loaded() && seekTo(loaded().out - 1);
$("#btn-end").onclick = () => loaded() && seekTo(loaded().out - 1);
$("#btn-delin").onclick = () => loaded() && cmd("marks", { fin: 0 });
$("#btn-delout").onclick = () => loaded() && cmd("marks", { fout: loaded().info.frames });
$("#loopmode").onchange = e => cmd("loop", { mode: e.target.value });
const openBrowser = () => window.open("/browser.html", "sendust_browser");
$("#btn-browser").onclick = openBrowser;
$("#btn-open").onclick = openBrowser;

// zoomed timeline open/close (remembered)
const zw = $("#zoomwrap");
const setZoom = open => { zw.classList.toggle("closed", !open); $(".pb").classList.toggle("zoom-open", open); $("#sc-toggle").textContent = open ? "SCENE ▴" : "SCENE ▾"; store.set("sp.zoomOpen", open ? "1" : "0"); };
setZoom(store.get("sp.zoomOpen", "0") === "1");
$("#sc-toggle").onclick = () => {
  const open = zw.classList.contains("closed");
  setZoom(open);
  if (open) scenes?.run();   // unfolding = analyse around the playhead right away
};

// ---------------------------------------------------------------- keyboard
document.addEventListener("keydown", e => {
  if (e.target.closest?.("input:not([type=range]):not([type=checkbox]):not([type=radio]), select, textarea, dialog")) return;
  const k = e.key.toLowerCase();
  const sec = Math.round(fpsR());
  let handled = true;
  const digit = !e.ctrlKey && !e.altKey && /^(Digit|Numpad)([1-9])$/.exec(e.code);
  if ((e.code === "Slash" && !e.shiftKey) || e.code === "NumpadDivide") { if (!e.repeat) { setZoom(true); scenes?.run(); } }
  else if (digit && scenes?.data) scenes.jump(Number(digit[2]), e.shiftKey ? -1 : 0);
  else if (e.ctrlKey && scenes?.data && (e.code === "ArrowLeft" || e.code === "ArrowRight")) scenes.step(e.code === "ArrowRight" ? 1 : -1);
  else if (k === " ") cmd("toggle");
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
  else if (k === "end") $("#btn-end").click();
  else if (k === "enter" && !e.target.closest?.("#pl")) $("#pl-cue").click();
  else handled = false;
  if (handled) e.preventDefault();
});

renderStatic();
requestAnimationFrame(renderLive);
