# ClipCaption — what to tackle now

Consolidated brief pulling together everything decided across a long planning session — supersedes
the piecemeal messages sent earlier. Organized so the actual priority order is unambiguous.

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

**Export bug, found during the ground-truth work.** Captions overlap each other in the exported
video, but playback inside ClipCaption itself renders them correctly — so the live preview and the
actual burned-in export are disagreeing with each other somewhere. One lead, not confirmed: worth
checking whether the live preview only ever renders a single caption page at a time during playback,
while the `.ass` export draws every page whose time range is currently active. If overlapping-speaker
dialogue now produces pages with genuinely overlapping time ranges (plausible, given the recent work
splitting simultaneous speech into separate lines), the preview could be masking the overlap just by
only ever showing one page at once, while the export correctly — if uglily — shows everything that's
technically active at once, stacked with no positional separation. If that's right, the fix is giving
concurrent pages from different speakers their own vertical/positional offset in both the preview and
the export, not just the editing timeline's lane view. This is a real correctness bug in shipped
behavior — worth weighing against the new-feature list below rather than automatically queuing behind
it.

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

**Catching up to what competitors already do, still worth doing:**
- Genre-aware highlight tuning (FPS/battle-royale/MOBA/other biasing what counts as a highlight).
- A beat-synced montage option layered onto the compilation builder above.
- Smart auto-reframe to 9:16 that tracks the actual gameplay/face instead of a dumb center-crop —
  confirm current status against the original MVP brainstorm before assuming it's missing.
- A voice isolation pass before transcription, to separate speech from music/gunfire under it.
- Multi-language caption translation, not just cleanup of the language spoken.
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
