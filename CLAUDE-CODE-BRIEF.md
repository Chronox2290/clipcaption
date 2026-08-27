# ClipCaption — what to tackle now

Consolidated brief pulling together everything decided across a long planning session — supersedes
the piecemeal messages sent earlier. Organized so the actual priority order is unambiguous.

**2026-08-27 status check, before picking anything up below:** both "Load Project is broken" and the
caption-overlap export bug (both flagged further down as still-open Tier 1 work) were re-verified
against the current code just now and are already fixed — see the dated notes inline where each is
described, rather than re-investigating either from scratch. Full current build status, including
everything shipped from "the rest of the backlog" section below (11 of 13 items, per an explicit
"build everything" instruction), lives in `CLAUDE-CODE-STATUS.md` — check there before assuming
something below is still undone.

## Already in motion — pick these up first

**Forced alignment.** Ground truth was prepared and handed off already: `2026-08-23 22-07-17.mp4`,
40:07–40:52 (Clip #11's overlapping three-person dialogue, extended through the bonus range you
suggested). Project is saved. One wrinkle worth knowing if it wasn't already accounted for: the
correction pass didn't just fix timing — a few missed words got added and a few misheard ones got
retexted. Words with only a timing fix are clean ground truth. Added words have no baseline whisper
timestamp to compare against, so they're only useful for measuring forced alignment's own accuracy,
not the before/after delta. Retexted words may not line up 1:1 by position against whisper's original
output, since the word count in that stretch may have shifted — matching by time position is safer
than matching by list index. If any of this makes the comparison messy enough to not be worth it,
redoing that stretch with timing-only corrections is on the table.

**Word accuracy is a separate target from timing — stipulating this explicitly.** Forced alignment
above only fixes *when* a word appears on screen; it does nothing for whether the word itself is
correct. The actual goal is 99% word-level transcription accuracy, not just clean timing. Worth being
upfront that 99% is a very aggressive bar: the best current open speech-recognition models (Cohere
Transcribe, IBM Granite Speech 4.1, ARK-ASR — all of which have technically overtaken Whisper large-v3
on raw benchmark word-error-rate, though by less than a percentage point) land around 94.6–94.9%
accuracy on *clean, curated* benchmark audio. Real gameplay audio — overlapping voices, background
music and gunfire under speech, slang, people yelling — is a meaningfully harder domain than those
benchmarks. So treat 99% as the direction to push every lever toward, not a number to promise as
guaranteed; the AI cleanup pass is what actually closes the remaining gap to "no manual correction
needed" even where raw transcription alone can't get there. Concrete levers, roughly in order of
effort-to-payoff:
  - **Decoding parameters, cheapest win, no engine change.** whisper.cpp already exposes these:
    temperature 0 instead of the default (more deterministic, a measured 2–5% accuracy gain),
    `best-of` 5 (tries multiple decodes, keeps the best — 3–8% gain), beam size 5, explicit
    `language=en` instead of auto-detect (5–10% gain, and skips accent-related mis-detection), and
    `condition-on-previous-text` enabled for cross-segment context (2–5% gain). These stack and are
    just flag changes, not architecture changes — worth doing first and measuring.
  - **Vocabulary/initial-prompt biasing, expand what's already there.** The `--prompt` support added
    in v0.2.4 is exactly this lever — domain-specific prompting measures at 5–15% accuracy
    improvement for exactly the kind of content this is (proper nouns, technical/game terms). Worth
    checking it's actually being fed real game-specific vocab (ability names, gamertags, common
    slang) by default, not just available as a manual field.
  - **Model size, test before committing.** Current range per the architecture doc is base.en →
    medium. Testing large-v3 or large-v3-turbo (still whisper.cpp, no engine swap) against real
    gameplay ground truth — not assumed — to see whether the accuracy gain is worth the extra
    VRAM/time cost for this specific kind of audio.
  - **Separate the voice-from-game-audio problem into two real cases — they need different
    solutions, and one of them is basically free.**
    - **Case A: the source recording already has separate audio tracks.** OBS supports up to 6
      independent audio tracks in one recording (Advanced output mode, MKV natively supports it,
      MP4 can carry multiple tracks too) — some creators already record mic and desktop/game audio
      onto separate tracks specifically for editing flexibility. For that input, no AI separation is
      needed at all: probe the file for multiple audio streams, let the user pick (or auto-detect,
      e.g. by which stream has more speech-like energy) which one is voice, and feed *that* clean
      track straight to whisper — while still using the full mixed/game track for the highlight and
      death-detection audio scan, which wants all the game sound, not just voice. This is close to a
      pure engineering task (ffmpeg stream selection + a track-picker control), essentially zero
      transcription-quality risk, and worth doing regardless of how common this setup turns out to be
      among users, since it's cheap and only ever helps.
    - **Case B: a single mixed-down recording (game + voice + everything in one track) — this is
      the actual common case, including the primary use case here.** This needs real source
      separation, not just noise suppression: pulling a voice stem out of one mixed file using a
      model built for that (Spleeter or Demucs-family), run as a local preprocessing pass before
      whisper. Checked current options for what's actually practical to bundle in a desktop app
      doing batch preprocessing over potentially hours of footage: **Spleeter is the right choice
      over Demucs/htdemucs here** — it runs roughly 40–90× real-time on GPU and is the only option
      that comfortably beats real-time on CPU alone, versus htdemucs's noticeably better separation
      quality but 30–60 seconds *per 3 minutes* of audio, which compounds badly across a batch of
      clips or a multi-hour session. Spleeter's quality cost (some artifacts, "phasey" vocals
      compared to htdemucs) matters less here than in a music-remix use case, since the thing being
      optimized is whisper's transcription accuracy on the output, not the isolated audio's listening
      quality. Same caution as noise suppression generally: music-under-speech is the hardest case
      for any separation approach, so this needs the same real-audio-measured rigor as the VAD
      rejection before being trusted, not assumed to help.
    - Worth keeping in mind as a possible bonus, not scoping now: once voice is reliably identified
      separately from game audio (either case), auto-ducking the game audio under speech in the
      final export is a small, genuinely useful extension — something editors do manually today.
  - **Don't chase a different ASR engine.** The current open-model leaderboard spread among the top
    ~10 models is under one percentage point on clean benchmarks, and none of them have anything like
    whisper.cpp's mature local C++ tooling, word-timestamp support, or the DTW timing fix already
    built around it. Swapping engines would be a large rewrite for a marginal, unproven-on-real-audio
    gain — push the existing engine harder via the levers above instead.
  - **Measure everything against real audio, not assumption.** The ground-truth clip already prepared
    for forced alignment (`2026-08-23 22-07-17.mp4`, 40:07–40:52) is also real graded ground truth for
    raw word-level accuracy — reuse it to measure before/after on each change above, the same way the
    DTW fix and the VAD rejection were measured rather than assumed.

**Measured against the ground-truth clip, 2026-08-27 — results, in the order laid out above.** Word
accuracy and timing accuracy tracked as two separate numbers throughout, not blended, per instruction.
Baseline for all of these: `large-v3-turbo`, no prompt, whisper.cpp's own default decoding params —
68.4% word accuracy (104/152 ground-truth words text-matched), median word-start error 123ms
(40% within 100ms, 89% within 250ms). Harness: `scratch_align/score_lib.py` (reusable), each
comparison ran whisper-cli directly with the exact flags `transcribe.rs` builds.

- **Decoding parameters — already all in effect, nothing to change.** Checked the real bundled
  whisper-cli's own `--help`, not assumed: `best-of` defaults to 5, `beam-size` defaults to 5,
  `temperature` defaults to 0.00 — none of these need an explicit flag, they're already the CLI's
  status quo. `language=en` is already passed explicitly (`transcribe.rs`, confirmed in code). This
  build has no separate `condition-on-previous-text` toggle at all (checked the full flag list) —
  context-carrying is controlled via `--max-context`, which defaults to -1 (the model's own default
  context, i.e. already carrying). Net: this whole lever was already fully applied before this check:
  a before/after here would be measuring two byte-identical whisper-cli invocations.
- **Vocabulary/prompt biasing — confirmed genuinely unused by default, tested a fix, measured it
  doesn't help on this clip.** Confirmed: the `--prompt` flag is only ever sent when the user manually
  types something into the vocabulary field on the Library screen — nothing auto-populates it, not
  even the player names already saved as `SpeakerProfile`s. Built and tested the obvious fix (feeding
  saved speaker names into the prompt automatically, `"Names and terms you may hear: Christian, Aaron,
  Luke."`) directly against `clip11.wav` with the same flags `transcribe.rs` uses: **word accuracy
  went DOWN, 68.4% → 66.4%** (and the ASR emitted 22 fewer words total, 137 → 115); timing accuracy
  was roughly a wash (median start error 123ms → 116ms, within-250ms unchanged at 89%). Not adopted —
  this ground-truth clip's names were already being transcribed correctly at baseline (nothing here
  for the prompt to fix), so the measured drop is presumably the prompt shifting segment boundaries
  elsewhere, not a name-specific effect; the code was NOT changed. Same "tested, deliberately not
  shipped, written up so nobody re-tries it blind" treatment as the VAD rejection. Worth retesting on
  a clip that actually contains a misheard-name error, if one gets prepared as ground truth later —
  this one just isn't that clip.
- **Model size — turbo already wins on word accuracy; large-v3 wins meaningfully on timing.** The
  current default is already `large-v3-turbo` (confirmed in `store.ts`), not base.en/medium as
  assumed above — that assumption was stale. Ran `large-v3` (non-turbo, also already downloaded
  locally) against the same clip: **word accuracy 63.8% vs turbo's 68.4%** (turbo wins), but
  **timing accuracy meaningfully favors large-v3** — median word-start error 62ms vs turbo's 123ms,
  69% of words within 100ms vs turbo's 40%, end-timing similarly tighter. A real, measured trade-off,
  not a clean win either way: turbo gets more of what's said right, large-v3 times it more precisely
  when it does. Recommend keeping large-v3-turbo as the default (word accuracy matters more for the
  "no manual correction needed" goal than the timing margin here, and forced alignment already exists
  to tighten timing independently of which model produced the words) — flagging as a decision rather
  than changing the default unilaterally, since it's a real trade-off, not a strict improvement.
- **Case A (multi-track OBS audio) — done, shipped this session.** Probes for multiple audio streams,
  lets the user pick the voice track, feeds it straight to whisper while the highlight/death scan
  keeps using the full file. Verified end-to-end against a real synthetic multi-track file (confirmed
  ffprobe's per-audio-stream enumeration matches ffmpeg's `-map 0:a:N` selector exactly).
- **Case B (Spleeter voice separation) — not started, flagging for a decision rather than guessing.**
  This is a materially bigger call than anything else in this list: bundling Spleeter (a
  TensorFlow-based Python tool, or an ONNX/other port of it if one exists and is verified to actually
  work) into a Rust/Tauri desktop app is a new class of dependency this app doesn't have yet — likely
  either a bundled Python runtime or a from-scratch inference port, with real questions about model
  file size, GPU/CPU fallback behavior, and packaging risk similar to what the 2GB cleanup-model
  install already ran into. Given the "cheap" levers above turned out to already be applied or to not
  measurably help on this clip, Case B is the next real lever left — but it's exactly the kind of
  irreversible-ish architectural choice worth confirming before starting, not assuming.

**Export bug, found during the ground-truth work — FIXED (2026-08-27).** Captions overlapped in the
exported video but rendered correctly in the live preview. Confirmed cause: `ExportDrawer.tsx` was
missing the `layoutRows()` call before `buildAss()` that every other export path already had — the
preview and three of four export call sites laid out concurrent same-time pages with a positional
offset; this one didn't, so it fell back to stacking them with none. One-line fix, verified in place
in the current code.

**Load Project — was never actually broken, a discoverability issue.** The user found it themselves
on the Library/home screen and confirmed it works. Also added a second, more visible "📁 Open
Project…" button directly in the Editor's own header this session, so it doesn't rely on going back
to the Library screen at all. Re-verified both entry points and the underlying `loadProject` action
against the current code (2026-08-27) — no bug present.

**Discord webhook size limit — confirmed working as designed, no action needed.** Real test on a
server boosted to Level 2 (50MB limit): an oversized export got rejected by Discord itself with
HTTP 413, and the app correctly surfaced that and pointed at using a Discord-sized preset instead.
The app doesn't hardcode a limit — it attempts the upload and relays Discord's own rejection, which
is the right behavior since the limit depends on the destination server's boost tier. Noting this so
it doesn't get chased as a bug later.

## Priority build order after that

The north star: the whole pipeline — record → find the good moments → transcribe → collate →
share — should need as close to zero manual editing as possible. Manual editing should be the
override you reach for occasionally, not the default path every clip goes through.

1. **A compilation/montage builder.** Doesn't exist yet at all. Stitches the top highlights into one
   shareable reel — the actual missing piece that turns "a folder of individually-captioned clips"
   into "the thing that was wanted," not a nice-to-have layered on later.
2. **Tiered auto-apply for the transcript cleanup pass.** It currently queues every flagged word for
   manual accept/skip, on purpose, as a safety valve. Worth revisiting as tiered: auto-apply the
   cases the model is very confident about and there's really only one sane fix, only queue the
   genuinely ambiguous ones for a human.
3. **A dedicated "death" detector**, separate from the general highlight scan. Death sounds/messages
   are a far more consistent signal across games than general hype detection — a more tractable win
   than trying to make the general scan smarter all at once.
4. **Discord auto-publish via webhook.** Paste a webhook URL into settings, finished clip posts
   straight to the channel automatically. No approval process, no hosting requirement — the easy
   version of "share it," as opposed to Instagram (see below).
5. **Confidence-gated auto-export, once #2 exists.** Take tiered auto-cleanup one step further: a
   clip where every flagged word cleared automatically — nothing needed a human — can skip the
   editor screen entirely and go straight to compiled/exported/shared. Only clips with genuinely
   ambiguous words stop for review. This is the actual "as close to zero manual editing as possible"
   outcome, not just a faster editing screen — worth building as the natural next step after tiered
   cleanup lands, not a separate project.

**Cross-cutting, not a queued item — bake this into all four above as they're built:** the pipeline
is gaining stages (detect → transcribe → clean up → collate → share), and each one needs to fail
loudly and specifically rather than the whole run silently stalling or losing partial work. Worth
treating as a build standard for this list, not a separate backlog line — e.g. "the death detector
timed out on clip 4 of 9, the rest completed" surfaced clearly, versus the run just going quiet.

## The rest of the backlog, for planning purposes

Not to start yet, but worth having the whole shape in view.

**Genuinely new — nobody else in the market does these, checked against Submagic, Captions.ai, Opus
Clip, Veed, CapCut, Descript, and the closest gaming competitor Eklipse (whose "Gameplay
Intelligence" highlight detection — kill-feed events, per-genre tuning, screen-reading to find real
moment boundaries — is the actual technical bar to measure against, not just their marketing copy):**
- Sound-effect captions for accessibility — `[gunshot]`, `[footsteps approaching]` for non-speech
  game audio, not just what's said.
- Multi-POV friend-sync — if a friend also has ClipCaption running during the same session, detect
  the same moment across both recordings and offer a multi-angle cut.
- Local AI title/hook/hashtag generation from the transcript, using the same local model already
  doing cleanup — free and private, unlike competitors' paid cloud metadata add-ons.
- Your-own-voice local dubbing — clone the user's own voice from mic samples, entirely on-device, to
  dub a clip into another language in their own voice rather than a generic TTS voice.
- Transcript-aware clip boundaries — extend a highlight based on what's actually being said ("watch
  this," a callout), not just volume.
- A Discord bot (beyond the webhook) with slash commands — approve/reject AI-suggested highlights or
  rename a speaker from a phone in Discord, while processing stays on the PC. A phone-remote-control
  without a separate mobile app.
- A one-click "demo of the demo" export — an easy shareable before/after (raw vs. captioned +
  compressed) clip, since the product markets itself if it's easy to show off.
- Explainable highlight scoring — a small "why this clip" tag on every auto-detected highlight
  (loudness spike, death detected, manual bookmark) plus a thumbs up/down on each pick, so the
  detector can quietly learn actual per-user preferences over time instead of running one fixed
  heuristic forever. Cheap to add given the scoring already exists internally; compounds in value
  the longer it runs.
- A local phrase dictionary that grows itself — the AI cleanup pass already flags uncertain words
  and lets you correct them one at a time; logging those corrections (a specific game term, a
  friend's name it keeps mishearing) into a small persistent list means the same fix doesn't need
  repeating clip after clip. A natural extension of the cleanup pass already shipped, not new
  infrastructure.
- A nightly/end-of-session digest — if the OBS watch-folder background service (below) happens,
  pair it with a short summary at the end of a session: "12 clips processed automatically, 3
  compiled into tonight's reel, 2 flagged for your review." Makes background automation feel
  visible instead of silent, and could piggyback on the Discord webhook once that exists.

**Reference spec: a decorative text-sticker layer, separate from dialogue captions.** Pulled from an
Instagram Reel a car/cosplay account posted — the styling was interesting, but to be explicit about
scope: this is NOT a request to switch the word-synced dialogue captions to single-word-at-a-time
display. It's a second, opt-in layer for short reaction/decorative text (CapCut-sticker style),
alongside the existing captions, not replacing them. ClipCaption already supports manual caption
insertion; this is the same underlying idea — free placement, own styling — with different
rendering. Visual spec, confirmed across 5 screenshots including two in Korean:
  - Per-letter rainbow coloring: each letter cycles through a fixed 3-color palette
    (pink/magenta → teal/cyan → yellow → repeat) — confirmed pattern, not random.
  - Bold, rounded, cartoon/comic sans-serif — "sticker font" quality.
  - Off-white/cream background box, subtle grid/crosshatch texture, rough/torn edges — physical
    sticker look, not a clean rounded rectangle.
  - Soft drop shadow offset down-right — pasted-on-top feel.
  - Free placement per shot (not locked to bottom-center) and slight rotation on several — looks
    manually positioned, not auto-centered.
  - Applied identically to Korean, per-character — confirms the style isn't Latin-only, but does
    mean whatever font gets picked needs real Hangul/Unicode coverage, not just Latin glyphs.
Real, non-trivial scope: a new render layer, a new style system separate from the caption style
system, and a positioning/rotation UI. Not started — worth designing properly when it's actually
prioritized, not bolted onto the existing caption renderer.

**Multi-language caption support** — the actual want behind the reference above, and worth treating
as its own item distinct from the sticker layer: translating/displaying captions in a language other
than what's spoken. Needs real Unicode font coverage (confirmed via the Korean example) — check
whatever font stack gets used for dialogue captions and any new sticker layer both handle non-Latin
scripts properly, not just an ASCII/Latin-1 fallback.

**Catching up to what competitors already do, still worth doing:**
- Genre-aware highlight tuning (FPS/battle-royale/MOBA/other biasing what counts as a highlight).
- A beat-synced montage option layered onto the compilation builder above.
- Smart auto-reframe to 9:16 that tracks the actual gameplay/face instead of a dumb center-crop —
  confirm current status against the original MVP brainstorm before assuming it's missing.
- A voice isolation pass before transcription, to separate speech from music/gunfire under it.
- A team/org collaboration mode — shared review queue, comments — only if that audience becomes a
  real target; ClipCaption is single-user only today.
- An OBS watch-folder background service — the app runs and captions new recordings automatically,
  no manual open. Biggest lever on making the app something that just runs, not something opened
  occasionally.
- Shareable style presets as plain export/import files, not a walled marketplace (CapCut already runs
  a full monetized template-creator program — this is the honest, smaller-ambition version that fits
  a no-subscription, no-lock-in positioning).
- A thumbnail auto-picker — confirm current status against the original MVP brainstorm.
- Platform safe-zone overlays while editing — confirm current status against the original MVP
  brainstorm.
- A proper razor/multi-select tool on the timeline instead of one word or line at a time.

**Instagram auto-posting** — checked against Meta's actual current API docs, not assumed: requires
the video to already sit at a public URL (a desktop app can't upload raw bytes), a Business/Creator
account, and Meta's app review process for anyone beyond one specific account, which community
reports describe as multi-week with rejections resetting the clock, plus an ongoing 60-day token
refresh per connected account. There's a real shortcut for personal use only — an "Instagram Tester"
mode that skips review entirely — genuinely worth building for the user's own account. Turning it
into a feature for other customers is a materially bigger undertaking (hosting infrastructure that
cuts against the local-first, zero-marginal-cost positioning, plus the review gauntlet) and shouldn't
be scoped as equivalent effort to Discord.

**Steam release** — a distribution move, not a feature. Validated as a real path (Wallpaper
Engine-style one-time-purchase utility distribution); no direct gaming-caption competitor sells
there.

## One open item, not yet decided — don't act on this yet

A rename is on the table — "ClipCaption" tested well below what it could, and a long naming pass
turned up a genuinely strong shortlist (leading candidates: NoScopeCap, Vantavox, 360NoCap). Nothing
has been picked yet. Once it is, the actual work is real: `tauri.conf.json`'s `productName` and
`identifier`, every in-app branding string, the README, installer artifacts, and possibly the GitHub
repo name all need updating together, plus a real trademark/domain check on whichever name is chosen
before committing (this session's vetting was search-engine-based, not a real USPTO/IP Australia
search). Flagged here so it's on the map, not because it's ready to execute.
