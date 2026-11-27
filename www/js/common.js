// Shared helpers: REST, WebSocket with auto-reconnect, timecode math.

export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];

export async function api(path, body, { timeout = 0 } = {}) {
  const opt = body === undefined ? {} : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}),
  };
  let timer = null;
  if (timeout) {
    const ac = new AbortController();
    opt.signal = ac.signal;
    timer = setTimeout(() => ac.abort(), timeout);
  }
  let r;
  try {
    r = await fetch(`/api/v1/${path}`, opt);
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`응답 없음 (${timeout / 1000}s) — 다시 시도하세요`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
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
    // page + channel tell the backend who this is (log viewer's client list)
    const page = (location.pathname.split("/").pop() || "launcher.html").replace(/\.html$/, "");
    const ch = new URLSearchParams(location.search).get("ch");
    ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?page=${encodeURIComponent(page)}${ch != null ? `&ch=${encodeURIComponent(ch)}` : ""}`);
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

// logout link in a header (only when the server has auth enabled)
export function addLogout(info, container) {
  if (!info?.auth || !container || container.querySelector(".logout")) return;
  const b = document.createElement("button");
  b.className = "linkbtn logout";
  b.textContent = "Logout";
  b.onclick = async () => { await fetch("/api/v1/logout", { method: "POST" }); location.href = "/login.html"; };
  container.append(b);
}

// Every sendust window is opened as a popup (never a tab): when the launcher runs as an app window
// (chrome --app=… or "Create shortcut → Open as window"), its popups are app windows too -- no
// address bar. Same name = focus the window that is already open.
export function openWin(url, name, w, h) {
  const W = Math.min(w, screen.availWidth), H = Math.min(h, screen.availHeight);
  const x = (screen.availLeft ?? 0) + Math.max(0, Math.round((screen.availWidth - W) / 2));
  const y = (screen.availTop ?? 0) + Math.max(0, Math.round((screen.availHeight - H) / 2));
  const win = window.open(url, name, `popup,left=${x},top=${y},width=${W},height=${H}`);
  win?.focus();
  return win;
}

// ---- local files over HTTP Range (mpv / VLC can stream and seek) ----------------
// root = "media" (CasparCG media path) | "host" (media browser lower panel); every path segment is
// encoded on its own, so Korean names and spaces survive.
export function rawUrl(root, path) {
  const enc = String(path).split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return `${location.origin}${root === "media" ? "/media/" : `/raw/${root}/`}${enc}`;
}
// Drag payload understood by external players (and by text drops: one URL per line).
export function setDragUrls(dt, urls) {
  if (!urls.length) return;
  dt.setData("text/uri-list", urls.join("\r\n"));
  dt.setData("text/plain", urls.join("\n"));
}
// Clipboard: navigator.clipboard needs a secure context, plain http://<ip> falls back to execCommand.
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* not a secure context */ }
  const ta = document.createElement("textarea");
  ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.append(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { /* */ }
  ta.remove();
  return ok;
}

// Resizable table columns: drag the right edge of a header cell; double-click it for automatic widths.
// Every column except the last gets a fixed px width (the last takes what is left); remembered in
// localStorage under `key`. The table gets class "rzt" (+ "fixed" once widths are set).
export function resizableColumns(table, key) {
  const ths = [...table.tHead.rows[0].cells], last = ths.length - 1;
  let cols = null;
  table.classList.add("rzt");
  const apply = () => {
    table.classList.toggle("fixed", !!cols);
    ths.forEach((th, i) => { th.style.width = cols && i < last ? `${cols[i]}px` : ""; });
    table.style.minWidth = cols ? `${cols.reduce((a, b) => a + b, 0) + 80}px` : "";
  };
  try { const c = JSON.parse(localStorage.getItem(key)); if (Array.isArray(c) && c.length === last) cols = c; } catch { /* none */ }
  apply();
  ths.slice(0, last).forEach((th, i) => {
    const h = document.createElement("span");
    h.className = "rz";
    h.title = "끌어서 열 너비 조절 (더블클릭: 자동)";
    th.append(h);
    h.addEventListener("click", e => e.stopPropagation());   // not a header click (sorting)
    h.addEventListener("pointerdown", e => {
      e.preventDefault(); e.stopPropagation();
      if (!cols) cols = ths.slice(0, last).map(t => Math.ceil(t.getBoundingClientRect().width) + 1);   // never cut what fits now
      const x0 = e.clientX, w0 = cols[i];
      h.setPointerCapture(e.pointerId);
      h.classList.add("drag");
      const move = ev => { cols[i] = Math.max(28, Math.round(w0 + ev.clientX - x0)); apply(); };
      const up = () => {
        h.removeEventListener("pointermove", move); h.removeEventListener("pointerup", up);
        h.classList.remove("drag");
        try { localStorage.setItem(key, JSON.stringify(cols)); } catch { /* private mode */ }
      };
      h.addEventListener("pointermove", move);
      h.addEventListener("pointerup", up);
    });
    h.addEventListener("dblclick", e => {
      e.stopPropagation();
      cols = null; apply();
      try { localStorage.removeItem(key); } catch { /* */ }
    });
  });
}

// launcher "모두 종료": every window opened by a launcher closes itself (window.close() only works for
// script-opened windows, so a tab the user opened by hand stays)
if ("BroadcastChannel" in window && !location.pathname.endsWith("launcher.html")) {
  new BroadcastChannel("sendust").onmessage = e => { if (e.data?.cmd === "close") window.close(); };
}
