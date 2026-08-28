# ClipCaption — status summary

Plain-language write-up of what's changed recently and where things stand. Current as of
**2026-08-29**, commit `28d4a36`. Everything below "New since v0.2.10" was built in one long session
after the v0.2.10 draft release described further down — that release note is kept as-is since it's
still an accurate record of what shipped in it, not because it's the latest state.

**2026-08-29 — forced alignment now runs automatically, real measured timing win.** Per the user
flagging the accuracy numbers as not great: found that forced alignment (built earlier, `align.rs`)
was sitting there manual/opt-in only, never applied by default. Tested running it on **whisper's own
transcribed words** (not ground-truth words, a question the existing tests hadn't asked) against the
ground-truth clip: **median word-start timing error drops from 122ms to 64ms**, within-100ms rate
42% → 61%, with **word accuracy unaffected** (alignment only re-times, never re-transcribes) - real
honest tradeoff, the worst-case tail gets fatter (within-250ms 92% → 76%). Verified against both a
Python prototype and the actual Rust `Aligner` (ran `align.rs`'s own existing real-model test for the
first time, not just written and left `#[ignore]`d - passed, worst-case 120ms against ground truth).
Shipped: forced alignment now auto-runs after every transcription, both the single-clip flow and the
batch/watch-folder pipeline, gated on the model already being downloaded so it's never a surprise
download. Full detail and the exact numbers in `CLAUDE-CODE-BRIEF.md`'s 2026-08-29 entry.

**2026-08-29 — 10-clip real-footage test, and a real hallucination bug it caught.** Per the user's
request to test broader than the one ground-truth clip. Only `clip11` has real human-verified ground
truth, so per the user's explicit choice (asked directly rather than guessed), this used **large-v3 as
an independent second model** to cross-check turbo's output on 10 real ~2-minute clips pulled from an
actual recording session (`E:\27-8-2026\`, real proximity-chat gameplay, not synthetic) - honestly
framed as a proxy signal (cross-model agreement, not verified accuracy), not equivalent to clip11's
rigor. Numbers: **82.4% mean cross-model word agreement**, **214ms mean forced-alignment shift**
(9 of 10 clips; see below for the 10th). Full methodology and per-clip numbers in
`CLAUDE-CODE-BRIEF.md`'s 2026-08-29 entry.

**Real bug found, not previously confirmed on actual gameplay audio: whisper.cpp's repetition-loop
hallucination.** One clip (of 10) came back at 37.2% agreement and a 1680ms median alignment shift -
both wildly outside the other nine. Read the actual transcript rather than just the number: turbo
had decoded **"Good evening." fourteen times in a row** over a 30-second span where large-v3 (same
audio) only produced it twice. This is whisper's known repetition-loop failure mode, already flagged
in this file's own "What's still open" list ("collapsing whisper's occasional stuttering repeats...
not done") but never confirmed against real footage before - this is that confirmation, with a
concrete example. Distinguished from a second clip with heavy repetition (`It's just a fucking room`
x4, `I'm in the door!` x3) that both models produced similarly - that one reads as the player
genuinely repeating themselves for comedic emphasis, not a hallucination, and wasn't treated as the
same problem. Not fixed yet - flagging for a decision on approach, since collapsing repeats safely
means telling a hallucination loop apart from real repeated speech, which the two examples above show
isn't always obvious from the repeat count alone.

**2026-08-28 correction — the "New since v0.2.10" list below is missing a whole chunk of already-shipped
work.** Picking this session back up, `CLAUDE-CODE-BRIEF.md`'s "Priority build order" section (montage
builder, tiered auto-apply, death detector, Discord webhook, confidence-gated auto-export) was listed
as **not yet done** — flatly contradicted by commit `0fd3587` ("Add montage builder, Discord webhook
auto-post, experimental death detector"), which is already on this branch, plus `d163267`/`8d5c227`
(tiered auto-cleanup, confidence-gated auto-export) also already shipped. Verified directly against the
code, not just commit messages, before writing this: `src-tauri/src/montage.rs` +
`src/screens/Montage.tsx` (full multi-project montage builder, reachable from the Library screen),
`src-tauri/src/discord.rs` (webhook post, already wired to both single export and montage completion),
`src/lib/deathDetector.ts` (a real but explicitly `EXPERIMENTAL, unvalidated` regex-based transcript
scan — genuinely still needs the refinement/validation Tier 1 calls for, that part of the brief was
accurate). So: **this whole section undercounts what's shipped.** Rather than rewrite it retroactively,
leaving it as-is (matching this file's own stated policy of not rewriting past entries) and correcting
forward from here. Bottom line for whoever reads this next: **trust the actual code and `git log` over
either planning doc's "not yet done" framing** for anything in the priority-build-order or backlog
sections — both docs had drifted out of sync with a chunk of real shipped work, presumably from an
earlier reconciliation gap between concurrent sessions (see CLAUDE.md's note about that happening
before, 2026-08-24). Real, still-outstanding gaps found on this same pass: the montage builder only
pulls from manually-picked `.ccproj` files (no watch-folder/batch auto-hookup, no target-file-size limit
on the final joined output); the death detector is real but unvalidated against any real labeled death
moment. Both are being worked next, see below.

## New since v0.2.10 (this session)

**Two bugs, both re-verified fixed, not just assumed:**
- The exported-video caption-overlap bug (captions stacked with no offset in the export, correct in
  the live preview) — one export path was missing a layout call the other three already had.
- "Load Project is broken" — was never actually broken, just hard to find (it's on the Library/home
  screen). Also added a second, more visible "Open Project…" button directly in the editor's header.

**Everything from the brief's "rest of the backlog" section, per an explicit "build all of it"
instruction — all 13 items, each with real tests or a real functional smoke test against the
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
- **Multi-language caption translation** — same local model translates the transcript into a target
  language, re-timed evenly across each line's original span (a translation has no honest per-word
  mapping to the source audio); fully undoable, same Undo button as any other transcript edit.
  Verified real translation quality against the actual model (Spanish, Korean) and confirmed the
  existing caption fonts already render non-Latin scripts correctly via libass's automatic font
  fallback (Segoe UI → Malgun Gothic for Korean glyphs) - no font-stack changes needed.
- **OBS watch-folder background service** — point it at OBS's recording folder and every new clip
  gets captioned + exported automatically via the existing batch pipeline, no manual step. Per
  CLAUDE.md's Tier 0 framing, this was the single biggest lever left for "runs unattended."

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
- **Case B tested for real, rejected.** sherpa-onnx (already bundled for diarization) ships both a
  Spleeter port and a UVR MDX-NET model with zero new bundling work needed, so both got tested
  directly against the ground-truth clip instead of guessing. Both are fast (RTF 0.03 and 0.21) but
  both measurably DESTROY word accuracy — Spleeter 68.4% → 53.9%, UVR → 50.0% — stripping real
  speech out along with the game noise. Root cause: both are trained on music mixes (studio vocals
  over an instrumental bed), not Discord voice chat with overlapping speakers and non-musical noise
  - a genuine domain mismatch no threshold tweak or model swap (Demucs included) fixes, since all
  three share that same training-domain gap. Not implemented.

See `CLAUDE-CODE-BRIEF.md`'s dated 2026-08-27 entries for the full reasoning and numbers behind each
of the accuracy findings above.

## New, 2026-08-28

**End-of-session Discord digest for watch-folder runs.** The brief's own "bonus, not scoped" idea
("12 clips processed automatically, 3 compiled into tonight's reel, 2 flagged for your review") —
built for real. A watch-folder session that goes quiet for 90s (or is explicitly stopped) posts one
summary to the same Discord webhook already used for auto-post: clip count, a compiled reel of
everything that finished this session (plain concat-demuxer join of the batch's own already-exported
outputs — no re-render, since one batch run always shares one export preset), and how many were
flagged for review or failed. Debounced so a session where clips trickle in one at a time doesn't spam
a message per clip. Deliberately scoped to watch-folder runs only, not manual "Process N clips" runs —
the user is already looking at that queue in the UI, a Discord ping would be redundant. Discord's
`post_to_discord` now takes an optional file path so a run where nothing succeeded can still post a
text-only digest instead of being silently skipped. New toggle in the batch screen, off by default,
only shown once a webhook is configured. Verified: full Rust test suite (79 passing incl. 5 new tests
for the digest/text-only-post logic), `tsc`/`vite build` clean, and the actual concat-demuxer command
run for real against two synthetic clips (confirmed the joined output's duration and both streams are
correct) — not just assumed from montage.rs's existing working code path it's reused from.

**Correction to the 2026-08-27 numbered priority list** — see `CLAUDE-CODE-BRIEF.md`'s 2026-08-28 note:
the montage builder, Discord webhook, tiered auto-apply, confidence-gated auto-export, and the death
detector were already shipped before this session started (commit `0fd3587` and others) — the planning
docs had drifted out of sync with the actual code. Corrected forward rather than rewritten
retroactively; see the note there for what's real vs. what was stale. The montage builder's one real
gap (no watch-folder/batch pipeline hookup) is what "end-of-session digest" above actually closes, just
via a lighter-weight plain concat rather than routing through montage.rs's per-clip re-render pipeline
(unnecessary here — a batch run's outputs are already captioned/exported and share one preset's codec
settings, so there's nothing to re-render). The montage builder's other named gap — target-file-size
limit on the final joined output — is now also closed: each clip still renders at quality (CRF)
independently, but a size cap on the whole joined file runs one more pass through export.rs's existing
2-pass x264/VBV size-target machinery (reused, not reimplemented). Verified with the actual
join-then-2-pass-encode ffmpeg chain run for real against synthetic clips, not just type-checked.

With both named montage-builder gaps closed, the numbered priority list from 2026-08-27 is now fully
resolved.

**Death detector — text-matching precision verified, real audio recall still open.** Couldn't validate
against real labeled death audio (no ground-truth clip with a confirmed death exists), but that's not
the only testable part - the detector's TEXT-matching logic is. Ran an adversarial pass (one-off
harness, not committed - this project keeps verification scripts out of git, same as `scratch_align/`):
22 realistic true-positive death callouts, the 10 already-guarded idiom traps, and 11 newly-suspected
false-positive traps, against the real `DEATH_PATTERNS` list. Found and fixed four genuine gaps:
"I/we/you died laughing" (a very common streaming idiom, unguarded even though "I'm dead serious" was
already excluded the same way), the third-person he's/she's/they're-dead patterns missing that same
idiom-exclusion lookahead entirely, "we lost" being completely unqualified (matched "we lost
connection", "we lost the round" with nobody dying), and "knocked me out" not excluding "...of the
tournament" the way "I'm out of ammo" was already excluded. One limitation left deliberately
unfixed and documented in the code: "we lost her" is genuinely ambiguous (death vs. "lost track of")
without more context than a regex can carry - same treatment as the pre-existing "killed me" note.
Bottom line: precision on realistic phrasing is now verified; real recall against actual noisy game
voice chat is still unmeasured and needs a labeled clip when one exists - not overclaiming "validated"
here, just narrowing what's actually still unknown.

**Decorative sticker text layer — built.** The reference spec from the brief (per-letter rainbow
cycling pink→teal→yellow, cartoon font, off-white sticker box, soft drop shadow, free placement +
rotation, confirmed working on Korean per-character) - a second, opt-in layer alongside the word-synced
dialogue captions, own data/own style system as specified. Checked the brief's own premise first: it
described this as reusing an existing "manual free-placement caption" feature - that feature does not
actually exist anywhere in the codebase (checked thoroughly), so the placement/drag/rotate UI is new,
not a reuse.
- New `Sticker` type (`types.ts`) - text, time range, xPct/yPct position, rotation, size - wired into
  `ProjectFile`, autosave, and undo/redo (all three already generic enough that this was a small,
  low-risk addition, not new infrastructure).
- New `src/lib/stickerAss.ts` - renders each sticker as two ASS Dialogue lines (a vector-drawn rounded
  box on a lower layer, per-letter-colored text on a higher layer, sharing one `\pos`/`\frz` so they
  move and rotate together) appended to the existing dialogue-caption ASS string. Zero Rust changes
  needed - `export.rs` treats the whole `.ass` content as an opaque string already, confirmed by
  reading it before starting rather than assumed.
- New `StickerOverlay.tsx` - live preview, click to select, drag to reposition, a small inline toolbar
  for text/rotation/size, matching what actually gets burned in.
- Wired into the two highest-traffic export paths: the main manual export (`ExportDrawer`/`startExport`,
  correctly re-based when a highlight sub-range is active) and both Auto Reel paths (`compileSelected
  Highlights`'s multi-range join, `exportSelectedHighlights`'s per-highlight export) - each range's
  stickers filtered and time-shifted onto the compiled output's own local timeline, same technique
  already used for caption pages on those same paths. **Deliberately NOT wired into the montage
  builder or the batch/watch-folder pipeline** - montage's `MontageClip` doesn't carry stickers yet
  (no per-clip authoring surface for them there anyway), and batch clips have no editor session to
  place a sticker in. Noted here rather than silently leaving it inconsistent.
- **One honest visual simplification vs. the reference spec**: the box is a flat rounded rectangle,
  not a textured/torn-paper sticker cutout - libass has no bitmap-texture fill, only vector shapes and
  solid colors, so the crosshatch texture and rough edges from the reference aren't achievable through
  ASS alone. Documented in `stickerAss.ts`'s own doc comment, not silently dropped.
- Verified for real, not just type-checked: generated actual ASS content through the real
  `buildStickerAss` function and burned it into a synthetic frame with the actual bundled ffmpeg twice
  (Latin text and Korean) - confirmed the box and text stay correctly centered and rotated together,
  per-letter rainbow renders correctly, drop shadow renders, and Korean falls back to a readable font
  with no missing-glyph boxes. Screenshots reviewed directly, not assumed from the math.
**Razor/multi-select tool on the timeline — built (2026-08-28).** The backlog's last-remaining
timeline-editing gap: multi-select already existed for moving/reassigning a group of words, but there
was no way to force a caption-page split at a chosen point, and no way to delete a multi-selected group
in one action - both were still "one word or line at a time."
- **Razor split**: new `WordSpan.manualBreakAfter` flag, carried on the word itself (survives
  insert/remove/retime/speaker-reassignment-splits for free, since those already pass `WordSpan`
  objects through directly rather than reconstructing them - confirmed by reading `moveWordsToSpeaker`,
  not assumed). One new line in `paginate()`'s existing break-decision loop (`lib/captions.ts`) - a
  manual break always wins over the word-count/gap/sentence-end heuristics, same "explicit beats
  guessed" precedent already used for sentence-end. Press `R` on a tuned word to toggle it (press again
  to undo); shows as a solid cyan divider on the timeline so the cut is visible without opening the
  preview. Real functional test (not just type-checked): confirmed a run of words that would NOT have
  naturally broken (short, no gaps, no punctuation) DOES split exactly where the flag is placed, that a
  break placed on a word that ALSO ends a sentence doesn't double-push an empty page, and that a break
  on the very last word is a harmless no-op.
- **Bulk delete**: new `removeWords(updates)` action, mirroring `moveWordsToSpeaker`'s "one undo step
  for the whole group" batching. Del/Backspace now deletes an entire Ctrl/Cmd+click multi-selection at
  once instead of only working on a single tuned word.
- Researched the actual pagination/selection code before writing anything (confirmed no prior "manual
  break" concept existed anywhere, confirmed the exact selection-state shape to reuse) rather than
  guessing at the design - see the session's own reasoning for why a per-word flag beats a separate
  timestamp list (immune to going stale when words are inserted/removed/retimed nearby).

**Smart auto-reframe ("Auto-track" frame mode) — built (2026-08-28).** The "catching up to competitors"
backlog item: a forced vertical/cropped export used to always hard-center-crop regardless of where the
actual gameplay action was. New third `fitMode` option alongside "fill"/"fit" - motion-tracks the
source and pans the crop window to follow it.
- **Honest about what this is and isn't**: no bundled face/object-detection model exists in this app
  (that's its own real bundling decision, same category as the Case B voice-separation one already
  written up and deliberately not made lightly) - this is classical motion-saliency (frame-to-frame
  grayscale pixel differencing, weighted by horizontal position, exponentially smoothed), not deep
  tracking. Genuinely better than a fixed center-crop for gameplay where the action is off-center, but
  it follows MOTION specifically - a flashing UI element or a moving background can pull it too. Says
  so directly in `reframe.rs`'s own doc comment rather than oversold as face tracking.
- **How it works**: `reframe::analyze_pan` decodes the source at a cheap 80x45/4fps via the bundled
  ffmpeg, computes a smoothed horizontal motion-centroid track; `build_sendcmd_script` turns that into
  an ffmpeg `sendcmd` script driving a named `crop@panner` filter's `x` parameter over time - a real,
  standard ffmpeg technique (verified directly, not assumed from documentation - see below), not
  something hacked together. The crop happens at native resolution, before the final scale to the
  target export size.
- **Verified at every layer, not just type-checked**: (1) the core ffmpeg technique itself - `sendcmd` +
  a named `crop` filter's runtime-commandable `x` - proven for real against a synthetic video with a
  known moving object before writing any Rust, since the whole feature depends on it; (2) the pure
  centroid/smoothing/clamping math - 10 unit tests including left/right/symmetric motion and the
  no-motion/below-floor edge cases; (3) the exact filtergraph string `filter_and_map_args` builds for
  "track" mode - a unit test confirming crop happens before scale and the sendcmd/crop wiring is
  correct; (4) a real end-to-end integration test (`#[ignore]`d for CI the same way `align.rs`'s
  real-model test already is, since the ffmpeg binary is gitignored - run manually here) that builds an
  actual synthetic panning clip through the real bundled ffmpeg and confirms `analyze_pan`'s output
  genuinely tracks the motion left-to-right, not just plausible-looking numbers.
- **Scoped to the single-clip manual export for now** (ExportDrawer), matching how the sticker layer
  above was scoped - not yet wired into montage/batch/reel paths.
- **Follow-up done (2026-08-28): 15 selectable sticker styles.** Per the user's feedback that the
  original rainbow/Comic-Sans look was just a reference, not the spec - `lib/stickerStyles.ts` now
  holds 15 real, distinct presets (Rainbow Pop, Bubble Gum, Neon Glow, Caution Tape, Handwritten Note,
  Retro Stamp, Cyber Glitch, Minimal White, Gold Foil, Warning Block, Kawaii Pastel, Horror Drip, Sports
  Broadcast, Vaporwave, Chalkboard), each varying font/palette/outline/glow/box/shadow/default rotation
  - same shape of decision `STYLE_PRESETS` already made for dialogue captions, not a general-purpose
  picker UI. `stickerAss.ts` and `StickerOverlay.tsx`'s live preview were both refactored to read from
  the chosen style instead of the old hardcoded constants; a small style-swatch picker was added to the
  sticker's inline edit toolbar. **All 15 rendered and checked by eye against the real bundled ffmpeg**,
  not just assumed from the config - two batches of synthetic frames, one style per sticker. Found and
  fixed one real problem this way: "Chalkboard" was designed with a glow effect that turned out to
  wreck legibility against its dark-green box (white-on-dark-green has little contrast margin to lose
  to blur) - glow removed, re-rendered, confirmed legible. Not a hypothetical concern caught by review;
  a real visual bug caught by actually looking at the output. Every style still uses the same box/text
  ASS mechanism the original rainbow look introduced - font-width estimation for the box is still a
  single approximation tuned loosely across all fonts (documented as such), not per-font metrics.

Also per the user: Korean was only ever the smoke-test language for the sticker layer, not an actual
priority - Portuguese, Japanese, and Spanish matter more for real non-Latin/accented coverage going
forward.

**Note on this whole "New, 2026-08-28" section:** `CLAUDE-CODE-BRIEF.md` got reset externally partway
through the day (by the coordinating chat session) back to an earlier state that didn't carry forward
several of the "already done" corrections made earlier in this file - notably, it re-listed the
caption-overlap export bug and Load Project as open/unconfirmed again. Re-investigated both fresh
rather than assuming either this file's own earlier claims or the reset brief's framing - see
`CLAUDE-CODE-BRIEF.md`'s own 2026-08-28 entries for the full detail. Short version: the export bug is
confirmed genuinely fixed with a fresh real functional test today (not just re-reading old notes);
Load Project had one real, concrete gap (an unhandled dialog-rejection that failed completely
silently) found and fixed, but this fix is NOT independently confirmed as the full root cause - GUI
testing is blocked in this coding environment (confirmed twice today: a launched dev-build window
never composites to the screen this environment can see, and swapping the installed release build for
testing was correctly blocked by a safety classifier since it meant modifying an installed app's
binary). Needs a real test on the user's end before being called fully closed.

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
- ~~**Model-size trade-off (large-v3 vs large-v3-turbo)**~~ — resolved 2026-08-29: with forced
  alignment now auto-applied to either model's output, turbo + alignment beats large-v3 + alignment on
  both word accuracy AND timing (the timing gap that was large-v3's whole case is gone once alignment
  handles it for turbo too) — see `CLAUDE-CODE-BRIEF.md`'s 2026-08-29 entry for the numbers. Staying
  on large-v3-turbo, no longer an open decision.
- **Voice/game audio separation, Case B** (single mixed-down recording, via Spleeter) — the biggest
  remaining transcription-accuracy lever, needs a bundled-dependency decision before starting.
- **Multi-select and a "razor" cut tool** on the timeline — currently one word or line at a time.
- Automatically collapsing whisper's occasional stuttering repeats ("go, go, go, go, go") — not
  done; confirmed the AI cleanup pass won't touch these safely, so it needs its own simple check.
- A full mobile/Android version was considered and set aside — the local-AI, multi-process
  architecture doesn't fit that platform well, and going "bigger install, higher quality" (the
  direction chosen for this app) only widens that gap. A lightweight companion app just for
  reviewing already-exported clips on a phone was suggested as the realistic version of this,
  not attempted.

## Current release state

- **v0.2.12 is the current draft release** — includes everything under "New since v0.2.10" above
  plus a CI fix (unauthenticated GitHub API rate limit was failing the release build) and a batch
  of real bugs found by live-testing that build: a misleading "model isn't installed" error that
  was actually a health-check timeout, translation silently processing the whole transcript instead
  of just the active clip (same bug also found and fixed in AI cleanup and forced alignment), a
  serious Auto Reel export deadlock on long source recordings (redesigned the range-compilation
  pipeline — extract each range independently, then concat-join, instead of one filtergraph
  decoding almost the whole source), and the video player's seek bar not scoping to the active clip.
  None of these five fixes have been verified in an actual running build yet, only unit-tested — a
  local build and a real Auto Reel export test against a long recording is owed before pushing this
  as the next draft release, matching how every prior release was verified.
- Source/game-voice separation (Spleeter and UVR, via sherpa-onnx's bundled models) was tested for
  real against ground-truth gameplay audio and rejected — both measurably hurt transcription
  accuracy, trained on music rather than voice-chat audio. Not implemented; see
  `CLAUDE-CODE-BRIEF.md`'s 2026-08-27 entries for the full numbers.
