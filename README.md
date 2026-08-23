# ClipCaption

Local auto-captions + compression for game clips. Drop in an OBS recording, get
TikTok-style animated captions (word-by-word highlight), edit the transcript,
and export with platform presets — including "fit under 10 MB" for Discord.
Everything runs on your PC: no uploads, no subscriptions, no limits.

Built with **Tauri 2 + React + TypeScript**, using **ffmpeg** and
**whisper.cpp** as bundled sidecar binaries.

## One-time Windows setup

1. **Rust** — install from https://rustup.rs (accept defaults; it will also
   prompt to install the Visual Studio C++ Build Tools if you don't have them).
2. **Node.js** — install LTS from https://nodejs.org
3. **WebView2** — already on Windows 11 / updated Windows 10.

Then, in a terminal at the repo root:

```powershell
npm install
powershell -ExecutionPolicy Bypass -File scripts/get-sidecars.ps1   # fetches ffmpeg + whisper-cli
npm run tauri dev
```

The first `tauri dev` compiles the Rust side (a few minutes); after that it's
fast. On first launch, pick a speech model on the home screen and hit
Download (start with **small.en**, ~466 MB — best balance for game audio).

## Building an installer

```powershell
npm run tauri build
```

Output: `src-tauri/target/release/bundle/nsis/ClipCaption_0.1.0_x64-setup.exe`

## How it works

```
clip ─▶ ffprobe (metadata) ─▶ ffmpeg (16 kHz wav) ─▶ whisper.cpp (word timestamps)
     ─▶ edit transcript + pick style in the UI (live CSS caption preview)
     ─▶ export: styles compiled to .ass subtitles ─▶ ffmpeg burn-in
        · quality mode: single-pass CRF
        · target-size mode (Discord): two-pass x264 at computed bitrate
```

Key source files:

- `src/lib/styles.ts` — caption style presets (one definition drives both the
  CSS preview and the ASS export)
- `src/lib/ass.ts` — .ass subtitle builder (karaoke timing + pop animations)
- `src-tauri/src/transcribe.rs` — whisper.cpp runner + word-timestamp parsing
- `src-tauri/src/export.rs` — ffmpeg export pipeline (CRF / two-pass target size)
- `src-tauri/src/models.rs` — Whisper model download manager

## Highlights mode (long VODs)

Open a long recording (e.g. a 2-hour session) and hit **Highlights → Find
highlights**. The whole VOD's audio is scanned locally for excitement (sustained
loudness vs. the local baseline), and the top moments come back as ranked,
ready-to-cut clip windows. From there:

- **Preview** a highlight, or **Use** it to set a working range — transcript and
  export then apply to just that range.
- **Caption + export all** batch-processes every highlight: transcribe the
  window, style captions, cut, burn, save as `<name>_highlight_NN.mp4`.

Only the highlight windows are transcribed, so a 2-hour VOD costs one fast
audio decode pass plus a few minutes of Whisper — not two hours.

## Batch mode (many clips at once)

From the home screen, **Batch process clips**: queue individual files or a whole
folder of OBS recordings, pick a caption style + export preset (including the
full Discord ladder: Free 20 MB, Nitro Basic / Lv2 boost 50 MB, Lv3 boost 100 MB,
Nitro 500 MB), choose where outputs go (next to each original as
`.captioned.mp4`, or one folder), and hit Process. Each clip is transcribed,
captioned in the current style, and exported in turn — failures are reported
per clip and the queue keeps going. Stop anytime after the current clip.

## Encoding options

Both the Export tab and Batch mode share two settings (remembered between runs):

- **Frame rate**: Auto (source fps / preset default), 30, or 60.
- **Encoder**: Auto picks your GPU when one is detected — NVIDIA NVENC, AMD AMF,
  or Intel QuickSync — for much faster exports; CPU (x264) remains the best
  choice for squeezing maximum quality into tight size targets like the Discord
  presets. Detection actually test-encodes a few frames on startup, so only
  encoders that really work on your machine are offered. Size-targeted GPU
  exports are capped with VBV (maxrate/bufsize) to stay under the limit in a
  single pass; x264 keeps its more accurate two-pass mode.

## Roadmap

See the project docs (feature brainstorm + architecture spec): profanity
bleeping, custom game lexicon, auto-reframe 9:16, speaker colors, highlight
detection, watch folder, batch mode, style packs.
