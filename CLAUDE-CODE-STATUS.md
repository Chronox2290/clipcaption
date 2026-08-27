# ClipCaption — status summary

Plain-language write-up of what's changed recently and where things stand. Current as of
**2026-08-27**, commit `448f40c`. Everything below "New since v0.2.10" was built in one long session
after the v0.2.10 draft release described further down — that release note is kept as-is since it's
still an accurate record of what shipped in it, not because it's the latest state.

## New since v0.2.10 (this session)

**Two bugs, both re-verified fixed, not just assumed:**
- The exported-video caption-overlap bug (captions stacked with no offset in the export, correct in
  the live preview) — one export path was missing a layout call the other three already had.
- "Load Project is broken" — was never actually broken, just hard to find (it's on the Library/home
  screen). Also added a second, more visible "Open Project…" button directly in the editor's header.

**Everything from the brief's "rest of the backlog" section, per an explicit "build all of it"
instruction — 11 of 13 items, each with real tests or a real functional smoke test against the
actual bundled tools before being called done, not just a type-check:**
- **Confidence-gated auto-export** and **tiered auto-cleanup** — a clip where the AI cleanup pass
  found nothing to flag skips the editor entirely and goes straight to export; one with genuinely
  ambiguous words is held for review instead.
- **Cross-cutting error visibility** — a partial forced-alignment run or a failed batch item now
  says so plainly instead of finishing silently as if nothing went wrong.
- **Local AI title/hook/hashtag generation**, using the same on-device model that already does
  transcript cleanup. Caught and fixed a real bug while testing against the actual model: the
  request shape it was sending would have made every generation silently fail (llama-server rejects
  `logprobs:false` alongside a `top_logprobs` field with an HTTP 400).
- **Explainable highlight scoring** — every auto-detected highlight now shows a plain-language "why"
  tag (e.g. "Sustained hype · loud"), and a thumbs up/down teaches the detector a persisted,
  bucketed bias that nudges future scans toward what you actually keep picking.
- **One-click before/after demo export** — renders the clip raw and captioned side by side into one
  shareable file.
- **Shareable style presets** — export/import a caption look as a plain `.ccstyle` JSON file, no
  marketplace.
- **Genre-aware highlight tuning** — FPS/battle royale/MOBA bias what counts as one highlight and
  how wide its window is (short independent bursts vs. one long escalating event); "General"
  reproduces the exact pre-existing behavior untouched.
- **Self-growing phrase dictionary** — an accepted correction (auto-applied or approved by hand) is
  remembered, so the AI cleanup pass stops re-asking about the same misheard name clip after clip;
  when every flagged word is already known, the model doesn't even need to be running.
- **Transcript-aware highlight boundaries** — a "watch this" setup line or "did you see that"
  reaction just outside a highlight's window now extends it; never trims.
- **Platform safe-zone overlays** — shows where TikTok/Reels/Shorts' own UI sits over a 9:16 export,
  as a preview overlay only.
- **Thumbnail auto-picker** — grabs the frame at a highlight's own loudness-peak moment as a
  one-click thumbnail.
- Not done: **multi-language caption translation**, **OBS watch-folder background service**.

**Transcription accuracy — measured against the real ground-truth clip, tracked as two separate
numbers (word accuracy, timing accuracy), not one blended figure:**
- Decoding parameters (temperature/best-of/beam-size/language pinning) were already all in effect —
  confirmed against the actual bundled whisper-cli's own defaults, not assumed. Nothing to change.
- Tested auto-feeding saved speaker/friend names into the transcription prompt (a real gap: the
  prompt field was 100% manual before this). Measured result on the ground-truth clip: word accuracy
  went DOWN slightly (68.4% → 66.4%). Not adopted — written up so it isn't re-tried blind, same
  treatment as the earlier VAD rejection.
- Tested `large-v3` against the current default `large-v3-turbo`. Turbo wins on word accuracy
  (68.4% vs 63.8%); large-v3 wins meaningfully on timing precision (median word-start error 62ms vs
  123ms). A real trade-off, not a clean win — currently flagged for a decision, default unchanged.
- **Multi-track audio detection shipped** (the "Case A" half of the voice/game-audio split): if a
  recording already has separate mic/game tracks (OBS Advanced output mode), the app now probes for
  them and lets you pick the voice track directly — no AI separation needed. Verified end-to-end
  against a real synthetic multi-track file.
- **Not started: Case B**, real voice/game source separation for a single mixed-down recording
  (the actual common case) via Spleeter. Flagged as needing a decision before starting — it's a much
  bigger bundled-dependency call than anything else on this list, not a quick addition.

See `CLAUDE-CODE-BRIEF.md`'s dated 2026-08-27 entries for the full reasoning and numbers behind each
of the accuracy findings above.

## What ClipCaption is

A Windows desktop app that auto-captions and compresses game clips — built for recording co-op
games with friends over Discord proximity chat. Runs entirely offline: no cloud, no subscription,
your footage never leaves your machine. Under the hood it's a Tauri 2 app (Rust backend, React
frontend) driving five local tools — ffmpeg, whisper.cpp for transcription, sherpa-onnx for
speaker diarization, a small custom tool for voice fingerprinting, and (new) llama.cpp for local
AI transcript cleanup.

## Caption timing — the core accuracy work

The original complaint was that captions sometimes just didn't show a word, even though the
transcript looked right. The cause: whisper's accurate word-timing mode was silently getting
disabled by an unrelated performance setting, so word times fell back to a rough guess — and that
guess occasionally produced a word whose *end* came before its *start*, which can never be drawn
on screen. Fixed at the root, and re-derived word timings so each word properly runs until the
next one starts. Measured on real footage: word timing accuracy went from about 60% to 80%
correct.

Also added: a confidence score per word (how sure whisper was), shown as a wavy underline so you
can jump straight to the words worth double-checking instead of re-watching the whole clip.

**Investigated and deliberately rejected:** voice-activity detection as a further accuracy boost.
It sounded like a good idea but measured *worse* in practice, because whisper doesn't correctly
carry word-level timing through it. Written up so nobody re-tries it blind later.

## Multiple people talking at once (proximity chat)

This was the single biggest gap. When two people spoke over each other, the app used to lump both
voices into one caption, credited to whichever person "won." Now speech is split up per speaker
before captions are built, so overlapping conversations show as separate lines in separate
speaker colours, on separate rows of the timeline, instead of one garbled line.

Speaker *detection* is still the weakest link. Left to guess on its own, it once split three real
people into six different "speakers." You can now tell it how many people are in a recording,
which fixes the count — but it can still occasionally flip who's talking mid-conversation. This is
the top item worth improving next.

Also looked into using the game's on-screen player list (the bit that highlights whoever's
talking) as a shortcut for speaker detection. Turned out that highlight actually means "alive and
in range," not "currently speaking," so it isn't reliable enough to use directly — noted for
later, not implemented.

## New: offline AI transcript cleanup

An entirely optional local AI pass that catches misheard names and words — the "Chris and" /
"Christian" kind of mistake. It's a small AI model that runs completely on your PC, reviews only
the words the transcript itself flagged as uncertain (see above), and suggests a fix for each one
individually rather than rewriting anything wholesale. Nothing is ever changed automatically —
every suggestion shows up in a review list for you to accept or skip.

Getting this working safely took real testing: the first version tried to have the AI fix a whole
transcript at once and it made things up. Scaling it down to "one uncertain word, shown with its
sentence for context" fixed that, and — importantly — it now correctly says "I don't know" on
truly unclear audio instead of guessing something plausible-sounding and wrong.

Two packaging problems also turned up only when actually building an installer (not just checking
the code compiles), and both are fixed:
- The AI model is about 2GB, and the Windows installer builder chokes on bundling a single file
  that large. Fixed by downloading the model after install instead of packaging it — the same way
  the largest transcription model already works.
- A configuration mistake would have made the AI tool quietly load the wrong support files on
  some machines (a subtle Windows DLL conflict). Caught by building the real installer twice and
  checking exactly where every file landed, not by assuming the config was right.

## Highlight detection

Previously capped at 12 clips no matter how long the recording was, which is why a 2-hour session
only ever produced 11 highlights. Now scales with video length automatically (roughly one
candidate per 4 minutes, with sensible floor/ceiling), and you can override the count directly if
you want more or fewer.

## Manual bookmarks

You can now mark a moment yourself instead of relying only on the automatic loudness-based
scan — useful for a good line that wasn't loud enough to get picked up automatically. Bookmarked
clips are flagged so they survive a re-scan instead of being wiped out by it.

## Project persistence

Work now autosaves per video as you go, and reopening a video restores it — so navigating back to
the library and returning no longer loses your transcript, clip selections, or style tweaks.
Saved `.ccproj` project files still work as before for explicit save/share.

## Editing workspace

The timeline used to be a thin strip squeezed next to a fixed sidebar. It's now a proper
multi-track editor: full window width, one row per speaker (colour-matched to the captions),
resizable panels, drag a word to retime it, drag it vertically onto another speaker's row to
reassign it, keyboard shortcuts for frame-accurate nudging, and full undo/redo.

## What's still open

- **Speaker accuracy** beyond just setting the headcount — the top remaining correctness issue.
- **Forced alignment is now built** (this note was stale — see the dated 2026-08-27 entries in
  `CLAUDE-CODE-BRIEF.md` for the real measured word-timing numbers against the ground-truth clip).
- **Model-size trade-off (large-v3 vs large-v3-turbo)** — measured, not yet decided; see "New since
  v0.2.10" above.
- **Voice/game audio separation, Case B** (single mixed-down recording, via Spleeter) — the biggest
  remaining transcription-accuracy lever, needs a bundled-dependency decision before starting.
- **Batch/watch-folder ingestion as a true background service** — batch processing of a folder
  exists; the "runs unattended, watches for new files with no manual step" version does not yet.
- **Multi-language caption translation** — not started.
- **Multi-select and a "razor" cut tool** on the timeline — currently one word or line at a time.
- Automatically collapsing whisper's occasional stuttering repeats ("go, go, go, go, go") — not
  done; confirmed the AI cleanup pass won't touch these safely, so it needs its own simple check.
- A full mobile/Android version was considered and set aside — the local-AI, multi-process
  architecture doesn't fit that platform well, and going "bigger install, higher quality" (the
  direction chosen for this app) only widens that gap. A lightweight companion app just for
  reviewing already-exported clips on a phone was suggested as the realistic version of this,
  not attempted.

## Current release state

- The app version manifest is still pinned at 0.2.10 — none of "New since v0.2.10" above has been
  built into an installer or tagged as a release yet. A real local install build (not just a compile
  check) is still owed before any of this ships, matching how every prior release was verified.
- **v0.2.9 is the version currently live** — what existing installs would update to today.
