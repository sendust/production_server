# sendust playlist

CasparCG 2.5 로 MXF(XDCAM HD422 50 Mb/s 위주)·이미지·오디오 클립을 재생하는 웹 플레이아웃.
headless Ubuntu 서버에서 백엔드(FastAPI)와 CasparCG 가 돌고, 운용은 웹 브라우저에서 한다.
재생 채널 하나당 재생 제어창 하나, 미디어 브라우저 창은 공유.

```
브라우저: 미디어 브라우저 · PLAY 1 · PLAY 2 · VGA 프리뷰 · SDI 프리뷰
   │ REST /api/v1 + WebSocket /ws
백엔드 (backend/, :8300) ── AMCP :5250 ──▶ CasparCG ──▶ DeckLink SDI
   │  ◀── OSC udp/6250 (CasparCG 가 AMCP 클라이언트에게 자동 전송)
   ├─ 외부 제어: HTTP /ext/v1 + OSC udp/9250
   └─ SDI 프리뷰: CasparCG ffmpeg consumer → mediamtx (RTSP :8554 → WebRTC :8889)
```

## 실행

```bash
./run.sh start | stop | restart | log         # 백엔드 (logs/backend.log)
~/casparcgserver/run_caspar.sh                 # CasparCG (NVIDIA EGL)
```

처음 설치: `python3 -m venv .venv && .venv/bin/pip install fastapi 'uvicorn[standard]' python-multipart`.
필요: ffmpeg/ffprobe, CasparCG 2.5, mediamtx(SDI 프리뷰), `libnvidia-gl-580`(CasparCG GPU 합성).

UI 는 부조정실 HD 모니터(1920×1080)에 맞춘 큰 버튼/글자 배치(uMP 스타일)다.

| 창 | 주소 |
|---|---|
| 런처 | `http://<서버>:8300/` (`launcher.html`) — 왼쪽 150px. sysinfo, 로그 뷰어/미디어 브라우저 열기, 일괄 실행(재생 창을 오른쪽에 나란히), 모두 종료, 채널 버튼(상태 표시) |
| 재생 창 | `/player.html?ch=<channel_index>` — 클립 정보(큰 글자) 또는 Preview 체크 시 송출 채널 WebRTC 영상, 8ch 레벨미터(4×2 고정, 클립에 없는 채널은 회색), TC/DUR/EL/REM, IN/OUT, 트랜스포트, 접이식 확대 타임라인, 리스트 |
| 미디어 브라우저 | `/browser.html` — 위: CasparCG media, 아래: 즐겨찾기 경로(트리+목록), "전송하기"로 media 현재 폴더에 복사, 전송현황 |
| 로그 뷰어 | `/log.html` — 백엔드 전체 로그 (소스/레벨/문구 필터) |
| VGA 프리뷰 | 리스트에서 MXF 항목 선택 → Preview (V) |
| SDI 프리뷰 (단독) | `/sdi.html?ch=<idx>` |

창 제목: `sendust playlist [채널명] {마지막 커밋 시각}`.

## 설정 `sendust_player.json`

없는 키는 `backend/config.py` 의 기본값을 쓴다.

| 키 | 의미 |
|---|---|
| `http.port` | 백엔드 포트 (기본 8300) |
| `auth`, `password` | `true` 면 웹 UI 에 비밀번호 로그인 (localhost 는 예외: CasparCG OSD 페이지) |
| `casparcg.media_path` | CasparCG media-path 와 같게 (미디어 브라우저 위 판넬, 클립 경로 기준) |
| `casparcg.video_layer` / `osd_route_layer` / `osd_overlay_layer` | 10 / 10 / 20 |
| `channels[]` | `channel_index`, `name`, `clean_out`(CasparCG 채널 번호), `osd_out`(CasparCG 채널 번호 또는 null) |
| `browser.lower_root` | 미디어 브라우저 아래 판넬 시작 경로 (기본 `/mnt`) |
| `shared_playlist_path` | 공유 플레이리스트 A~D 저장 폴더 (호스트 간 공유 경로) |
| `playlist.image_sec` | 이미지 항목 기본 길이(초) |
| `osd.enabled`, `osd.update_frames`, `osd.offset_frames`, `osd.box` | OSD 사용, 갱신 주기(프레임, 기본 4), TC 지연 보정(프레임), 반투명 배경 |
| `osd.timecode` | `enabled`, `mode`(`elapsed`/`remaining`/`source`), `label`, `x`, `y`, `size` (화면 비율) |
| `osd.filename` | `enabled`, `x`, `y`, `size` |
| `zoom_timeline.seconds` | 확대 타임라인 기본 ±초 |
| `sdi_preview` | `rtsp_base`, `path_prefix`, `webrtc_port`, `args`(빈 값 = 기본 인코딩 옵션) |
| `ext_control` | `enabled`, `key`, `osc_port`, `allow_ips`, `aux1`, `aux2` (아래) |
| `gang.allow_origins` | gang 제어 UI 의 origin (CORS) |

OSD 설정만 바꿨을 때는 재시작 없이 `curl -X POST http://<서버>:8300/api/v1/osd/reload` (새 배치가 SSE 로 바로 반영된다).

## 외부 제어 (버튼 박스, MCU, Bitfocus Companion, Stream Deck …)

채널 번호 `n` = PLAY n (1부터). 명령: `play pause stop toggle top next prev eject cue aux1 aux2`
(`next`/`prev` = 플레이리스트의 다음/이전 클립을 LOAD, 재생은 하지 않음. `aux1`/`aux2` = 설정에서 다른 명령에 할당).

### HTTP (REST, GET 또는 POST)

```
GET http://<서버>:8300/ext/v1/<n>/<command>?key=<key>      → 200 "OK\n"   |  4xx "ERR <이유>\n"
GET http://<서버>:8300/ext/v1/<n>/status?key=<key>         → text/plain, key=value 한 줄씩
```

```
ch=1
name=PLAY 1
status=playing            # empty | loading | playing | paused | ended
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

키는 `?key=` 또는 `X-Api-Key` 헤더. ESP32/Arduino 예:

```cpp
HTTPClient http;
http.begin("http://10.10.108.103:8300/ext/v1/1/play?key=SECRET");
int code = http.GET();          // 200 이면 성공
```

### OSC 1.0 (UDP, 기본 9250)

```
/sendust/<n>/<command>          예) /sendust/1/play
```
인자는 없어도 된다. 인자가 숫자 0 이면(버튼을 뗄 때) 무시하므로 누를 때 1, 뗄 때 0 을 보내는 버튼도 한 번만 동작한다.
OSC 에는 키가 없으므로 `ext_control.allow_ips` 로 보낼 수 있는 IP 를 제한한다.

## API (gang control 대비)

모든 UI 기능은 `/api/v1` REST + `/ws` WebSocket 으로 되어 있어, 다른 서버의 gang 제어 UI 가 그대로 쓸 수 있다.
인증이 켜진 서버는 `X-Api-Key: <ext_control.key>` 헤더로 접근한다. 브라우저에서 직접 부르려면 `gang.allow_origins` 에
gang UI 의 origin 을 넣는다.

| 메서드 | 경로 | 내용 |
|---|---|---|
| GET | `/api/v1/info` | host, api_version, 채널 구성, 설정 일부 |
| GET | `/api/v1/status` | 모든 채널 요약 (상태, 클립, 위치, in/out, 플레이리스트) |
| GET | `/api/v1/ch/{idx}` | 채널 상세 + 플레이리스트 + 최근 로그 |
| POST | `/api/v1/ch/{idx}/{action}` | `load{file,fin,fout}` `cue{id,on}` `play` `pause` `toggle` `seek{frame}` `step{delta}` `top` `next` `prev` `mark_in` `mark_out` `marks{fin,fout}` `clear_marks` `loop{mode}` `eject` |
| POST | `/api/v1/ch/{idx}/playlist/{op}` | `add{files,at}` `pause{at}` `move{ids,at}` `delete{ids}` `clear` `enable{on}` `marks{id,fin,fout}` `slot{slot}` `save{slot}` `load{slot}` `cue{id,on}` |
| POST | `/api/v1/ch/{idx}/sdi_preview` | `{on, source: clean|osd}` |
| GET | `/api/v1/media/list`, `/media/probe`, POST `/media/scenes` | 미디어 목록, ffprobe 정보, 장면 전환/오디오 peak |
| GET | `/api/v1/fs/list` · POST `fs/mkdir|rename|copy|move|delete` · PUT `fs/upload` | 파일 브라우저 |
| WS | `/ws` | `hello`(전체 상태) 후 `tick`(20 Hz), `playlist`, `log`, `job`, `fs` 이벤트 |

프레임 단위: API 는 원본(소스) 프레임 번호. `out` 은 EDL 처럼 재생되지 않는 첫 프레임(길이 = out − in).

## 구조

| 경로 | 내용 |
|---|---|
| `backend/amcp.py`, `osc.py`, `engine.py` | CasparCG 연결, OSC 상태 |
| `backend/player.py`, `playlist.py` | 채널 제어, 플레이리스트 엔진(LOADBG AUTO 미리 로드, pause 라인, loop) |
| `backend/osd.py`, `www/osd.html` | OSD 채널 (route + HTML 오버레이). TC·파일명 문자열은 백엔드가 계산해 SSE `/sse/osd?ch=<idx>` 로 보내고, 페이지는 표시만 한다 |
| `backend/scenes.py`, `www/js/scenes.js` | 확대 타임라인 (scene change + audio peak) |
| `backend/fsops.py`, `www/browser.html` | 미디어 브라우저 |
| `wasm/mxfdec.c`, `www/vgap/` | VGA 프리뷰용 libavcodec wasm 디코더와 MXF 플레이어 |
| `backend/sdi_preview.py`, `www/sdi.html` | SDI 프리뷰 (WebRTC) |
| `backend/ext.py`, `backend/auth.py` | 외부 제어, 인증 |
| `backend/sysinfo.py`, `backend/loghub.py` | 시스템 정보(mediarouter 와 동일), 로그 뷰어용 로그 버퍼 |
| `www/launcher.html`, `www/log.html`, `www/css/ump.css` | 런처, 로그 뷰어, 부조정실용 스타일 |

## 알아 둘 CasparCG 2.5 특성 (실측)

- AMCP `SEEK`/`LENGTH`/`IN`/`OUT` 은 채널 프레임 단위(1080i5994 → 59.94/s). 백엔드가 소스 프레임을 변환한다.
- `CALL SEEK` 는 IN/OUT 을 무시하고, OUT 밖에서 재개하면 OUT 을 지나 재생한다 → 백엔드가 범위를 제한.
- 이미지 producer 는 재생 위치를 보내지 않는다 → 백엔드가 이미지 재생 시간을 직접 잰다.
- OSC `mixer/audio/volume` = 채널별 int32 peak, dBFS = 20·log10(v/2³¹).
- ffmpeg consumer: 옵션은 `-format`, `-codec:v`, `-filter:v` 형식. `-an` 미지원(다음 토큰을 값으로 먹음) → 오디오는 mono Opus 로 최소화.
  필터 `format=bgra` 는 CasparCG 를 죽였다(SIGILL). 켜 두면 CasparCG CPU 가 약 3~4코어 늘어난다.
