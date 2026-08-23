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
