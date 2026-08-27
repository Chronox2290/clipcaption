# ClipCaption — standing project context

Read this at the start of every session, before picking up work. It doesn't change often; the
specific current task list lives in `CLAUDE-CODE-BRIEF.md` and your own running log is
`CLAUDE-CODE-STATUS.md` — this file is the constitution those two operate under.

## What this product has to be, before anything else

A tool that takes raw or pre-cut gaming footage and hands back finished, captioned, ready-to-post
clips — with essentially perfect captioning and close to zero manual work between "drop footage in"
and "postable content out." That's the whole product. Every feature request, including ones from big
brainstorming sessions, is filtered through whether it serves that directly.

The workflow that actually motivated this project: 4-5 hour recording sessions, OBS replay buffer
manually marking moments live, producing a pile of ~2-minute pre-cut clips — and it was still
painful, even with rough cutting already done. The bottleneck was never really "finding the moment."
It was judging which clips are worth posting, captioning each one by hand, and getting them out the
door. Keep that case front of mind over the more abstract "AI finds the best moments" pitch.

## Priority filter — check this before starting anything not explicitly assigned

**Tier 0 — nothing else matters until this is real:**
- Forced alignment / near-perfect word timing.
- Tiered auto-apply for the AI cleanup pass, and confidence-gated auto-export on top of it, so a
  clean clip never waits on a human.
- Batch/watch-folder ingestion — point the app at a folder of pre-cut clips (or a live watch-folder)
  and get every one transcribed, cleaned, and captioned with no per-clip manual step. This is not a
  minor convenience feature; it's the exact workflow above.
- The compilation/montage builder — turns a folder of finished clips into one actual postable thing.

**Tier 1 — still core, right after Tier 0:**
- Any live correctness bug (check `CLAUDE-CODE-BRIEF.md` for current ones) always outranks new
  feature work, even Tier 0 features — a broken app undermines everything built on top of it.
- Dedicated death/hype detection refinement for the raw-recording (non-batch) path.
- Discord auto-publish via webhook — the natural finish line after a batch run.
- Pipeline resilience/error surfacing as a standard applied across all of the above, not a separate
  feature — a batch job that silently drops or stalls on one clip out of twenty undermines the whole
  "hands-off" premise.

**Tier 2 — real, worth doing eventually, explicitly not now:** decorative caption styles beyond the
core dialogue captions, multi-POV friend-sync, local voice dubbing, a Discord bot with slash
commands, shareable style-preset files, Instagram auto-posting, genre-aware highlight tuning, and
similar. If you find yourself working on something from this tier, stop and check whether Tier 0 is
actually finished first — pull the full list from `CLAUDE-CODE-BRIEF.md` if it's not already there.

**Explicitly out of scope, not just deprioritized:** text-to-video generation. Different product,
different customer, and it competes head-on with the best-funded AI labs in the world rather than
working in the gap they've left alone. Don't propose it as a feature.

## Working conventions

- Treat `CLAUDE-CODE-BRIEF.md` as a living task list, not a one-time handoff: cross off or update
  items as they're completed, and append newly discovered work (bugs found, follow-ups) in the same
  style it's already written in — plain language, honest about what's confirmed vs. suspected.
- Keep `CLAUDE-CODE-STATUS.md` current as your own plain-language build log — what changed, why,
  what's still open. This is read by a non-technical-but-technically-curious collaborator (the repo
  owner) and by a separate cloud session that coordinates planning; both rely on it being accurate
  and current, not just a changelog of commits.
- When two concurrent sessions might touch the same files (this has happened before — see the
  2026-08-24 reconciliation entry in the build log if it exists), prefer coordinating over racing:
  check `CLAUDE-CODE-STATUS.md` for what's currently in flight before starting broad refactors.
- Real correctness bugs always outrank new feature work, regardless of tier.
- This file should stay short. If it's getting long, that's a sign something belongs in
  `CLAUDE-CODE-BRIEF.md` or the build log instead of here.
