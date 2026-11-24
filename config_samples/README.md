# sendust_player.json 샘플

쓰려는 파일을 저장소 루트에 `sendust_player.json` 으로 복사한 뒤 백엔드를 재시작한다 (`./run.sh restart`).
`casparcg.media_path`, `browser.lower_root`, `shared_playlist_path` 는 서버 환경에 맞게 고친다.
없는 키는 `backend/config.py` 의 기본값을 쓴다. 키 설명은 루트 README 의 "설정" 표.

| 파일 | 구성 | CasparCG 채널 (casparcg.config) |
|---|---|---|
| `sendust_player.1ch_osd.json` | 재생 1채널 + OSD | ch1 = PLAY 1 클린 출력, ch2 = PLAY 1 OSD 출력 (route + TC/파일명 HTML 오버레이) |
| `sendust_player.3ch_no_osd.json` | 재생 3채널, OSD 없음 | ch1 / ch2 / ch3 = PLAY 1 / 2 / 3 클린 출력 |

- `clean_out`, `osd_out` 은 CasparCG 채널 번호(1부터). 채널마다 DeckLink consumer 는 casparcg.config 에서 정한다.
- OSD 를 쓰려면 `osd.enabled: true` 이고 채널에 `osd_out` 이 있어야 한다. OSD 채널은 CasparCG 의 HTML producer(CEF)를 쓴다.
- `tc_mode`: 재생 창 큰 TC 의 종류 (`source` = 파일에 기록된 TC(빨간 TC), `elapsed` = IN 을 0 으로 한 경과(흰 TC)).
  재생 창에서 TC 를 클릭하면 바뀌고 이 파일에 저장된다. OSD 의 TC 도 이 값을 따른다.
- 인증을 쓰려면 `"auth": true` 와 `"password"` 를, 외부 제어 키는 `ext_control.key` 를 넣는다 (샘플은 비어 있음).
