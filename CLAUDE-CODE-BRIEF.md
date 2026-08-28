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

**Decoding parameters — re-measured fresh 2026-08-28, checkpoint per the user's request before
touching anything more invasive.** Ran the actual bundled `whisper-cli` against the ground-truth clip
today, using the exact flags `transcribe.rs` currently builds (`large-v3-turbo`, `-l en`, `-dtw
large.v3.turbo`, `-nfa`, no explicit temperature/best-of/beam-size flags) - not a cached number, a
fresh run through the real harness (`scratch_align/score_lib.py`) this session. Result, tracked as two
separate numbers as asked:
  - **Word accuracy: 68.4%** (104/152 ground-truth words text-matched, 137 words emitted).
  - **Timing accuracy: median word-start error 123ms** (40% within 100ms, 89% within 250ms; word-end
    error runs looser - median 153ms, 73% within 250ms - words tend to get cut short more than they
    start late).
  - **Confirmed the decoding-parameter lever has nothing left to pull, checked against the actual
    binary's own `--help` today, not assumed:** `best-of` defaults to 5, `beam-size` defaults to 5,
    `temperature` defaults to 0.00, `max-context` defaults to -1 (already carrying full context) - all
    already whisper-cli's own out-of-the-box defaults, and `language=en` is already passed explicitly
    in code. Running "with decoding params" vs. "without" would be two byte-identical invocations. This
    matches the exact same conclusion an earlier pass reached (recorded before this file got reset) -
    re-verified today rather than just trusted from a stale note, and it still holds: **before and
    after are the same number, because there was nothing to change.**
  - **Stopping here per instruction** - not proceeding to vocabulary/prompt biasing, model size, or
    voice separation without a go-ahead. Reported to the user; awaiting direction.

**2026-08-29, per the user's go-ahead ("those numbers don't seem great") — found and shipped a real
timing win that doesn't touch decoding params, model size, or voice separation at all.** Forced
alignment (`align.rs`) already existed but was manual/opt-in only - the default pipeline's timing was
whisper's own DTW timestamps even though a meaningfully better option was one click away and unused
by default. Tested something the existing align.rs tests hadn't asked: run forced alignment on
**whisper's own transcribed words** (not ground-truth words) and see if it improves whisper's own
timing. Measured on the ground-truth clip (both numbers on the same 124-word "whisper-attributable"
denominator, so directly comparable):
  - **Median word-start error: 122ms → 64ms** (whisper's raw DTW vs. forced-aligned on whisper's own
    words). Within-100ms rate: 42% → 61%.
  - **Word accuracy: unaffected** (81.5% → 79.8%, the ~2pt difference is a couple of extra outlier
    pairs rejected by the >1s sanity-gap check, not fewer words recognized - alignment only re-times,
    never re-transcribes).
  - **Honest tradeoff, not a strictly free win:** the tail gets fatter - within-250ms 92% → 76%, worst
    case 1112ms → 1756ms. Trades typical-case precision for a heavier tail. Worth knowing if timing on
    the occasional outlier word matters more than the median for how this gets used.
  - Verified two ways: a Python prototype of the same algorithm, AND `align.rs`'s own existing (already
    written, previously never actually run) real-model test, executed for real against the ground-truth
    clip today - the real Rust `Aligner`, not just the Python port, confirmed accurate (worst-case
    120ms against ground-truth words, well under its own 350ms tolerance).
  - **Shipped**: forced alignment now runs automatically after every transcription (single-clip and the
    batch/watch-folder pipeline both), gated on the wav2vec2 model already being downloaded - never a
    surprise download. The manual Align button is unchanged for first-time discovery/re-running after
    edits.
  - **Model-size question below (large-v3 vs. turbo) — re-measured same day, now resolved.** The old
    trade-off (turbo wins word accuracy, large-v3 wins timing) was exactly why it was left as an open
    decision. Ran large-v3 through the same forced-alignment pass and compared, same 124-word
    denominator as everything above:
      - large-v3 raw DTW: 70.2% word accuracy (87/124) - turbo's raw 81.5% already wins by a lot.
      - large-v3 + forced-alignment: 68.5% word accuracy, 67ms median start error.
      - turbo + forced-alignment (shipped default): 79.8% word accuracy, 64ms median start error.
    **Turbo + forced-alignment wins on BOTH axes now** - once alignment handles timing precision for
    either model about equally well (64ms vs. 67ms, basically a wash), the only thing still separating
    them is word accuracy, and turbo simply transcribes more correctly. The entire reason to consider
    large-v3 was its timing edge; forced alignment already delivers that same timing for turbo, so
    there's no remaining case for switching. **Decision: keep large-v3-turbo as the default (already
    is) - closing this out, not leaving it open any longer.**
  - **Still open, smaller and lower-priority:** vocabulary/prompt biasing was tested and rejected on
    this specific clip (see below) but not retested on a clip with an actual misheard-name error,
    which is the case it's meant for - would need a different ground-truth clip prepared to test
    properly, not a quick re-run of what exists.

**Export bug — investigated 2026-08-28, confirmed already fixed, with fresh real proof.** The lead in
the paragraph this replaced was exactly right: `layoutRows()` (the function that assigns each caption
page a `row` so concurrent pages from different speakers get their own vertical offset) needed to run
before `buildAss()`, and one export path — `ExportDrawer.tsx`'s manual Export button — was calling
`buildAss()` directly on `paginate()`'s raw output, skipping it. That's `layoutRows`'s own job:
without a `row`, `buildAss`'s offset branch never fires and every page renders at the same y position.
Already fixed (commit `4d0625c`, 2026-08-26) and grep-confirmed today that all eight places in the
codebase that build ASS content (single export, both highlight-export paths, montage, batch, the duo/
demo export) now call `layoutRows()` first — not just that one path. Beyond the grep, built and ran a
real functional test today against the actual `paginate`/`layoutRows`/`buildAss` functions: two
segments with genuinely overlapping time ranges (0.0–1.8s and 0.5–2.3s, different speakers) produce
Dialogue lines at two different `\pos` y-coordinates (1334 vs 1459) in the real generated ASS output —
not assumed from the code, read directly off what the functions actually produce. Considering this
closed unless new overlap reports come in from a scenario not covered above.

**Load Project — investigated 2026-08-28, one real gap found and fixed, but NOT independently
verified working end-to-end.** Traced the full round trip: `write_text_file`/`read_text_file` (Rust)
are symmetric plain `std::fs` calls; the dialog plugin's actual default permission set (checked the
`tauri-plugin-dialog` crate source directly, not assumed) grants `allow-open` and `allow-save`
equally; both the Library screen's and the Editor header's buttons wire to the same `loadProject`
action with no disabling condition. The one concrete asymmetry found: `pickProjectOpenPath()` (and
`pickProjectSavePath()`) were called *outside* their action's try/catch — if the dialog call itself
ever rejects rather than cleanly resolving to null on cancel, that was an unhandled promise rejection:
no error banner, no state change, the button just silently "did nothing," which matches the reported
symptom exactly. Fixed (commit `9d76841`) so any such failure now at minimum surfaces an error
instead of vanishing. **Not confirmed as THE root cause via live reproduction** — GUI testing is
blocked in this coding environment (a launched dev build's window exists but never composites to the
screen this environment can actually see or interact with; swapping it into the installed release
build to test through a window that *does* composite was blocked by a safety classifier, reasonably,
since that meant modifying an installed app's binary). **Needs a real test on your end**: pull this
commit, try Load Project again, and if it still doesn't work, say exactly what you see now — does a
file picker even open, does picking a `.ccproj` show a new error message, does it still do nothing at
all — so whichever of those it is can be chased precisely instead of guessed at blind.

**Discord webhook size limit — confirmed working as designed, no action needed.** Real test on a
server boosted to Level 2 (50MB limit): an oversized export got rejected by Discord itself with
HTTP 413, and the app correctly surfaced that and pointed at using a Discord-sized preset instead.
The app doesn't hardcode a limit — it attempts the upload and relays Discord's own rejection, which
is the right behavior since the limit depends on the destination server's boost tier. Noting this so
it doesn't get chased as a bug later.

## 2026-08-29: 10-clip real-footage test (word + timing accuracy, broader than one ground-truth clip)

Only `clip11` has real human-verified ground truth (the painstaking correction pass this whole
session's numbers are built on). Asked the user directly how to handle the other 9 rather than
guessing or fabricating ground truth: chosen approach was **large-v3 as an independent second model**,
cross-checking turbo's output - explicitly a proxy signal, not equivalent rigor to clip11's real
ground truth, and reported as such throughout.

**Source material**: 10 real clips pulled from an actual recording session on disk
(`E:\27-8-2026\Replay *.mp4`, real proximity-chat gameplay - the exact workflow this app is built
for), mostly ~2-minute clips matching the "pile of pre-cut clips" case CLAUDE.md describes, a couple
shorter. Ran the *exact* real pipeline: same ffmpeg audio-extraction filter chain `transcribe.rs`
uses (`highpass=f=80,dynaudnorm=f=150:g=15:p=0.9`, 16kHz mono), same whisper-cli flags, turbo as the
shipped default plus large-v3 as the cross-check, then forced alignment (the new default, see above)
on turbo's own output.

**Results, two signals per clip:**
- **Cross-model word agreement** (turbo vs. large-v3, text-matched via the same difflib technique
  used against real ground truth all session): mean 82.4%, median 86.7%, range 58.0%-100.0% across 9
  of the 10 clips (10th excluded from this average - see the hallucination finding below, it's not a
  representative "typical accuracy" data point).
- **Forced-alignment shift** (how far alignment moves each of turbo's own words from its raw DTW
  timestamp - a consistency signal, not an accuracy number, since there's no ground truth here to
  compare against): mean 214ms, median 180ms, range 120-520ms across the same 9 clips. Roughly
  consistent with the correction magnitude already measured against real ground truth on clip11 (122ms
  raw error → 64ms aligned).
- Full per-clip numbers: `scratch_align/analyze_10clip.py` (kept, gitignored like the rest of
  `scratch_align/`) reproduces this against the same 10 source files if rerun.

**Real bug found, not a measurement artifact - confirmed whisper.cpp's repetition-loop hallucination
happens on real gameplay audio.** One clip came back at 37.2% agreement and a 1680ms median shift, both
wildly outside the other nine - read the actual transcript rather than trusting the outlier number:
turbo decoded **"Good evening." fourteen times in a row** over 30 seconds of audio where large-v3 (same
audio) only produced it twice. This is whisper's known stuttering-repeat failure mode, already named as
an unfixed gap in `CLAUDE-CODE-STATUS.md`'s "What's still open" list, but never confirmed against real
footage before now. Deliberately checked this wasn't just flagging genuine repeated speech: a *different*
clip had real heavy repetition ("It's just a fucking room" x4, "I'm in the door!" x3) that both models
produced similarly - read as the player actually repeating themselves for comedic emphasis, not
hallucination, and NOT counted as the same problem. The two side by side show why a fix here can't be
"collapse any 3+ repeat" - that would eat real intentional repetition along with the hallucinated kind.
**Not fixed yet - this needs a decision on approach before building anything**, flagged here rather than
guessed at.

## Priority build order after that

**2026-08-29: re-verified fresh against the actual current code (not the docs, not memory) — all
four items below are genuinely done, in real code, right now.** Grepped for each one's real
implementation rather than trusting an earlier claim: `AUTO_APPLY_CONFIDENCE`/tiered auto-apply
splitting logic (#2) is live in both the single-clip and batch flows, `needs_review` confidence-gating
(#5) holds ambiguous batch items back from export, `watchfolder.rs` (164 lines) and `montage.rs` (296
lines, grown today with the digest-hookup and size-limit work) both exist and compile clean. Tier 0 is
complete. Tier 1's own items (real correctness bugs, death-detector refinement, Discord webhook,
pipeline resilience) are also all done - see `CLAUDE-CODE-STATUS.md`. What's left in the backlog below
is genuinely blocked on real-world access (a Discord bot token, a second device, a bundled-model
decision, real API credentials) - see this file's own "blocked on real-world access" note further
down, not a to-do list still waiting on more code.

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
- ~~A team/org collaboration mode~~ — cut, not just deprioritized. Decided against: this app is a
  solo/small-creator tool, and a shared review queue serves an esports-org audience that isn't the
  target. Leave single-user as the permanent shape unless that changes for a real, specific reason.
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

**Instagram auto-posting — decided down to a small maybe, not a product feature.** Checked against
Meta's actual current API docs, not assumed: requires the video to already sit at a public URL (a
desktop app can't upload raw bytes), a Business/Creator account, and Meta's app review process for
anyone beyond one specific account, which community reports describe as multi-week with rejections
resetting the clock, plus an ongoing 60-day token refresh per connected account. ~~Building this out
as a real feature for other customers~~ is cut, not just deprioritized — the hosting infrastructure it
needs cuts directly against the local-first, zero-marginal-cost positioning that's the whole point of
this app, and the review gauntlet isn't worth it for a feature that isn't core to the mission. The
one thing still genuinely worth keeping in mind, small and low-effort: an "Instagram Tester" mode
that skips review entirely, for the repo owner's own account only, if it's ever wanted personally —
not something to build as customer-facing.

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
