// Settings page: CasparCG service control, channel plan (from casparcg.config), every key of
// sendust_player.json. Saving writes the file; a backend restart applies it.
import { $, $$, api, esc, toast, ask } from "./common.js";

let base = null;      // config as loaded (for "dirty")
let cfg = null;       // working copy
let detect = null;
let passwordSet = false;

// ---- field descriptions: [dotted key, label, type, extra] ----------------------------------
const TC = [["source", "파일 TC (빨간 TC)"], ["elapsed", "경과 (흰 TC, IN = 0)"]];
const EXT_CMDS = ["", "play", "pause", "stop", "toggle", "top", "next", "prev", "eject", "cue"];
const GROUPS = {
  "g-general": [["title", "프로그램 제목", "text"], ["http.host", "HTTP 주소 (bind)", "text"], ["http.port", "HTTP 포트", "int"]],
  "g-auth": [["auth", "웹 UI 로그인 사용", "bool"], ["__password", "새 비밀번호", "password"]],
  "g-caspar": [["casparcg.host", "CasparCG 주소", "text"], ["casparcg.amcp_port", "AMCP 포트", "int"],
    ["casparcg.osc_port", "OSC 수신 포트", "int"], ["casparcg.media_path", "media 경로", "text"],
    ["casparcg.template_path", "template 경로", "text"], ["casparcg.video_layer", "재생 레이어", "int"],
    ["casparcg.osd_route_layer", "OSD route 레이어", "int"], ["casparcg.osd_overlay_layer", "OSD 오버레이 레이어", "int"],
    ["casparcg.config_path", "casparcg.config 경로", "text"], ["casparcg.service", "서비스 이름 (systemd)", "text"]],
  "g-media": [["browser.lower_root", "브라우저 아래 판넬 시작 경로", "text"], ["shared_playlist_path", "공유 리스트 A~D 폴더", "text"],
    ["playlist.image_sec", "이미지 기본 길이 (초)", "num"], ["zoom_timeline.seconds", "확대 타임라인 ± 초", "num"]],
  "g-osd": [["osd.update_frames", "갱신 주기 (프레임)", "int"], ["osd.offset_frames", "TC 지연 보정 (프레임)", "int"],
    ["osd.box", "반투명 배경", "bool"],
    ["osd.timecode.enabled", "TC 표시", "bool"], ["osd.timecode.label", "TC 라벨", "bool"],
    ["osd.timecode.x", "TC x (0~1)", "num"], ["osd.timecode.y", "TC y (0~1)", "num"], ["osd.timecode.size", "TC 크기 (화면 높이 비율)", "num"],
    ["osd.filename.enabled", "파일명 표시", "bool"], ["osd.filename.x", "파일명 x", "num"], ["osd.filename.y", "파일명 y", "num"],
    ["osd.filename.size", "파일명 크기", "num"]],
  "g-sdi": [["sdi_preview.rtsp_base", "RTSP 주소 (mediamtx)", "text"], ["sdi_preview.path_prefix", "스트림 이름 접두어", "text"],
    ["sdi_preview.webrtc_port", "WebRTC 포트", "int"], ["sdi_preview.args", "인코딩 옵션 (빈 값 = 기본)", "text"]],
  "g-ext": [["ext_control.enabled", "외부 제어 사용", "bool"], ["ext_control.key", "API 키", "text"],
    ["ext_control.osc_port", "OSC 제어 포트", "int"], ["ext_control.allow_ips", "OSC 허용 IP (쉼표)", "list"],
    ["ext_control.aux1", "aux1 = ", "select", EXT_CMDS], ["ext_control.aux2", "aux2 = ", "select", EXT_CMDS],
    ["gang.allow_origins", "gang UI origin (쉼표)", "list"]],
};

const getK = (o, k) => k.split(".").reduce((a, p) => (a == null ? undefined : a[p]), o);
function setK(o, k, v) {
  const ps = k.split("."), last = ps.pop();
  let a = o;
  for (const p of ps) a = a[p] ??= {};
  a[last] = v;
}

function fieldHtml([k, label, type, extra]) {
  let inp;
  if (type === "bool") inp = `<label class="uchk"><input type="checkbox" data-k="${k}"></label>`;
  else if (type === "select") inp = `<select data-k="${k}">${extra.map(v => `<option value="${v}">${v || "(없음)"}</option>`).join("")}</select>`;
  else if (type === "password") inp = `<input type="password" data-k="${k}" autocomplete="new-password" placeholder="(변경 안 함)">`;
  else inp = `<input type="${type === "text" || type === "list" ? "text" : "number"}" ${type === "num" ? 'step="any"' : ""} data-k="${k}" data-t="${type}">`;
  return `<label class="fld"><span>${esc(label)}</span>${inp}</label>`;
}

function readInput(el) {
  const t = el.dataset.t;
  if (el.type === "checkbox") return el.checked;
  if (t === "int") return el.value === "" ? null : Math.round(Number(el.value));
  if (t === "num") return el.value === "" ? null : Number(el.value);
  if (t === "list") return el.value.split(",").map(s => s.trim()).filter(Boolean);
  return el.value;
}
function writeInput(el, v) {
  if (el.type === "checkbox") el.checked = !!v;
  else if (el.dataset.t === "list") el.value = (v || []).join(", ");
  else el.value = v ?? "";
}

// ---- render --------------------------------------------------------------------------------
function renderForm() {
  for (const [id, fields] of Object.entries(GROUPS)) $("#" + id).innerHTML = fields.map(fieldHtml).join("");
  for (const el of $$("[data-k]")) {
    if (el.dataset.k === "__password") continue;
    writeInput(el, getK(cfg, el.dataset.k));
    el.oninput = el.onchange = () => { setK(cfg, el.dataset.k, readInput(el)); markDirty(); };
  }
  const pw = $('[data-k="__password"]');
  pw.placeholder = passwordSet ? "(설정됨 — 바꿀 때만 입력)" : "(없음)";
  pw.oninput = markDirty;
}

function chOptions(sel, withNone) {
  const chs = detect?.channels ?? [];
  const nums = new Set(chs.map(c => c.n));
  if (sel != null) nums.add(sel);   // keep a configured channel even if casparcg.config has fewer
  return (withNone ? `<option value="">없음</option>` : "") + [...nums].sort((a, b) => a - b).map(n => {
    const c = chs.find(x => x.n === n);
    return `<option value="${n}" ${n === sel ? "selected" : ""}>ch${n}${c ? ` · ${esc(c.label)}` : " (casparcg.config 에 없음)"}</option>`;
  }).join("");
}

function renderChannels() {
  $("#ch-table tbody").innerHTML = cfg.channels.map((c, i) => `<tr data-i="${i}">
    <td class="mono">${i + 1}</td>
    <td><input type="text" data-f="name" value="${esc(c.name)}"></td>
    <td><select data-f="clean_out">${chOptions(c.clean_out, false)}</select></td>
    <td><select data-f="osd_out">${chOptions(c.osd_out ?? null, true)}</select></td>
    <td><select data-f="tc_mode">${TC.map(([v, l]) => `<option value="${v}" ${c.tc_mode === v ? "selected" : ""}>${l}</option>`).join("")}</select></td>
    <td><button class="ibtn" data-del="${i}" title="이 재생 채널 삭제">✕</button></td></tr>`).join("");
  for (const el of $$("#ch-table [data-f]")) el.onchange = el.oninput = () => {
    const c = cfg.channels[Number(el.closest("tr").dataset.i)], f = el.dataset.f;
    c[f] = f === "name" || f === "tc_mode" ? el.value : (el.value === "" ? null : Number(el.value));
    markDirty();
  };
  for (const b of $$("#ch-table [data-del]")) b.onclick = () => { cfg.channels.splice(Number(b.dataset.del), 1); renderChannels(); markDirty(); };
}

function renderDetect() {
  const d = detect;
  $("#cc-path").textContent = d.path || "";
  $("#cc-table tbody").innerHTML = d.channels.map(c => `<tr>
    <td class="mono">ch${c.n}</td><td class="mono">${esc(c.video_mode)}</td><td>${esc(c.label)}</td>
    <td>${c.live ? `<span class="live-on">● 동작 중</span> ${esc(c.live_format || "")}` : `<span class="live-off">● 응답 없음</span>`}</td>
    <td>${esc((d.used[c.n] || []).join(", ")) || '<span class="dim">-</span>'}</td></tr>`).join("") ||
    `<tr><td colspan="5" class="dim">casparcg.config 에서 채널을 찾지 못했습니다</td></tr>`;
  $("#cc-err").innerHTML = d.error ? `<div class="bad-box">casparcg.config 읽기 실패: ${esc(d.error)}</div>` : "";
  const n = d.channels.length;
  $("#plan-desc").textContent = n ? `감지된 CasparCG 채널 ${n}개 → 클린만: 재생 ${n}채널 / 클린+OSD: 재생 ${Math.ceil(n / 2)}채널` : "";
}

function applyPlan(withOsd) {
  const chs = (detect?.channels ?? []).map(c => c.n);
  if (!chs.length) return toast("casparcg.config 에서 감지된 채널이 없습니다");
  const old = cfg.channels;
  const out = [];
  for (let i = 0; i < chs.length; i += withOsd ? 2 : 1) {
    const k = out.length, prev = old[k] || {};
    out.push({ channel_index: k, name: prev.name || `PLAY ${k + 1}`, clean_out: chs[i],
               osd_out: withOsd ? (chs[i + 1] ?? null) : null, tc_mode: prev.tc_mode || "source" });
  }
  cfg.channels = out;
  setK(cfg, "osd.enabled", withOsd);
  writeInput($('[data-k="osd.enabled"]'), withOsd);
  renderChannels(); markDirty();
}

// ---- dirty / save --------------------------------------------------------------------------
function isDirty() { return JSON.stringify(cfg) !== JSON.stringify(base) || !!$('[data-k="__password"]')?.value; }
function markDirty() {
  const d = isDirty();
  $("#save-msg").textContent = d ? "저장하지 않은 변경이 있습니다" : "변경 없음";
  $("#save-msg").classList.toggle("dirty", d);
}

async function save(restart) {
  const pw = $('[data-k="__password"]').value;
  try {
    await api("settings", { config: cfg, password: pw ? pw : null });
  } catch (e) {
    return void $("#save-msg").replaceChildren(Object.assign(document.createElement("span"), { className: "bad", textContent: e.message }));
  }
  toast("저장했습니다", 1500);
  if (!restart) {
    $("#save-msg").textContent = "저장됨 — 백엔드를 재시작하면 적용됩니다";
    return load();
  }
  const port = getK(cfg, "http.port");
  await api("backend/restart", {}).catch(() => {});
  $("#save-msg").textContent = "백엔드 재시작 중…";
  const url = `${location.protocol}//${location.hostname}:${port}`;
  const t0 = Date.now();
  await new Promise(r => setTimeout(r, 2500));
  while (Date.now() - t0 < 30000) {
    try {
      const r = await fetch(`${url}/api/v1/info`, { cache: "no-store" });
      if (r.ok) { location.href = `${url}/settings.html`; return; }
    } catch { /* still down */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  $("#save-msg").textContent = `백엔드가 ${url} 에서 응답하지 않습니다 (logs/backend.log 확인)`;
}

// ---- CasparCG service ------------------------------------------------------------------------
let svcInstallCmd = "";
function renderService(s) {
  $("#svc-unit").textContent = s.unit;
  const act = s.active === "active", ext = s.external;
  const state = !s.installed ? `<span class="warn">설치되지 않음</span>`
    : `<span class="${act ? "ok" : "bad"}">● ${esc(s.active)}</span> (${esc(s.sub || "")})`;
  $("#svc").innerHTML = `
    <span class="k">서비스 상태</span><span>${state}</span>
    <span class="k">자동 시작 (enable)</span><span>${s.installed ? (s.enabled === "enabled" ? '<span class="ok">켜짐</span>' : `<span class="dim">${esc(s.enabled || "-")}</span>`) : "-"}</span>
    <span class="k">CasparCG 프로세스</span><span>${s.caspar_pid ? `pid ${s.caspar_pid}${ext ? ' <span class="warn">(서비스 밖에서 실행 중)</span>' : ""}` : '<span class="dim">없음</span>'}</span>
    <span class="k">시작 시각</span><span class="mono">${esc(s.since || "-")}</span>
    <span class="k">유닛 파일</span><span class="mono">${esc(s.path || "-")}</span>`;
  let hint = "";
  if (!s.installed || !s.sudo_ok) {
    hint = `<div class="warn-box">${s.installed ? "백엔드가 서비스를 제어할 sudo 규칙이 없습니다." : "CasparCG 서비스가 아직 등록되지 않았습니다."}
      서버에서 한 번 실행하세요 (sudo 비밀번호 필요):<code class="cmd">${esc(svcInstallCmd)}</code></div>`;
  }
  if (ext) hint += `<div class="warn-box">CasparCG 가 서비스가 아닌 방법(run_caspar.sh 등)으로 실행 중입니다. 서비스로 바꾸려면 [정지] 후 [시작] 하세요.</div>`;
  $("#svc-hint").innerHTML = hint;
  const can = s.installed && s.sudo_ok;
  for (const b of $$("[data-svc]")) {
    const a = b.dataset.svc;
    b.disabled = a === "stop" ? !(act || ext) || (!can && !ext)
      : a === "start" ? !can || act || ext
      : a === "restart" ? !can || ext
      : a === "enable" ? !can || s.enabled === "enabled"
      : !can || s.enabled !== "enabled";
  }
}
async function pollService() {
  try { renderService(await api("caspar/service")); } catch { /* backend restarting */ }
}
for (const b of $$("[data-svc]")) b.onclick = async () => {
  const a = b.dataset.svc;
  if (["stop", "restart"].includes(a) && !await ask({ title: `CasparCG ${a === "stop" ? "정지" : "재시작"}`,
      message: "모든 채널의 송출이 멈춥니다. 계속할까요?", ok: a === "stop" ? "정지" : "재시작", danger: true })) return;
  $$("[data-svc]").forEach(x => { x.disabled = true; });
  $("#svc-busy").textContent = `${a} 실행 중…`;
  try { renderService(await api(`caspar/service/${a}`, {}, { timeout: 90000 })); toast(`CasparCG ${a} 완료`, 1500); }
  catch (e) { toast(e.message, 6000); pollService(); }
  finally { $("#svc-busy").textContent = ""; }
};

// ---- load ---------------------------------------------------------------------------------
async function load() {
  const r = await api("settings");
  base = r.config; cfg = structuredClone(r.config); detect = r.detect; passwordSet = r.password_set;
  svcInstallCmd = r.install_cmd;
  document.title = `${r.info.title} [Settings] {${r.info.stamp}}`;
  $("#host").textContent = r.info.host;
  $("#ver").textContent = `backend ${r.info.stamp}${r.info.commit ? ` · ${r.info.commit}` : ""}`;
  renderForm(); renderDetect(); renderChannels(); renderService(r.service); markDirty();
  if (!r.running) $("#save-msg").textContent = "파일의 채널 구성이 실행 중인 백엔드와 다릅니다 — 백엔드 재시작 필요";
}

$("#plan-clean").onclick = () => applyPlan(false);
$("#plan-osd").onclick = () => applyPlan(true);
$("#ch-add").onclick = () => {
  const used = new Set(cfg.channels.flatMap(c => [c.clean_out, c.osd_out]));
  const free = (detect?.channels ?? []).map(c => c.n).find(n => !used.has(n));
  cfg.channels.push({ channel_index: cfg.channels.length, name: `PLAY ${cfg.channels.length + 1}`, clean_out: free ?? 1, osd_out: null, tc_mode: "source" });
  renderChannels(); markDirty();
};
$("#b-save").onclick = () => save(false);
$("#b-save-restart").onclick = () => save(true);
$("#b-reload").onclick = () => load();
addEventListener("beforeunload", e => { if (cfg && isDirty()) e.preventDefault(); });
load().catch(e => toast(`설정 읽기 실패: ${e.message}`, 8000));
setInterval(pollService, 3000);
