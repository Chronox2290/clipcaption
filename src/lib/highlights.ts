import type { Highlight } from "../types";

/**
 * Maps each highlight's internal (hype-score-based) rank to its position in
 * chronological order — "the Nth clip in the recording". The backend's
 * `rank` field is a score ranking (1 = most exciting), but the highlight
 * list itself is returned in chronological order, so a plain "#{rank}"
 * badge reads as out-of-order nonsense next to a chronologically-sorted
 * list. This gives every highlight a stable, human-sensible "Clip #" that
 * matches viewing order regardless of how the list is currently sorted.
 */
export function chronoPositions(highlights: Highlight[]): Record<number, number> {
  const byStart = [...highlights].sort((a, b) => a.start - b.start);
  const map: Record<number, number> = {};
  byStart.forEach((h, i) => {
    map[h.rank] = i + 1;
  });
  return map;
}


/** How much footage a highlight actually spans - the user's own trim if
 * they've adjusted one, otherwise the detector's original range. */
function clipDuration(h: Highlight, overrides: Record<number, { start: number; end: number }>): number {
  const r = overrides[h.rank] ?? h;
  return Math.max(0, r.end - r.start);
}

export interface ReelPick {
  ranks: number[];
  totalDurationSec: number;
}

/** Picks highlights for a hands-off "reel" - no manual ticking required.
 *
 * Every hand-marked bookmark is included regardless of budget: a manual
 * bookmark is an explicit "this matters" signal from the person who was
 * there, which is stronger evidence than a loudness score and should never
 * be second-guessed by a duration cap. Remaining time is filled with
 * detected highlights ordered by score (highest first) until the target
 * duration is reached.
 *
 * This only decides WHICH clips make the cut - final playback order stays
 * chronological, same as manual compile already does, since a recap that
 * jumps around in time reads as confusing rather than exciting. */
export function pickReelHighlights(
  highlights: Highlight[],
  clipOverrides: Record<number, { start: number; end: number }>,
  targetDurationSec: number
): ReelPick {
  const manual = highlights.filter((h) => h.manual);
  const detected = [...highlights].filter((h) => !h.manual).sort((a, b) => b.score - a.score);

  const picked: Highlight[] = [...manual];
  let total = manual.reduce((sum, h) => sum + clipDuration(h, clipOverrides), 0);

  for (const h of detected) {
    if (total >= targetDurationSec) break;
    picked.push(h);
    total += clipDuration(h, clipOverrides);
  }

  return { ranks: picked.map((h) => h.rank), totalDurationSec: total };
}
