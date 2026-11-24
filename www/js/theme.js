// Colour theme of the playback window and the media browser: one button at the top cycles
// dark → white → gray → pink → brown. The choice is kept in localStorage (same for every window
// of this server) and windows that are already open follow at once (storage event).
// The page's <head> applies the stored theme before first paint (inline snippet), this module
// adds the button.
export const THEMES = ["dark", "white", "gray", "pink", "brown"];
const KEY = "sp.theme";

const read = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
const valid = t => (THEMES.includes(t) ? t : "dark");

function apply(t, btn) {
  t = valid(t);
  if (t === "dark") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  if (btn) { btn.textContent = t; btn.title = `화면 테마: ${t} (클릭: 다음 테마)`; }
  return t;
}

export function initTheme(btn) {
  let cur = apply(read(), btn);
  btn.addEventListener("mousedown", e => e.preventDefault());   // keep keyboard shortcuts alive
  btn.onclick = () => {
    cur = apply(THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length], btn);
    try { localStorage.setItem(KEY, cur); } catch { /* private mode: this window only */ }
  };
  addEventListener("storage", e => { if (e.key === KEY) cur = apply(e.newValue, btn); });
}
