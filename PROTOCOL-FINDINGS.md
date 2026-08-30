# DvT Protocol Findings — PERMANENT REFERENCE
## Do NOT delete this file. All reverse-engineering results go here.

## Game Architecture
- Game APK: `flyingchess.apk` (46MB) — Cocos2dx + Lua
- Native engine: `libqpry_lua.so` (18-22MB) — contains TCP protocol, XOR 0x70 encoding
- Lua scripts: XXTEA-encrypted (key: `RY_QP_MBCLIENT_!2016`), header `RY_QP_2016` (10 bytes)
- Java layer: ProGuard-obfuscated `d/a/a/a/` package — HTTP/networking framework
- Game server: `13.200.156.117:9999` (TCP)
- Login server: `13.200.156.117:8880` (HTTP, returns 404 — may be disabled)
- Config server: `http://g.wanlimyaddress.com/flyingchess.json` (RC4-encrypted)

## Credentials
- RC4 password: `fdRCNrUYaZkmr8hoEAgkMsLtu84hmq0u`
- XXTEA key: `RY_QP_MBCLIENT_!2016`
- UID: 7619304
- Pass: 748BA04496DA4923BAE1F7E9E940C5DB
- Machine ID: `61a4ee22f50617a58f17ee72b6a9e7ed`
- App ID: `8740058`
- Channel: `7157322`

## Protocol Details
- Frame format: `[byte0][byte1][u16_LE_length][XOR_0x70_encoded_payload]`
- Length field includes the 4-byte header
- Payload after XOR decode: `[u16_LE_main_cmd][u16_LE_sub_cmd][data...]`
- Heartbeat: 12-byte frame, send every 10-12 seconds

## Frame Types (from 60s capture)
- `0x2f.0x39`: 362 occurrences, 9B payload — player activity (NOT card data)
- `0x2f.0xe7`: 210 occurrences — also not card data
- `0x2f.0xe5`: 87 occurrences
- `0x3c.0x09`: 3 occurrences, **44B payload = 20-round sliding window** ← ROUND DATA
- `0x3c.0xff`: 3 occurrences, **204B payload = 93-round full history** ← ALSO ROUND DATA
- `0x3c.0xc3`: 31 occurrences — table state (no cards)
- `0x3c.0xd8`: 18 occurrences — table info (no cards)
- `0x3c.0x93`: 2 occurrences, 11KB — large data dump

## Round Data Format (0x3c.0x09)
- Total frame: 48 bytes (4 header + 44 payload)
- Payload: `3c 00 09 00` + 40 bytes of card pairs
- Each pair: `[dragon_rank_byte][tiger_rank_byte]`
- 20 pairs per window, sliding overlap with previous window
- New round detected by finding overlap between consecutive windows

## Rank Table
```
0x34 → 2    0x5f → 3    0x30 → 4    0x1e → 5
0xfe → 6    0x35 → 7    0x2f → 8    0x0e → 9
0xdb → 10   0x6f → 11   0xc4 → 12   0x5c → 13
0xdc → 14
```
Card names: 2,3,4,5,6,7,8,9,10,J,Q,K,A

## Handshake Frames (frames.json — 14 frames)
- Frame 0: 136B — initial handshake
- Frame 1: 78B — auth
- Frame 2: 221B — login packet (has UID+password embedded via nibble table)
- Frame 3: 82B — post-login
- Frame 4: 12B — heartbeat/keepalive
- Frames 5-13: 12B each — additional heartbeat frames
- Only frames 0-4 need to be sent (like the bridge does)

## Nibble Table (for login packet encoding)
```
[0x82, 0x50, 0x1b, 0x3a, 0x54, 0x29, 0xf9, 0x14,
 0xa7, 0x32, 0x57, 0xc8, 0xb5, 0xfc, 0x7e, 0x8a]
```

## Login Packet Template (tpl217.bin — 217 bytes)
- Password at bytes 19+i*2 (i=0..31), encoded with nibble table
- UID at bytes 15-18, XOR'd with keystream [0x9b, 0x00, 0xe0, 0x00]
- Machine ID at bytes 85+i*2, encoded with nibble table

## Connection Timing
- First 0x3c.0x09 frame: ~20s after connect
- Subsequent frames: every ~15-30s
- Each frame typically has 1 new round (overlap of 19/20 with previous)
- Connection stays alive 5+ minutes without heartbeat
- With heartbeat: stays alive indefinitely

## What Works
- Python test: connects, sends frames 0-4, receives 0x3c.0x09 rounds ✅
- Node.js bridge: connects, parses rounds, stores them ✅
- Bridge received live rounds: #1053 D(Jv8), #1054 D(Kv7), #21 T(3v10), #22 T(3vA) ✅

## What Doesn't Work
- APK: connects but user reports "zero rounds extracted"
- APK status cycles between "Stale" and "Native Live"
- Possible causes:
  1. `liveState.ok` in app.js stays false (fixed by making it global)
  2. WebView evaluateJavascript might not execute properly
  3. Android thread scheduling delays round injection
  4. The APK's GameConnection might have a subtle parsing bug

## Game APK Lua Files (decrypted from .rer archive)
- `src/app/NetData.luac` — network config loader (RC4 decrypt of netData.json)
- `src/app/ZZRc4.luac` — RC4 implementation
- `src/app/base64.luac` — base64 codec
- `src/app/views/WelcomeScene.luac` — 40KB welcome screen (mostly UI)
- `src/goldtwomain.luac` — Java source stored as .luac (not Lua code)
- Config from `res/netData.json`: server URL, encrypted params

## Lessons Learned
1. The XOR 0x70 is in native C++ code, NOT in Java or Lua
2. The game uses Cocos2dx + Lua, not pure Java
3. The `.rer` file is a ZIP containing the actual game (Lua scripts + native .so)
4. The obfuscated `goldtwo*.luac` files are actually Java source, not Lua
5. The `d/a/a/a/q0/` package is a standard HTTP library, not the game protocol
6. The game's networking library uses DES encryption (in `q0/g/j.smali`)
7. The actual game protocol (XOR, frame parsing) is in the native `.so` library
