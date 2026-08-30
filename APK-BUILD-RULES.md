# APK BUILD RULES — READ BEFORE EVERY BUILD

## CRITICAL: What you MUST NEVER touch
- `classes.dex` — 49 original classes (game protocol, Firebase, activity helpers). REPLACE = INSTALL FAIL
- `classes2.dex` — Firebase classes. REPLACE = INSTALL FAIL  
- `AndroidManifest.xml` — package `com.dvtlive.predictor`, activity `goldaaa.goldaab.goldabc.StartGame`
- `resources.arsc` — resource IDs for icons (mdpi, hdpi, xhdpi only)

## What you CAN update
- `assets/app.js` — predictor web UI logic
- `assets/index.html` — predictor web UI layout
- `assets/engine.js` — statistics engine
- `assets/frames.json`, `assets/heartbeat.bin`, `assets/tpl217.bin` — protocol data
- ADD new files to `assets/` (coins, sounds, etc.)

## Correct Build Steps
```bash
# 1. Copy working APK as base
cp dvt-predictor3.apk DvT-Predictor-Flagship.apk

# 2. Strip signature
zip -d DvT-Predictor-Flagship.apk "META-INF/*"

# 3. Update assets with CORRECT paths (must match ZIP internal paths)
cd /tmp/zip-assets  # where assets/ subdirectory has the new files
zip -u /home/user/DvT-Predictor-Flagship.apk assets/app.js assets/index.html
# To add new files:
zip -u /home/user/DvT-Predictor-Flagship.apk assets/newfile.png

# 4. Sign
apksigner sign --ks keystore/release.keystore --ks-key-alias dvtkey \
  --ks-pass pass:password123 --key-pass pass:password123 \
  --out DvT-Predictor-Flagship.apk DvT-Predictor-Flagship.apk

# 5. Verify classes.dex unchanged
md5sum <(unzip -p dvt-predictor3.apk classes.dex)
md5sum <(unzip -p DvT-Predictor-Flagship.apk classes.dex)
# MUST BE IDENTICAL
```

## Common Mistakes to Avoid
1. NEVER compile new Java and replace classes.dex
2. NEVER use `apktool b` — it rebuilds the whole APK
3. NEVER use `zip -j` from assets dir — adds files at ROOT not assets/
4. NEVER use `zip -r` from a directory containing the APK — self-references
5. ALWAYS verify MD5 of classes.dex after build matches original

## Package Info
- Package: `com.dvtlive.predictor`
- Activity: `goldaaa.goldaab.goldabc.StartGame`
- Keystore: `keystore/release.keystore` alias=dvtkey pass=password123
- Min SDK: 21, Target SDK: 33

## Working APK Reference
- `dvt-predictor3.apk` — 96KB, 46 files, 49 classes, PROVEN WORKING
- Always start from this as base

## Color Scheme (matches game coins)
- **Dragon (D) = Orange** (#e8963f, #f2a94e, #a35c17, #ffd9a8)
- **Tiger (T) = Blue** (#3b6fc4, #5d96e8, #1d3f7a, #9cc4ff)
- Note: Original CSS had D=Blue, T=Orange — this was WRONG and was swapped to match coins

## When You MUST Modify Native Code (rare)
Use apktool to decompile, edit smali, recompile:
```bash
apktool d dvt-predictor3.apk -o /tmp/dvt-mod -f
# Edit smali files in /tmp/dvt-mod/smali/goldaaa/goldaab/goldabc/
# Edit AndroidManifest.xml for permissions
apktool b /tmp/dvt-mod -o /tmp/dvt-mod.apk
# Then add web assets and sign as usual
```
Current class count: **50** (49 original + ChromeClient)

## Cloudflare
- Account ID: 16500ce6cd8291179f36a136eb801d31
- Worker: dvt-watcher (v3)
- KV: dvt-watcher-kv (3ef3f8b796f647aeb82889d27b6cf4fd)
- Auth: Global API Key (X-Auth-Key + X-Auth-Email)
- Endpoints: /health, /brain, /feed.json, /ingest, /session

## UI Design Philosophy (Phase 4)
- Predict tab is LIVE-ONLY — no manual round buttons
- Manual entry still works via keyboard (D/T/X keys) for testing
- Live status shown prominently at top with color indicator
- Table selector compact in header (AUTO/T1-T4)
- Brain shows "WAITING" until 7 live rounds collected
- Shoe info hidden from user (silent to brain)
- Confidence gauge shown visually
- Streak and D/T ratio shown when available

## Storage Keys
- `dvt.rounds.v2` — rounds (v2, old key `dvt.rounds` had 500 fake rounds)
- `dvt.brainmem` — brain memory (grams2/3/4, recov, methods, sideBalance)
- `dvt.tape` — hit/miss tracking
- `dvt.sim` — money sim state
- `dvt.table` — selected table (auto/table1-4)
- `dvt.liveurl` — live feed URL
- `dvt.play7` — session-only, cleared on restart
Backup saved at Sat Aug 29 13:06:43 UTC 2026
