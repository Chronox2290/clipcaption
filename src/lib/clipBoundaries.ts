import type { Segment } from "../types";

/** Extends a highlight's start/end using what's actually being said near its
 * edges, not just the loudness scan's own window - "watch this" right
 * before something happens, or "did you see that" right after, are real
 * signal a volume-only scan can't see (see the brief's own framing: "extend
 * a highlight based on what's actually being said... not just volume").
 *
 * Only ever WIDENS a range, never trims it - a wrong extension costs a
 * couple of harmless extra seconds of lead-in/reaction; a wrong trim could
 * cut off the actual moment. Same phrase-list shape as deathDetector.ts
 * (regex over a segment's joined text), same "experimental, not validated
 * against labeled ground truth" caveat - there was no reference footage
 * with confirmed callout/reaction timestamps to measure against when this
 * was built.
 */
const SETUP_PATTERNS: RegExp[] = [
  /\bwatch this\b/i,
  /\bcheck this out\b/i,
  /\blook at this\b/i,
  /\bwait for it\b/i,
  /\bhere it comes\b/i,
  /\bthis is (going to be|gonna be) (so )?(good|insane|crazy)\b/i,
  /\byou'?re not going to believe this\b/i,
  /\bwatch watch watch\b/i,
  /\bready\?? here we go\b/i,
];

const REACTION_PATTERNS: RegExp[] = [
  /\bdid you see that\b/i,
  /\bdid that just happen\b/i,
  /\b(that|this) was (insane|crazy|nuts|sick|unreal|incredible|unbelievable)\b/i,
  /\bno way\b/i,
  /\boh my god\b/i,
  /\blet'?s goo*\b/i,
  /\b(holy|what the) (shit|crap|hell)\b/i,
  /\bclip that\b/i,
  /\bclip it\b/i,
];

/** How far outside the current window to look for a setup/reaction line -
 * far enough to catch a sentence just before/after the loud part, not so
 * far it starts pulling in unrelated banter from minutes away. */
const SETUP_LOOKBACK_SEC = 8;
const REACTION_LOOKAHEAD_SEC = 6;

export interface ExtendedBounds {
  start: number;
  end: number;
  extendedBefore: boolean;
  extendedAfter: boolean;
}

export function extendHighlightBounds(
  range: { start: number; end: number },
  segments: Segment[],
  durationSec: number
): ExtendedBounds {
  let start = range.start;
  let end = range.end;
  let extendedBefore = false;
  let extendedAfter = false;

  for (const seg of segments) {
    if (seg.words.length === 0) continue;
    const segStart = seg.words[0].start;
    const segEnd = seg.words[seg.words.length - 1].end;
    const text = seg.words.map((w) => w.text).join(" ");

    // A setup line just before the window - pull the start back to include it.
    if (segEnd <= range.start && range.start - segEnd <= SETUP_LOOKBACK_SEC) {
      if (SETUP_PATTERNS.some((re) => re.test(text))) {
        start = Math.min(start, segStart);
        extendedBefore = true;
      }
    }
    // A reaction line just after the window - push the end out to include it.
    if (segStart >= range.end && segStart - range.end <= REACTION_LOOKAHEAD_SEC) {
      if (REACTION_PATTERNS.some((re) => re.test(text))) {
        end = Math.max(end, segEnd);
        extendedAfter = true;
      }
    }
  }

  return {
    start: Math.max(0, start),
    end: Math.min(durationSec, end),
    extendedBefore,
    extendedAfter,
  };
}
