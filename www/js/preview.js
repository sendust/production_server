// VGA preview (child window of a playback window): plays the original MXF in the browser
// (Range requests + libavcodec wasm, see vgap/), without using a CasparCG channel, and writes
// IN/OUT back to the playlist item.   /preview.html?ch=<channel_index>&id=<playlist item id>
import { $, $$, api, connectWs, framesToTc, tcToFrames, durTc, esc, ask, toast } from "./common.js";
import { Timeline } from "./timeline.js";
import { Meter } from "./meter.js";
import { Scenes } from "./scenes.js";
import { Player } from "../vgap/js/player.js";
import { YuvRenderer } from "../vgap/js/renderer.js";

const qs = new URLSearchParams(location.search);
const CH = Number(qs.get("ch") ?? 0);
const ITEM = qs.get("id");
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

const S = { info: null, item: null, probe: null, ld: null, marks: { in: 0, out: 0 }, chPlayer: null, playlist: null };

let renderer;
try { renderer = new YuvRenderer($("#pv-canvas")); }
catch (e) { $("#pv-msg").textContent = `WebGL2 를 쓸 수 없습니다: ${e.message}`; throw e; }
renderer.field = Number(store.get("pv.field", 0));
$("#pv-field").value = String(renderer.field);
const player = new Player(renderer);
window.__pv = player;   // for tests (CDP)
const quality = Number(store.get("pv.quality", 1));
$("#pv-quality").value = String(quality);
player.setLowres(quality);
const vol = Number(store.get("pv.vol", 0.8));
$("#pv-vol").value = String(vol);
player.setVolume(vol);
const workersReady = player.setWorkers(Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 2)));

const meter = new Meter($("#pv-meter"));
const timeline = new Timeline($("#timeline"), {
  onScrubStart: () => player.pause(),
  onScrub: (f, final) => player.seek(f, { scrub: !final }),
});

// ---------------------------------------------------------------- helpers
const fpsR = () => { const f = S.probe?.fps || [30000, 1001]; return f[0] / f[1]; };
const tcStart = () => S.probe ? (tcToFrames(S.probe.tc_start, S.probe.fps) ?? 0) : 0;
const tc = f => S.probe ? framesToTc(tcStart() + f, S.probe.fps, S.probe.drop) : "--";
const nFrames = () => player.media?.frames ?? S.probe?.frames ?? 0;
const onAir = () => S.chPlayer?.loaded?.item_id === ITEM && S.chPlayer?.status === "playing";
const dirty = () => S.item && (S.marks.in !== S.item.in || S.marks.out !== S.item.out);

function setMarks(a, b) {
  const n = nFrames();
  a = Math.max(0, Math.min(a, n - 1));
  b = Math.max(1, Math.min(b, n));
  if (b <= a) { if (a !== S.marks.in) b = n; else a = 0; }   // crossed: reset the other side
  S.marks = { in: a, out: b };
  S.ld = { ...S.ld, in: a, out: b };
  renderMarks();
}

function renderMarks() {
  $("#pv-in").textContent = tc(S.marks.in);
  $("#pv-out").textContent = tc(S.marks.out);
  $("#pv-dur").textContent = durTc(S.marks.out - S.marks.in, S.probe);
  const c = $("#pv-changed");
  if (!S.item) { c.textContent = ""; return; }
  c.classList.toggle("dirty", !!dirty());
  c.textContent = dirty()
    ? `변경됨 — 플레이리스트: ${tc(S.item.in)} → ${tc(S.item.out)} (APPLY 로 적용)`
    : "플레이리스트 항목과 같음";
}

// ---------------------------------------------------------------- load
async function start() {
  try {
    S.info = await api("info");
    const ch = await api(`ch/${CH}`);
    S.chPlayer = ch.player;
    S.playlist = ch.playlist;
    S.item = ch.playlist.items.find(i => i.id === ITEM);
    if (!S.item || S.item.type !== "clip") throw new Error("플레이리스트 항목을 찾을 수 없습니다");
    if (!/\.mxf$/i.test(S.item.file)) throw new Error("VGA 프리뷰는 MXF 파일만 지원합니다");
    S.probe = await api(`media/probe?file=${encodeURIComponent(S.item.file)}`);
    document.title = `${S.info.title} [${ch.player.name} · VGA Preview] {${S.info.stamp}}`;
    $("#pv-title").textContent = `VGA Preview · ${ch.player.name}`;
    const idx = ch.playlist.items.filter(i => i.type === "clip").findIndex(i => i.id === ITEM) + 1;
    $("#pv-target").innerHTML = `<span class="tag">#${idx} <b>${esc(S.item.name)}</b></span>`;
    S.ld = { file: S.item.file, info: S.probe, in: S.item.in, out: S.item.out };
    S.marks = { in: S.item.in, out: S.item.out };
    await workersReady;
    const url = "/media/" + S.item.file.split("/").map(encodeURIComponent).join("/");
    await player.load(url, p => { $("#pv-msg").textContent = `인덱스 읽는 중… ${Math.round(p * 100)}%`; });
    $("#pv-msg").textContent = "";
    if (player.media.frames !== S.probe.frames) console.warn("frame count differs", player.media.frames, S.probe.frames);
    buildTracks();
    renderMarks();
    player.seek(S.item.in);
  } catch (e) {
    $("#pv-msg").textContent = e.message;
    toast(e.message, 6000);
  }
}

function buildTracks() {
  const box = $("#pv-tracks");
  box.innerHTML = player.routing.map((r, i) => `<button class="${r === "-" ? "" : r}" data-t="${i}" title="track ${i + 1}: 클릭으로 L → R → C → off">${i + 1}:${r}</button>`).join("");
  meter.setChannels(player.routing.length || 2);
  $$("button", box).forEach(b => b.onclick = () => {
    const i = Number(b.dataset.t), order = ["L", "R", "C", "-"];
    player.setRouting(i, order[(order.indexOf(player.routing[i]) + 1) % order.length]);
    store.set("pv.routing", JSON.stringify(player.routing));
    buildTracks();
  });
}
player.addEventListener("tracks", () => {
  try {   // restore the listening assignment used last time, if the track count matches
    const saved = JSON.parse(store.get("pv.routing", "null"));
    if (Array.isArray(saved) && saved.length === player.routing.length) saved.forEach((r, i) => player.setRouting(i, r));
  } catch { /* ignore */ }
  buildTracks();
});

// ---------------------------------------------------------------- render loop
const scenes = new Scenes({
  loaded: () => S.ld,
  pos: () => player.media ? player.frame : null,
  status: () => player.playing ? "playing" : "paused",
  seek: f => player.seek(f),
  pause: () => player.pause(),
  focus: () => document.body.focus({ preventScroll: true }),
}, {});

function frame() {
  requestAnimationFrame(frame);
  if (!player.media) return;
  const f = player.frame;
  $("#pv-tc").textContent = tc(f);
  $("#pv-osd").textContent = `${tc(f)}  ${f}${player.buffering ? "  buffering…" : ""}`;
  const pb = $("#pv-play");
  pb.classList.toggle("active", player.playing);
  pb.querySelector("span").textContent = player.playing ? "PAUSE" : "PLAY";
  $("#pv-rate").textContent = player.playing ? `${player.rate}×` : "paused";
  const lv = player.levels(f);
  if (lv) meter.push(lv.map(v => v > 0 ? 20 * Math.log10(v) : -120));
  timeline.set({
    length: player.media.frames, fin: S.marks.in, fout: S.marks.out, pos: f, tcStart: tcStart(),
    fps: S.probe.fps, drop: S.probe.drop, zoomSec: scenes.sideSec(),
    span: scenes.data ? [scenes.data.from, scenes.data.to] : null, cuts: scenes.data ? scenes.cuts() : [],
  });
  scenes.render();
  const st = player.stats;
  $("#pv-stats").textContent = `decode ${st.decodeMs.toFixed(0)} ms · fetch ${st.fetchMs.toFixed(0)} ms · cache ${(player.cacheBytes() / 1048576).toFixed(0)} MB${st.errors ? ` · err ${st.errors}` : ""}`;
}
requestAnimationFrame(frame);

// ---------------------------------------------------------------- actions
async function apply() {
  if (!S.item || !dirty()) return toast("변경된 IN/OUT 이 없습니다", 1500);
  if (onAir() && !await ask({ title: "송출 중인 항목", message: "이 항목은 지금 SDI 로 재생 중입니다. IN/OUT 을 바로 바꿀까요?", ok: "적용", danger: true })) return;
  try {
    const r = await api(`ch/${CH}/playlist/marks`, { id: ITEM, fin: S.marks.in, fout: S.marks.out });
    S.item = r.playlist.items.find(i => i.id === ITEM) ?? S.item;
    renderMarks();
    toast("플레이리스트에 적용했습니다", 1500);
  } catch (e) { toast(e.message); }
}

async function addNew() {
  try {
    const at = S.playlist.items.findIndex(i => i.id === ITEM) + 1;
    const r = await api(`ch/${CH}/playlist/add`, { files: [S.item.file], at });
    const it = r.playlist.items[at];
    await api(`ch/${CH}/playlist/marks`, { id: it.id, fin: S.marks.in, fout: S.marks.out });
    toast("새 항목으로 추가했습니다", 1500);
  } catch (e) { toast(e.message); }
}

function shuttle(dir) {
  const steps = [1, 2, 4];
  const cur = player.playing ? player.rate : 0;
  let r;
  if (Math.sign(cur) === dir) r = dir * steps[Math.min(steps.length - 1, steps.indexOf(Math.abs(cur)) + 1)];
  else r = dir;
  player.setRate(r);
}

const ACT = {
  space: () => player.toggle(),
  k: () => player.pause(),
  j: () => shuttle(-1),
  l: () => shuttle(1),
  "-1": () => player.step(-1),
  "+1": () => player.step(1),
  home: () => { player.pause(); player.seek(0); },
  goin: () => { player.pause(); player.seek(S.marks.in); },
  goout: () => { player.pause(); player.seek(S.marks.out - 1); },
  i: () => setMarks(player.frame, S.marks.out),
  o: () => setMarks(S.marks.in, player.frame),
  clear: () => setMarks(0, nFrames()),
  enter: () => apply(),
};
$$("[data-k]").forEach(b => { b.addEventListener("mousedown", e => e.preventDefault()); b.onclick = () => ACT[b.dataset.k]?.(); });
$("#pv-add").onclick = addNew;
$("#pv-revert").onclick = () => S.item && setMarks(S.item.in, S.item.out);
$("#pv-quality").onchange = e => { store.set("pv.quality", e.target.value); player.setLowres(Number(e.target.value)); };
$("#pv-field").onchange = e => { renderer.field = Number(e.target.value); store.set("pv.field", e.target.value); renderer.redraw(); };
$("#pv-vol").oninput = e => { player.setVolume(Number(e.target.value)); store.set("pv.vol", e.target.value); };
$("#pv-tcin").addEventListener("keydown", e => {
  if (e.key !== "Enter") return;
  const v = e.target.value.trim();
  let f = /^\d+$/.test(v) ? Number(v) : tcToFrames(v, S.probe.fps);
  if (f == null) return toast("TC 형식: hh:mm:ss:ff 또는 프레임 번호");
  if (!/^\d+$/.test(v)) f -= tcStart();   // a timecode is absolute (source TC)
  player.pause(); player.seek(f);
  e.target.blur();
});

document.addEventListener("keydown", e => {
  if (e.target.closest?.("input:not([type=range]):not([type=checkbox]), select, textarea, dialog")) return;
  const k = e.key.toLowerCase(), sec = Math.round(fpsR());
  const digit = !e.ctrlKey && !e.altKey && /^(Digit|Numpad)([1-9])$/.exec(e.code);
  let h = true;
  if ((e.code === "Slash" && !e.shiftKey) || e.code === "NumpadDivide") { if (!e.repeat) scenes.run(); }
  else if (digit && scenes.data) scenes.jump(Number(digit[2]), e.shiftKey ? -1 : 0);
  else if (e.ctrlKey && scenes.data && (e.code === "ArrowLeft" || e.code === "ArrowRight")) scenes.step(e.code === "ArrowRight" ? 1 : -1);
  else if (k === " ") ACT.space();
  else if (k === "arrowleft") player.step(e.shiftKey ? -sec : -1);
  else if (k === "arrowright") player.step(e.shiftKey ? sec : 1);
  else if (k === "i" && e.ctrlKey) ACT.goin();
  else if (k === "o" && e.ctrlKey) ACT.goout();
  else if (k === "i") ACT.i();
  else if (k === "o") ACT.o();
  else if (k === "j") ACT.j();
  else if (k === "k") ACT.k();
  else if (k === "l") ACT.l();
  else if (k === "home") ACT.home();
  else if (k === "end") { player.pause(); player.seek(nFrames() - 1); }
  else if (k === "enter") ACT.enter();
  else h = false;
  if (h) e.preventDefault();
});

// keep the item / on-air state fresh (another window may edit the playlist)
connectWs(m => {
  if (m.type === "hello" || m.type === "tick") S.chPlayer = m.players?.find(p => p.idx === CH) ?? S.chPlayer;
  const pl = m.type === "hello" ? m.playlists?.[CH] : m.type === "playlist" && m.ch === CH ? m.playlist : null;
  if (pl) {
    S.playlist = pl;
    const it = pl.items.find(i => i.id === ITEM);
    if (it) { S.item = it; renderMarks(); }
    else if (S.item) { $("#pv-changed").textContent = "이 항목은 플레이리스트에서 삭제되었습니다"; S.item = null; }
  }
});

start();
