// MXF (SMPTE 377M) index reader that works purely through HTTP Range requests.
//
// open(url) reads:
//   1. the Random Index Pack at the end of the file  -> list of partitions
//      (fallback: walk the footer -> PreviousPartition chain)
//   2. every partition pack + its index table segments
//   3. header metadata (edit rate, timecode, audio descriptors)
// and builds an edit-unit -> byte offset table so that any GOP can be fetched
// with a single Range request.

const MXF_PREFIX = [0x06, 0x0e, 0x2b, 0x34];

export async function fetchRange(url, start, end /* exclusive */, signal) {
  const r = await fetch(url, { headers: { Range: `bytes=${start}-${end - 1}` }, signal });
  if (r.status !== 206 && r.status !== 200) throw new Error(`HTTP ${r.status} for range ${start}-${end}`);
  const buf = new Uint8Array(await r.arrayBuffer());
  // a server that ignores Range returns the whole file; slice defensively
  if (r.status === 200 && buf.length > end - start) return buf.subarray(start, end);
  return buf;
}

async function fetchSize(url) {
  const r = await fetch(url, { headers: { Range: 'bytes=0-0' } });
  const cr = r.headers.get('Content-Range');
  await r.arrayBuffer().catch(() => {});
  if (cr) return Number(cr.split('/')[1]);
  const h = await fetch(url, { method: 'HEAD' });
  return Number(h.headers.get('Content-Length'));
}

// ---------------------------------------------------------------- KLV helpers
const isMxfKey = (b, p) => b[p] === 0x06 && b[p + 1] === 0x0e && b[p + 2] === 0x2b && b[p + 3] === 0x34;

export function readKLV(b, p) {
  if (p + 17 > b.length || !isMxfKey(b, p)) return null;
  let q = p + 16;
  let len = b[q++];
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n > 8 || q + n > b.length) return null;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + b[q++];
  }
  return { key: p, val: q, len, next: q + len };
}

const be16 = (b, p) => (b[p] << 8) | b[p + 1];
const be32 = (b, p) => ((b[p] << 24) >>> 0) + ((b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]);
const be64 = (b, p) => be32(b, p) * 4294967296 + be32(b, p + 4);
const s64 = (b, p) => {
  const hi = (b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3];
  return hi * 4294967296 + be32(b, p + 4);
};

// key classifiers (byte 4..12 compared loosely, as most readers do)
const isPartitionPack = (b, k) => b[k + 4] === 0x02 && b[k + 5] === 0x05 && b[k + 8] === 0x0d && b[k + 9] === 0x01 &&
  b[k + 10] === 0x02 && b[k + 11] === 0x01 && b[k + 12] === 0x01 && b[k + 13] >= 0x02 && b[k + 13] <= 0x04;
const isIndexSegment = (b, k) => b[k + 4] === 0x02 && b[k + 5] === 0x53 && b[k + 8] === 0x0d && b[k + 9] === 0x01 &&
  b[k + 10] === 0x02 && b[k + 11] === 0x01 && b[k + 12] === 0x01 && b[k + 13] === 0x10 && b[k + 14] === 0x01;
const isRIP = (b, k) => b[k + 4] === 0x02 && b[k + 5] === 0x05 && b[k + 12] === 0x01 && b[k + 13] === 0x11;
export const isEssence = (b, k) => b[k + 4] === 0x01 && b[k + 5] === 0x02 && b[k + 8] === 0x0d && b[k + 9] === 0x01 &&
  b[k + 10] === 0x03 && b[k + 11] === 0x01;
const isLocalSet = (b, k) => b[k + 4] === 0x02 && b[k + 5] === 0x53;

function parseLocalSet(b, start, end) {
  const tags = new Map();
  let p = start;
  while (p + 4 <= end) {
    const tag = be16(b, p), len = be16(b, p + 2);
    tags.set(tag, b.subarray(p + 4, p + 4 + len));
    p += 4 + len;
  }
  return tags;
}

function parsePartitionPack(b, kl) {
  const v = kl.val;
  return {
    kind: b[kl.key + 13], // 2 header, 3 body, 4 footer
    status: b[kl.key + 14],
    kag: be32(b, v + 4),
    thisPartition: be64(b, v + 8),
    previousPartition: be64(b, v + 16),
    footerPartition: be64(b, v + 24),
    headerByteCount: be64(b, v + 32),
    indexByteCount: be64(b, v + 40),
    indexSID: be32(b, v + 48),
    bodyOffset: be64(b, v + 52),
    bodySID: be32(b, v + 60),
  };
}

function parseIndexSegment(b, kl) {
  const t = parseLocalSet(b, kl.val, kl.next);
  const rat = (x) => (x ? [be32(x, 0), be32(x, 4)] : null);
  const seg = {
    editRate: rat(t.get(0x3f0b)),
    start: t.has(0x3f0c) ? s64(t.get(0x3f0c), 0) : 0,
    duration: t.has(0x3f0d) ? s64(t.get(0x3f0d), 0) : 0,
    editUnitByteCount: t.has(0x3f05) ? be32(t.get(0x3f05), 0) : 0,
    indexSID: t.has(0x3f06) ? be32(t.get(0x3f06), 0) : 0,
    bodySID: t.has(0x3f07) ? be32(t.get(0x3f07), 0) : 0,
    entries: null,
  };
  const a = t.get(0x3f0a);
  if (a && a.length >= 8) {
    const n = be32(a, 0), sz = be32(a, 4);
    const ent = { temporal: new Int8Array(n), keyOffset: new Int8Array(n), flags: new Uint8Array(n), offset: new Float64Array(n) };
    for (let i = 0; i < n; i++) {
      const p = 8 + i * sz;
      if (p + 11 > a.length) break;
      ent.temporal[i] = (a[p] << 24) >> 24;
      ent.keyOffset[i] = (a[p + 1] << 24) >> 24;
      ent.flags[i] = a[p + 2];
      ent.offset[i] = be64(a, p + 3);
    }
    seg.entries = ent;
  }
  return seg;
}

// --------------------------------------------------------- header metadata
// Only a handful of sets are interesting for playback.
function parseHeaderMetadata(b, start, end, info) {
  let p = start;
  while (p < end) {
    const kl = readKLV(b, p);
    if (!kl) break;
    const k = kl.key;
    if (isLocalSet(b, k) && b[k + 8] === 0x0d && b[k + 9] === 0x01 && b[k + 10] === 0x01 && b[k + 11] === 0x01) {
      const setId = (b[k + 14] << 8) | b[k + 15];
      const t = parseLocalSet(b, kl.val, kl.next);
      if (setId === 0x1400 && !info.timecode) {
        // TimecodeComponent
        info.timecode = {
          start: t.has(0x1501) ? s64(t.get(0x1501), 0) : 0,
          base: t.has(0x1502) ? be16(t.get(0x1502), 0) : 0,
          dropFrame: t.has(0x1503) ? t.get(0x1503)[0] === 1 : false,
        };
      } else if (setId === 0x4700 || setId === 0x4800) {
        // AES3 / WAVE PCM descriptor
        const sr = t.get(0x3d03);
        info.audioDescriptors.push({
          sampleRate: sr ? be32(sr, 0) / be32(sr, 4) : 48000,
          channels: t.has(0x3d07) ? be32(t.get(0x3d07), 0) : 1,
          bits: t.has(0x3d01) ? be32(t.get(0x3d01), 0) : 24,
          blockAlign: t.has(0x3d0a) ? be16(t.get(0x3d0a), 0) : 0,
        });
      } else if (setId === 0x5100 || setId === 0x2800 || setId === 0x2900 || setId === 0x2700) {
        // MPEG / CDCI / RGBA / generic picture descriptor
        const sr = t.get(0x3001);
        const fl = t.get(0x320c);
        info.picture = info.picture || {};
        if (sr) info.picture.sampleRate = [be32(sr, 0), be32(sr, 4)];
        if (t.has(0x3203)) info.picture.storedWidth = be32(t.get(0x3203), 0);
        if (t.has(0x3202)) info.picture.storedHeight = be32(t.get(0x3202), 0);
        if (fl) info.picture.frameLayout = fl[0];
        const ar = t.get(0x320e);
        if (ar) info.picture.aspect = [be32(ar, 0), be32(ar, 4)];
      }
    }
    p = kl.next;
  }
}

// ------------------------------------------------------------- main entry
export async function openMxf(url, onProgress = () => {}) {
  const size = await fetchSize(url);
  if (!size) throw new Error('cannot determine file size');

  // ---- 1. partitions via RIP
  const tailLen = Math.min(size, 65536);
  const tail = await fetchRange(url, size - tailLen, size);
  let partitionOffsets = [];
  const ripLen = be32(tail, tail.length - 4);
  if (ripLen > 0 && ripLen <= tail.length) {
    const p = tail.length - ripLen;
    const kl = readKLV(tail, p);
    if (kl && isRIP(tail, p)) {
      for (let q = kl.val; q + 12 <= kl.next - 4; q += 12) partitionOffsets.push(be64(tail, q + 4));
    }
  }

  // header partition (also needed for header metadata)
  const headBuf = await fetchRange(url, 0, Math.min(size, 262144));
  const hkl = readKLV(headBuf, 0);
  if (!hkl || !isPartitionPack(headBuf, 0)) throw new Error('not an MXF file (no header partition pack)');
  const headerPack = parsePartitionPack(headBuf, hkl);

  if (!partitionOffsets.length) {
    // fallback: walk back from footer
    const offs = [];
    let off = headerPack.footerPartition;
    const seen = new Set();
    while (off && !seen.has(off) && off < size) {
      seen.add(off);
      offs.push(off);
      const b = await fetchRange(url, off, Math.min(size, off + 256));
      const kl = readKLV(b, 0);
      if (!kl || !isPartitionPack(b, 0)) break;
      off = parsePartitionPack(b, kl).previousPartition;
    }
    offs.push(0);
    partitionOffsets = [...new Set(offs)].sort((a, b) => a - b);
  }
  partitionOffsets.sort((a, b) => a - b);

  // ---- 2. read each partition: pack, header metadata, index segments, essence start
  const info = { timecode: null, audioDescriptors: [], picture: null };
  const partitions = [];
  const segments = [];
  let done = 0;
  const readPartition = async (off, idx) => {
    let buf = off === 0 ? headBuf : await fetchRange(url, off, Math.min(size, off + 16384));
    let kl = readKLV(buf, 0);
    if (!kl || !isPartitionPack(buf, 0)) return;
    const pack = parsePartitionPack(buf, kl);
    const need = kl.next + pack.headerByteCount + pack.indexByteCount + 2048;
    if (need > buf.length && off + buf.length < size) buf = await fetchRange(url, off, Math.min(size, off + need));
    const part = { ...pack, offset: off, essenceStart: null, end: idx + 1 < partitionOffsets.length ? partitionOffsets[idx + 1] : size };
    let p = kl.next;
    const metaStart = p;
    let headerParsed = false;
    while (p < buf.length) {
      const k = readKLV(buf, p);
      if (!k) break;
      if (isPartitionPack(buf, p)) break; // reached next partition
      if (isEssence(buf, p)) { part.essenceStart = off + p; break; }
      if (isIndexSegment(buf, p)) {
        if (k.next > buf.length) break;
        segments.push(parseIndexSegment(buf, k));
      } else if (!headerParsed && pack.headerByteCount && p >= metaStart && isLocalSet(buf, p) && buf[p + 13] !== 0x10) {
        headerParsed = true;
        const hEnd = Math.min(buf.length, metaStart + pack.headerByteCount);
        parseHeaderMetadata(buf, p, hEnd, info);
        p = Math.max(p, hEnd);
        // headerByteCount may include trailing fill; re-sync on next KLV
        while (p < buf.length && !isMxfKey(buf, p)) p++;
        continue;
      }
      if (k.next > buf.length) {
        // essence can start beyond what we fetched only if there is giant fill; guess
        break;
      }
      p = k.next;
    }
    // essence start lies beyond fetched window (rare): estimate with byte counts
    if (part.essenceStart === null && pack.bodySID && pack.kind !== 4) {
      part.essenceStart = off + kl.next + pack.headerByteCount + pack.indexByteCount;
    }
    partitions[idx] = part;
    onProgress(++done / partitionOffsets.length);
  };
  // limited concurrency
  const queue = partitionOffsets.map((o, i) => [o, i]);
  const workers = Array.from({ length: 6 }, async () => {
    while (queue.length) {
      const [o, i] = queue.shift();
      await readPartition(o, i);
    }
  });
  await Promise.all(workers);

  const essenceParts = partitions.filter((p) => p && p.bodySID && p.essenceStart !== null && p.essenceStart < p.end)
    .sort((a, b) => a.bodyOffset - b.bodyOffset);
  if (!essenceParts.length) throw new Error('no essence partitions found');

  // ---- 3. merge index segments into one table
  segments.sort((a, b) => a.start - b.start);
  const editRate = segments.find((s) => s.editRate)?.editRate || info.picture?.sampleRate || [25, 1];
  const streamEnd = essenceParts.reduce((m, p) => Math.max(m, p.bodyOffset + (p.end - p.essenceStart)), 0);

  let total = 0;
  for (const s of segments) total = Math.max(total, s.start + s.duration);
  let cbr = 0;
  if (!segments.some((s) => s.entries)) {
    cbr = segments.find((s) => s.editUnitByteCount)?.editUnitByteCount || 0;
    if (!cbr) throw new Error('no usable index table in this MXF');
    if (!total) total = Math.floor(streamEnd / cbr);
  }
  const offset = new Float64Array(total + 1);
  const flags = new Uint8Array(total);
  const keyOffset = new Int8Array(total);
  if (cbr) {
    for (let i = 0; i <= total; i++) offset[i] = i * cbr;
    flags.fill(0x80);
  } else {
    offset.fill(-1);
    for (const s of segments) {
      if (!s.entries) continue;
      const n = Math.min(s.entries.offset.length, s.duration || s.entries.offset.length);
      for (let i = 0; i < n; i++) {
        const eu = s.start + i;
        if (eu >= total) break;
        offset[eu] = s.entries.offset[i];
        flags[eu] = s.entries.flags[i];
        keyOffset[eu] = s.entries.keyOffset[i];
      }
    }
    offset[total] = streamEnd;
    // fill gaps (missing segments) by interpolation so we never crash
    for (let i = total - 1; i >= 0; i--) if (offset[i] < 0) offset[i] = offset[i + 1];
  }

  // keyframes (random access points): flags bit 7, or keyOffset == 0
  const keyframes = [];
  for (let i = 0; i < total; i++) {
    if (cbr || (flags[i] & 0x80) || (i === 0)) keyframes.push(i);
  }
  if (keyframes.length < 2 && !cbr) {
    // no random access flags: use keyOffset == 0
    keyframes.length = 0;
    for (let i = 0; i < total; i++) if (keyOffset[i] === 0) keyframes.push(i);
  }
  // build GOP list [start, end)
  const gops = keyframes.map((s, i) => ({ start: s, end: i + 1 < keyframes.length ? keyframes[i + 1] : total }));
  // for intra-only (every frame key) group a few frames per job to amortize ffmpeg start-up
  let merged = gops;
  if (gops.length > 1 && gops.length > total / 2) {
    merged = [];
    for (let s = 0; s < total; s += 15) merged.push({ start: s, end: Math.min(total, s + 15), intra: true });
  }
  const gopOfFrame = new Int32Array(total);
  merged.forEach((g, gi) => gopOfFrame.fill(gi, g.start, g.end));

  const toFile = (so) => {
    // binary search last partition with bodyOffset <= so
    let lo = 0, hi = essenceParts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (essenceParts[mid].bodyOffset <= so) lo = mid; else hi = mid - 1;
    }
    const p = essenceParts[lo];
    return p.essenceStart + (so - p.bodyOffset);
  };

  const fps = editRate[0] / editRate[1];
  const tc = info.timecode || { start: 0, base: Math.round(fps), dropFrame: false };
  if (!tc.base) tc.base = Math.round(fps);

  return {
    url,
    size,
    editRate,
    fps,
    frames: total,
    duration: total / fps,
    timecode: tc,
    audio: info.audioDescriptors,
    picture: info.picture,
    gops: merged,
    gopOfFrame,
    partitions: essenceParts.length,
    /** byte range [start, end) in the file for edit units [a, b) */
    byteRange(a, b) {
      return [toFile(offset[a]), toFile(offset[b]) ];
    },
  };
}
