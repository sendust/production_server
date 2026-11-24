# sendust playlist

[한국어](README.md) | English

A web-based playout for CasparCG 2.5 that plays MXF clips (mainly XDCAM HD422 50 Mb/s), images and audio.
The backend (FastAPI) and CasparCG run on a headless Ubuntu server; operators work in a web browser.
There is one playback window per playback channel; the media browser window is shared.

```
Browser: media browser · PLAY 1 · PLAY 2 · VGA preview · SDI preview
   │ REST /api/v1 + WebSocket /ws
Backend (backend/, :8300) ── AMCP :5250 ──▶ CasparCG ──▶ DeckLink SDI
   │  ◀── OSC udp/6250 (CasparCG sends it to every AMCP client automatically)
   ├─ External control: HTTP /ext/v1 + OSC udp/9250
   └─ SDI preview: CasparCG ffmpeg consumer → mediamtx (RTSP :8554 → WebRTC :8889)
```

## Running

```bash
./run.sh start | stop | restart | log         # backend (logs/backend.log)
~/casparcgserver/run_caspar.sh                 # CasparCG (NVIDIA EGL)
```

First install: `python3 -m venv .venv && .venv/bin/pip install fastapi 'uvicorn[standard]' python-multipart`.
Requirements: ffmpeg/ffprobe, CasparCG 2.5, mediamtx (SDI preview), `libnvidia-gl-580` (CasparCG GPU mixing).

The UI is laid out for control-room HD monitors (1920×1080) with big buttons and text (uMP style).
The playback windows and the media browser have a theme button at the top right
(dark / white / gray / pink / brown); each playback channel and the media browser keep their own theme.

Without an address bar: start the launcher as an **app window**. Every window the launcher opens (playback,
media browser, log, preview) is a popup, so they open without an address bar too.
(A web page cannot hide the address bar by itself.)

```
chrome.exe --app=http://<server>:8300/launcher.html        # Windows shortcut "Target" (Edge: msedge.exe)
```
Or open the launcher in Chrome → menu → Cast, save, and share → Create shortcut → tick "Open as window".

| Window | Address |
|---|---|
| Launcher | `http://<server>:8300/` (`launcher.html`) — 150 px on the left. System info (CPU per core + 60 s history, GPU, disk, NICs, CasparCG process age), open log viewer / media browser, "open all" (playback windows side by side on the right; more than two channels keep the two-across size), close all, channel buttons (with state) |
| Playback | `/player.html?ch=<channel_index>` — clip info (large) or, with Preview ticked, a WebRTC view of the output channel; 8-channel level meter (4×2, fixed; channels the clip does not have are greyed out); TC (click: file TC ↔ elapsed) / DUR / REM (+ n/N and remaining time of the whole list when Playlist play is on); IN/OUT; transport; collapsible zoom timeline; playlist (resizable columns, the on-air line is scrolled into view when it changes). With more than two channels the controls are shown at 80 % |
| Media browser | `/browser.html` — top: CasparCG media, bottom: a favourite path (tree + list), "Transfer" copies into the current media folder, transfer status. Panel heights and column widths are adjustable. "+ PLAY n" in the title bar adds the selected media clips to that channel's playlist, "↗" opens its window |
| Log viewer | `/log.html` — all backend logs (source / level / text filters); connected clients (IP and open pages) at the top |
| VGA preview | select an MXF item in the list → Preview (V) |
| SDI preview (stand-alone) | `/sdi.html?ch=<idx>` |

Window title: `sendust playlist [channel name] {last commit time}`.

## Configuration `sendust_player.json`

Missing keys take the defaults in `backend/config.py`.
Samples: `config_samples/` (1 playback channel + OSD, 3 playback channels without OSD).

| Key | Meaning |
|---|---|
| `http.port` | backend port (default 8300) |
| `auth`, `password` | `true` = password login for the web UI (localhost is exempt: CasparCG's OSD page) |
| `casparcg.media_path` | same as CasparCG's media-path (top panel of the media browser, base of clip paths) |
| `casparcg.video_layer` / `osd_route_layer` / `osd_overlay_layer` | 10 / 10 / 20 |
| `channels[]` | `channel_index`, `name`, `clean_out` (CasparCG channel number), `osd_out` (CasparCG channel number or null), `tc_mode` (`source` = TC recorded in the file / `elapsed` = IN is 0; changed by clicking the TC in the playback window and saved here) |
| `browser.lower_root` | start path of the media browser's bottom panel (default `/mnt`) |
| `shared_playlist_path` | folder of the shared playlists A–D (shared between hosts and channels). LIST 1–9 are per channel in `data/playlists/ch<idx>/slot_N.json`; every save keeps the previous file as `slot_N.prev.json` |
| `playlist.image_sec` | default duration of image items (seconds) |
| `osd.enabled`, `osd.update_frames`, `osd.offset_frames`, `osd.box` | OSD on/off, refresh interval (frames, default 4), TC delay compensation (frames), translucent box |
| `osd.timecode` | `enabled`, `label`, `x`, `y`, `size` (fractions of the frame). The TC kind follows the playback window (`channels[].tc_mode`: red TC = file TC, white TC = elapsed) |
| `osd.filename` | `enabled`, `x`, `y`, `size` |
| `zoom_timeline.seconds` | default ± seconds of the zoom timeline |
| `sdi_preview` | `rtsp_base`, `path_prefix`, `webrtc_port`, `args` (empty = default encoder options) |
| `ext_control` | `enabled`, `key`, `osc_port`, `allow_ips`, `aux1`, `aux2` (see below) |
| `gang.allow_origins` | origins of a gang-control UI (CORS) |

After changing only the OSD settings, no restart is needed: `curl -X POST http://<server>:8300/api/v1/osd/reload`
(the new layout reaches the overlay over SSE at once).

## External control (button boxes, MCUs, Bitfocus Companion, Stream Deck …)

Channel number `n` = PLAY n (from 1). Commands: `play pause stop toggle top next prev eject cue aux1 aux2`
(`next`/`prev` = LOAD the next/previous clip of the playlist without playing it; `aux1`/`aux2` = mapped to another command in the config).

### HTTP (REST, GET or POST)

```
GET http://<server>:8300/ext/v1/<n>/<command>?key=<key>      → 200 "OK\n"   |  4xx "ERR <reason>\n"
GET http://<server>:8300/ext/v1/<n>/status?key=<key>         → text/plain, one key=value per line
```

```
ch=1
name=PLAY 1
status=playing            # empty | loading | playing | paused | ended | offline (CasparCG not responding)
loop=none
playlist_play=1
clip=A001.mxf
frame=1234
in_frame=0
out_frame=2442
elapsed=00:00:41;04
remaining=00:00:39;10
item=2/5
```

The key goes in `?key=` or the `X-Api-Key` header. ESP32 / Arduino example:

```cpp
HTTPClient http;
http.begin("http://<server>:8300/ext/v1/1/play?key=SECRET");
int code = http.GET();          // 200 = success
```

### OSC 1.0 (UDP, default 9250)

```
/sendust/<n>/<command>          e.g. /sendust/1/play
```
Arguments are optional. A numeric argument of 0 (button release) is ignored, so a button that sends 1 on press
and 0 on release triggers only once. OSC has no key, so `ext_control.allow_ips` limits which IPs may send.

## API (for gang control)

Every UI function goes through `/api/v1` REST + the `/ws` WebSocket, so a gang-control UI on another server can use
the same calls. On a server with authentication, send `X-Api-Key: <ext_control.key>`. To call it directly from a
browser, add the gang UI's origin to `gang.allow_origins`.

| Method | Path | Content |
|---|---|---|
| GET | `/api/v1/info` | host, api_version, channel layout, part of the config |
| GET | `/api/v1/status` | summary of every channel (state, clip, position, in/out, playlist) |
| GET | `/api/v1/ch/{idx}` | channel details + playlist + recent log |
| POST | `/api/v1/ch/{idx}/{action}` | `load{file,fin,fout}` `cue{id,on}` `play` `pause` `toggle` `seek{frame}` `step{delta}` `top` `next` `prev` `mark_in` `mark_out` `marks{fin,fout}` `clear_marks` `loop{mode}` `eject` |
| POST | `/api/v1/ch/{idx}/tc_mode` | `{mode: source|elapsed}` (saved in the config) |
| POST | `/api/v1/ch/{idx}/playlist/{op}` | `add{files,at}` `pause{at}` `move{ids,at}` `delete{ids}` `clear` `enable{on}` `marks{id,fin,fout}` `slot{slot}` `save{slot}` `load{slot}` `cue{id,on}` |
| POST | `/api/v1/ch/{idx}/sdi_preview` | `{on, source: clean|osd}` |
| GET | `/api/v1/media/list`, `/media/probe`, POST `/media/scenes` | media list, ffprobe info, scene changes / audio peaks |
| GET | `/api/v1/fs/list` · POST `fs/mkdir|rename|copy|move|delete` · PUT `fs/upload` | file browser |
| WS | `/ws?page=<page>&ch=<idx>` | `hello` (full state), then `tick` (20 Hz), `playlist`, `log`, `job`, `fs`, `sys`, `clients`, `tc_mode` events |

Frame units: the API uses source frame numbers. `out` is, as in an EDL, the first frame that is not played (length = out − in).

## Behaviour when CasparCG stops or restarts

- No OSC from CasparCG for 2 s: the channel state becomes `offline` (blinking OFFLINE in the UI); the loaded clip is kept.
- The CasparCG process disappears: every channel is cleared (EJECT) and the log says `CasparCG stopped: channel cleared`.
- A new CasparCG answers: OSD layers and SDI preview consumers that were on are added again automatically.
- The launcher shows CasparCG as ON only while it answers AMCP (NO RESP = process present but not answering, OFF = no process).

## Layout

| Path | Content |
|---|---|
| `backend/amcp.py`, `osc.py`, `engine.py` | CasparCG connection, OSC state |
| `backend/player.py`, `playlist.py` | channel control, playlist engine (LOADBG AUTO preloading, pause lines, loop) |
| `backend/osd.py`, `www/osd.html` | OSD channel (route + HTML overlay). The backend computes the TC / filename strings and sends them over SSE `/sse/osd?ch=<idx>`; the page only displays them |
| `backend/scenes.py`, `www/js/scenes.js` | zoom timeline (scene changes + audio peaks) |
| `backend/fsops.py`, `www/browser.html` | media browser |
| `wasm/mxfdec.c`, `www/vgap/` | libavcodec wasm decoder and MXF player for the VGA preview |
| `backend/sdi_preview.py`, `www/sdi.html` | SDI preview (WebRTC) |
| `backend/ext.py`, `backend/auth.py` | external control, authentication |
| `backend/sysinfo.py`, `backend/loghub.py` | system info (same as mediarouter), log buffer for the log viewer |
| `www/launcher.html`, `www/log.html`, `www/css/ump.css`, `www/css/theme.css` | launcher, log viewer, control-room style, colour themes |
| `config_samples/` | sample configurations |

## CasparCG 2.5 behaviour worth knowing (measured)

- AMCP `SEEK`/`LENGTH`/`IN`/`OUT` count channel frames (1080i5994 → 59.94/s). The backend converts from source frames.
- `CALL SEEK` ignores IN/OUT, and resuming outside OUT plays past OUT → the backend limits the range.
- The image producer reports no play position → the backend times image playback itself.
- OSC `mixer/audio/volume` = int32 peak per audio channel, dBFS = 20·log10(v/2³¹).
- ffmpeg consumer: options are written `-format`, `-codec:v`, `-filter:v`. `-an` is not supported (it eats the next
  token as its value) → audio is reduced to mono Opus. With the preview on, CasparCG uses about 3–4 more CPU cores.
- With the NVIDIA GL library installed, `LIBGL_ALWAYS_SOFTWARE=1` alone does not give software GL (libglvnd still picks
  NVIDIA); `__EGL_VENDOR_LIBRARY_FILENAMES=/usr/share/glvnd/egl_vendor.d/50_mesa.json` forces Mesa.
- Restarting CasparCG within a few seconds of stopping it can fail to open the DeckLink outputs
  ("Could not enable primary video output"); wait about 8 s.
