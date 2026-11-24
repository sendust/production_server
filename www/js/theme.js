// Colour theme of a playback window or the media browser: one button at the top cycles
// dark → white → gray → pink → brown. Each kind of window has its own theme, kept in localStorage
// under its own key (sp.theme.ch<idx> per playback channel, sp.theme.browser), so PLAY 1 and PLAY 2
// can differ; another window of the same kind follows at once (storage event). The launcher has none.
// The page's <head> applies the stored theme before first paint (inline snippet with the same key).
export const THEMES = ["dark", "white", "gray", "pink", "brown"];

const read = key => { try { return localStorage.getItem(key); } catch { return null; } };
const valid = t => (THEMES.includes(t) ? t : "dark");

function apply(t, btn) {
  t = valid(t);
  if (t === "dark") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  if (btn) { btn.textContent = t; btn.title = `화면 테마: ${t} (클릭: 다음 테마)`; }
  return t;
}

export function initTheme(btn, key) {
  let cur = apply(read(key), btn);
  btn.addEventListener("mousedown", e => e.preventDefault());   // keep keyboard shortcuts alive
  btn.onclick = () => {
    cur = apply(THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length], btn);
    try { localStorage.setItem(key, cur); } catch { /* private mode: this window only */ }
  };
  addEventListener("storage", e => { if (e.key === key) cur = apply(e.newValue, btn); });
}
