# ClipCaption — what to tackle now

Consolidated brief pulling together everything decided across a long planning session. Status
updated below by Claude Code after actually building/testing each item — read the status line
first; the paragraph under it is the original context, kept for anyone who needs the "why."

## Already in motion — pick these up first

**✅ DONE — Forced alignment.** Built, validated against the 152-word hand-confirmed ground truth
(`2026-08-23 22-07-17.mp4`, 40:07–40:52), wired end-to-end: model download button, "Align timing"
action in the Transcript tab, undoable. Found and fixed a real regression during validation
(re-running alignment on an already-aligned turn measurably drifted it worse, especially toward the
end) by sweeping the search-window padding against the same ground truth — 0.3s beat the original
0.4s on every metric. The ground-truth wrinkles flagged below (added words vs. retexted words vs.
timing-only fixes) were accounted for in the measurement methodology used.
<details><summary>Original context</summary>

Ground truth was prepared and handed off already. Project is saved. One wrinkle worth knowing if it
wasn't already accounted for: the correction pass didn't just fix timing — a few missed words got
added and a few misheard ones got retexted. Words with only a timing fix are clean ground truth.
Added words have no baseline whisper timestamp to compare against, so they're only useful for
measuring forced alignment's own accuracy, not the before/after delta. Retexted words may not line
up 1:1 by position against whisper's original output, since the word count in that stretch may have
shifted — matching by time position is safer than matching by list index.
</details>

**✅ DONE — Export overlap bug.** Fixed. Root cause was slightly different from the suspected lead:
the live preview was never limited to one page at a time (it already stacked every concurrent
page) — the actual bug was that `pagesAt`/`layoutRows` used the same generous "display fade-out"
grace period to decide whether two pages should be shown/stacked *together*, not just how long a
single page lingers on screen. With today's much shorter, more closely-packed pages, that let a
caption still fading out get shown alongside an unrelated, purely sequential caption that had
already started, so several lines could pile up at once — both in the exported `.ass` burn-in and,
it turned out, in the live preview too once pages got dense enough. Fixed by requiring genuine
[start,end] time overlap between different speakers (a much tighter tolerance) to count as
concurrent, separate from the display-lingering behavior.
<details><summary>Original context</summary>

Captions overlap each other in the exported video, but playback inside ClipCaption itself renders
them correctly — so the live preview and the actual burned-in export are disagreeing with each
other somewhere.
</details>

**✅ RESOLVED (not a bug) — "Load Project is broken."** Investigated - the load path itself works
fine; the button was just only ever on the Library screen, not the Editor (where Save/Save As live),
so it wasn't easy to find while mid-edit. Added a matching "Open Project…" button to the Editor
toolbar for symmetry/discoverability.

**✅ NO ACTION NEEDED — Discord webhook size limit.** Confirmed working as designed via a real test
on a Level 2 boosted server (50MB limit) - an oversized export got HTTP 413 from Discord itself, and
the app surfaced that clearly and pointed at the Discord-sized export presets. Matches the intended
design (no hardcoded limit, since it depends on the destination server's boost tier).

## Priority build order after that

The north star: the whole pipeline — record → find the good moments → transcribe → collate →
share — should need as close to zero manual editing as possible. Manual editing should be the
override you reach for occasionally, not the default path every clip goes through.

1. **✅ DONE — A compilation/montage builder.** Built (new "Build a montage" screen). Pulls highlight
   clips from one or more saved `.ccproj` files, lets you tick/reorder across all of them, and
   stitches the selection into one file. Reuses the existing single-clip export pipeline per clip
   (own trim, own captions, all normalized to one shared resolution/fps) then joins losslessly via
   ffmpeg's concat demuxer, rather than a riskier multi-input filtergraph rewrite. Validated with a
   real two-clip render from an actual source video before considering it done.
2. **✅ ALREADY DONE (pre-dates this brief) — Tiered auto-apply for transcript cleanup.** Checked the
   code directly: this was already built earlier in the same work session that produced this brief -
   the cleanup pass already auto-applies suggestions the model is very confident about and only
   queues genuinely ambiguous ones for manual review. No further work needed.
3. **✅ DONE, EXPERIMENTAL — A dedicated "death" detector.** Built as a transcript-keyword scan (looks
   for phrases like "I died," "got killed," "game over" in what was actually said), badged as a
   separate, opt-in, distinctly-marked pass in the Highlights list - explicitly NOT folded into the
   trusted loudness scan, since it hasn't been validated against real labeled death moments the way
   that one was (no reference footage was available to check false-positive/negative rates). Iterated
   against real false positives during testing ("I'm dead serious," "I'm down for that plan," "I'm
   out of ammo" all initially false-tripped) before landing it.
4. **✅ DONE — Discord auto-publish via webhook.** Built: paste a webhook URL into the Export tab,
   tick "post automatically," a finished export or montage uploads itself. No hardcoded size limit
   (see above).

**Everything in both sections above is now built and shipped in the local build.** Next actionable
step, if wanted: actually exercise montage/Discord-post/death-detector/forced-alignment in the app
and report back anything that doesn't work as expected - none of the four new features have had
real hands-on use yet, only automated/pipeline-level validation.

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
