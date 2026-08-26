import type { Highlight, Segment } from "../types";

/** EXPERIMENTAL, unvalidated: scans the transcript for phrases people
 * commonly say right after dying in a game, across genres (not any one
 * game's specific death message - this reads what was actually SAID, not
 * on-screen UI text, since ClipCaption has no screen-reading capability).
 *
 * Deliberately not validated against real labeled death moments the way the
 * loudness-based highlight scan (analyze.rs) was - there was no reference
 * footage of a confirmed death to measure false-positive/negative rates
 * against when this was built. Ship it as a clearly-separate, opt-in,
 * distinctly-badged pass rather than blend it into the trusted scan.
 *
 * Deliberately keyword/phrase-based rather than single-word ("dead", "die")
 * matching: bare words like that are common in totally unrelated banter
 * ("dead serious", "I'm dying laughing") and would flood the list with
 * false positives. Every pattern here needs the SPEAKER to be describing
 * their own or a teammate's death, not using the word figuratively.
 */
const DEATH_PATTERNS: RegExp[] = [
  // Negative lookaheads exclude the specific idioms real playtesting against
  // realistic sentences caught as false positives - "dead serious", "I'm
  // down for it" (agreeing to something), "I'm out of ammo" are all common
  // in game voice chat and have nothing to do with dying.
  /\bi'?m dead\b(?!\s*(serious|ass|on|wrong))/i,
  /\bi died\b/i,
  /\bwe died\b/i,
  /\byou died\b/i,
  /\bhe'?s dead\b/i,
  /\bshe'?s dead\b/i,
  /\bthey'?re dead\b/i,
  /\bi got killed\b/i,
  /\byou killed me\b/i,
  // "that killed me"/"you killed me" for something FUNNY is a real, known
  // false-positive source this can't fully tell apart from a real death
  // report without more context than a regex can carry - accepted
  // limitation of a keyword pass, not something a longer pattern list fixes.
  /\bkilled me\b/i,
  /\bi'?m downed\b/i,
  /\bi got downed\b/i,
  /\bi'?m down\b(?!\s*(for|to|with|whenever))/i,
  /\bgame over\b/i,
  /\brespawning\b/i,
  /\bi respawned\b/i,
  /\bthere goes my (streak|life)\b/i,
  /\bwe lost\b/i,
  /\bi'?m out\b(?!\s*of)/i,
  /\bknocked me out\b/i,
  /\bi got wiped\b/i,
  /\bwe wiped\b/i,
];

/** Seconds of context to include before/after the phrase itself - a death
 * reaction is usually the END of the interesting moment, not the start, so
 * this leans backward to catch the run-up. */
const PRE_ROLL_SEC = 6;
const POST_ROLL_SEC = 4;

/** Ranks assigned here start well above any realistic loudness-scan or
 * manual-bookmark rank so they never collide when merged into the same
 * highlights list - chronoPositions (highlights.ts) only cares about each
 * highlight's own start time, not the magnitude of its rank number. */
const RANK_BASE = 100_000;

export function findDeathMoments(segments: Segment[]): Highlight[] {
  const moments: Highlight[] = [];
  let rank = RANK_BASE;
  for (const seg of segments) {
    if (seg.words.length === 0) continue;
    const text = seg.words.map((w) => w.text).join(" ");
    const matched = DEATH_PATTERNS.some((re) => re.test(text));
    if (!matched) continue;
    const start = seg.words[0].start;
    const end = seg.words[seg.words.length - 1].end;
    moments.push({
      start: Math.max(0, start - PRE_ROLL_SEC),
      end: end + POST_ROLL_SEC,
      peak: start,
      score: 0, // no loudness measurement behind this - not comparable to a real score
      rank: rank++,
      death: true,
    });
  }
  return mergeOverlapping(moments);
}

/** Two death phrases seconds apart (e.g. "I'm down... I'm dead") would
 * otherwise produce two heavily-overlapping clips - merge any whose padded
 * ranges touch into one, keeping the earliest start / latest end. */
function mergeOverlapping(moments: Highlight[]): Highlight[] {
  const sorted = [...moments].sort((a, b) => a.start - b.start);
  const out: Highlight[] = [];
  for (const m of sorted) {
    const last = out[out.length - 1];
    if (last && m.start <= last.end) {
      last.end = Math.max(last.end, m.end);
    } else {
      out.push({ ...m });
    }
  }
  return out;
}
