// Shared helpers: REST, WebSocket with auto-reconnect, timecode math.

export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];

export async function api(path, body) {
  const opt = body === undefined ? {} : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}),
  };
  const r = await fetch(`/api/v1/${path}`, opt);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const d = j.detail;
    const e = new Error(typeof d === "string" ? d : d?.message || r.statusText);
    e.status = r.status; e.detail = d;
    throw e;
  }
  return j;
}

export function connectWs(onMsg, onState) {
  let ws, timer;
  const open = () => {
    ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    ws.onopen = () => onState?.(true);
    ws.onmessage = e => onMsg(JSON.parse(e.data));
    ws.onclose = () => { onState?.(false); clearTimeout(timer); timer = setTimeout(open, 1000); };
  };
  open();
}

// ---- timecode ---------------------------------------------------------------
// fps = [num, den]. Drop-frame only applies to 29.97 / 59.94.
export function tcBase(fps) { return Math.round(fps[0] / fps[1]); }
export function isDropRate(fps) { return fps[1] === 1001 && (tcBase(fps) === 30 || tcBase(fps) === 60); }

export function framesToTc(f, fps, drop) {
  const nom = tcBase(fps);
  let neg = f < 0; f = Math.abs(Math.round(f));
  drop = drop && isDropRate(fps);
  if (drop) {
    const dpm = nom === 60 ? 4 : 2;           // dropped numbers per minute
    const per10 = nom * 600 - dpm * 9;        // real frames per 10 minutes
    const perMin = nom * 60 - dpm;
    const d = Math.floor(f / per10), m = f % per10;
    f += dpm * 9 * d + (m > dpm ? dpm * Math.floor((m - dpm) / perMin) : 0);
  }
  const ff = f % nom, s = Math.floor(f / nom), ss = s % 60, mm = Math.floor(s / 60) % 60, hh = Math.floor(s / 3600) % 24;
  const p = n => String(n).padStart(2, "0");
  return `${neg ? "-" : ""}${p(hh)}:${p(mm)}:${p(ss)}${drop ? ";" : ":"}${p(ff)}`;
}

export function tcToFrames(tc, fps) {
  const m = /^(\d+):(\d+):(\d+)[:;.,](\d+)$/.exec(tc.trim());
  if (!m) return null;
  const [hh, mm, ss, ff] = m.slice(1).map(Number);
  const nom = tcBase(fps);
  let f = ((hh * 60 + mm) * 60 + ss) * nom + ff;
  if (tc.includes(";") && isDropRate(fps)) {
    const dpm = nom === 60 ? 4 : 2, tm = hh * 60 + mm;
    f -= dpm * (tm - Math.floor(tm / 10));
  }
  return f;
}

// duration display (elapsed/remaining): drop-frame when the clip is DF
export function durTc(frames, info) {
  return framesToTc(frames, info?.fps || [30000, 1001], info?.drop ?? true);
}

export function fmtBytes(n) {
  const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---- modal dialogs (confirm / prompt) -------------------------------------
// ask({title, message, list, input, ok, danger}) -> Promise<string|true|null>
export function ask({ title = "", message = "", list = null, input = null, ok = "OK", danger = false } = {}) {
  return new Promise(resolve => {
    const d = document.createElement("dialog");
    d.innerHTML = `<h3 style="margin:0 0 8px;font-size:15px">${esc(title)}</h3>
      <div>${esc(message)}</div>
      ${list ? `<ul>${list.slice(0, 50).map(x => `<li>${esc(x)}</li>`).join("")}${list.length > 50 ? `<li>… +${list.length - 50}</li>` : ""}</ul>` : ""}
      ${input !== null ? `<input type="text" value="${esc(input)}">` : ""}
      <div class="row"><button class="ibtn" data-r="0">Cancel</button><button class="ibtn ${danger ? "danger" : ""}" data-r="1">${esc(ok)}</button></div>`;
    document.body.append(d);
    const inp = d.querySelector("input");
    const done = v => { d.close(); d.remove(); resolve(v); };
    d.querySelector("[data-r='0']").onclick = () => done(null);
    d.querySelector("[data-r='1']").onclick = () => done(inp ? inp.value : true);
    d.addEventListener("cancel", e => { e.preventDefault(); done(null); });
    d.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); done(inp ? inp.value : true); } });
    d.showModal();
    if (inp) { inp.focus(); const dot = inp.value.lastIndexOf("."); inp.setSelectionRange(0, dot > 0 ? dot : inp.value.length); }
    else d.querySelector("[data-r='1']").focus();
  });
}

export function toast(msg, ms = 3500) {
  const t = document.createElement("div");
  t.className = "toast"; t.textContent = msg;
  document.body.append(t);
  setTimeout(() => t.remove(), ms);
}

export const DND_MEDIA = "application/x-sendust-media";   // {root, paths[]}
