# ClipCaption — status summary

Plain-language write-up of what's changed recently and where things stand. Current as of
**v0.2.10** (commit `6293573`).

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
- **Forced alignment** — a further word-timing upgrade that's been researched and scoped but not
  built, because it needs about 10 minutes of you manually confirming real word timings first so
  any claimed improvement can actually be measured rather than assumed.
- **Multi-select and a "razor" cut tool** on the timeline — currently one word or line at a time.
- Automatically collapsing whisper's occasional stuttering repeats ("go, go, go, go, go") — not
  done; confirmed the AI cleanup pass won't touch these safely, so it needs its own simple check.
- A full mobile/Android version was considered and set aside — the local-AI, multi-process
  architecture doesn't fit that platform well, and going "bigger install, higher quality" (the
  direction chosen for this app) only widens that gap. A lightweight companion app just for
  reviewing already-exported clips on a phone was suggested as the realistic version of this,
  not attempted.

## Current release state

- Latest commit: `6293573` ("Release v0.2.10").
- **v0.2.10 is built and signed, sitting as an unpublished draft GitHub Release** — verified with
  a real local install build, not just a compile check. Waiting on someone to click "Publish."
- **v0.2.9 is the version currently live** — what existing installs would update to today.
