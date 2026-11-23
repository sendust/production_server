// SMPTE timecode helpers (supports 29.97/59.94 drop-frame)

export function framesToTc(frames, base, dropFrame) {
  let f = Math.max(0, Math.floor(frames));
  if (dropFrame && (base === 30 || base === 60)) {
    const drop = base === 30 ? 2 : 4;
    const per10 = base * 600 - drop * 9;      // frames per 10 minutes
    const per1 = base * 60 - drop;            // frames per (dropped) minute
    const d = Math.floor(f / per10);
    let m = f % per10;
    if (m > drop) f += drop * 9 * d + drop * Math.floor((m - drop) / per1);
    else f += drop * 9 * d;
  }
  const ff = f % base;
  const ss = Math.floor(f / base) % 60;
  const mm = Math.floor(f / (base * 60)) % 60;
  const hh = Math.floor(f / (base * 3600)) % 24;
  const p = (n) => String(n).padStart(2, '0');
  return `${p(hh)}:${p(mm)}:${p(ss)}${dropFrame ? ';' : ':'}${p(ff)}`;
}

/** parse "hh:mm:ss:ff" (or ;ff) to a frame count in the same counting as framesToTc */
export function tcToFrames(tc, base, dropFrame) {
  const m = String(tc).trim().match(/^(\d{1,2})[:;.](\d{1,2})[:;.](\d{1,2})[:;.](\d{1,2})$/);
  if (!m) return null;
  const [hh, mm, ss, ff] = m.slice(1).map(Number);
  let total = ((hh * 60 + mm) * 60 + ss) * base + ff;
  if (dropFrame && (base === 30 || base === 60)) {
    const drop = base === 30 ? 2 : 4;
    const totalMinutes = hh * 60 + mm;
    total -= drop * (totalMinutes - Math.floor(totalMinutes / 10));
  }
  return total;
}

export function fmtBytes(n) {
  if (n >= 1 << 30) return (n / (1 << 30)).toFixed(2) + ' GB';
  if (n >= 1 << 20) return (n / (1 << 20)).toFixed(1) + ' MB';
  if (n >= 1 << 10) return (n / (1 << 10)).toFixed(0) + ' KB';
  return n + ' B';
}
