import type { Highlight, Segment } from "../types";

/** EXPERIMENTAL: scans the transcript for phrases people commonly say right
 * after dying in a game, across genres (not any one game's specific death
 * message - this reads what was actually SAID, not on-screen UI text, since
 * ClipCaption has no screen-reading capability).
 *
 * Still not validated against real labeled death moments the way the
 * loudness-based highlight scan (analyze.rs) was - there's no reference
 * footage of a confirmed death to measure recall against yet. What HAS been
 * done (2026-08-28): a text-only adversarial verification pass, since that
 * part doesn't need audio - a curated set of realistic true-positive death
 * callouts and known figurative traps, run against these patterns directly
 * (see the project's scratchpad for the harness). That pass found and fixed
 * four real gaps: "died laughing" (a very common streaming idiom - added an
 * exclusion to i/we/you died, matching the treatment i'm-dead already had),
 * the third-person he's/she's/they're-dead patterns missing the same
 * idiom-exclusion lookahead i'm-dead already had ("he's dead on with his
 * aim" was false-positiving), "we lost" being unqualified (matched "we lost
 * connection"/"we lost the round" with no death involved), and "knocked me
 * out" not excluding "...of the tournament" (competitive elimination
 * language, not literal unconsciousness - same "out of" treatment the
 * i'm-out pattern already had). Ship it as a clearly-separate, opt-in,
 * distinctly-badged pass rather than blend it into the trusted scan - real
 * recall against actual gameplay audio is still an open question.
 *
 * Deliberately keyword/phrase-based rather than single-word ("dead", "die")
 * matching: bare words like that are common in totally unrelated banter
 * ("dead serious", "I'm dying laughing") and would flood the list with
 * false positives. Every pattern here needs the SPEAKER to be describing
 * their own or a teammate's death, not using the word figuratively.
 */
export const DEATH_PATTERNS: RegExp[] = [
  // Negative lookaheads exclude the specific idioms real playtesting against
  // realistic sentences caught as false positives - "dead serious", "I'm
  // down for it" (agreeing to something), "I'm out of ammo" are all common
  // in game voice chat and have nothing to do with dying.
  /\bi'?m dead\b(?!\s*(serious|ass|on|wrong))/i,
  /\bi died\b(?!\s*laughing)/i,
  /\bwe died\b(?!\s*laughing)/i,
  /\byou died\b(?!\s*laughing)/i,
  // No "on" exclusion here unlike i'm-dead above: "I'm dead on [target]" is a
  // real first-person agreement idiom, but "he's/she's/they're dead ON..." is
  // not an established third-person idiom the same way - it's much more
  // likely a literal callout ("she's dead on arrival", "he's dead on the
  // ground"), so excluding it there was a real recall regression, not a fix.
  /\bhe'?s dead\b(?!\s*(serious|ass|wrong))/i,
  /\bshe'?s dead\b(?!\s*(serious|ass|wrong))/i,
  /\bthey'?re dead\b(?!\s*(serious|ass|wrong))/i,
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
  // Deliberately excludes the common non-death objects real playtesting
  // caught ("we lost connection", "we lost the round" with nobody actually
  // dying) - "we lost X" for a person/team-fight/boss is still much broader
  // than the other patterns here and the single biggest remaining accepted
  // false-positive source, same category as "killed me" above.
  /\bwe lost\b(?!\s*(connection|signal|service|internet|wifi|audio|feed|the\s*(round|game|match)\b))/i,
  /\bi'?m out\b(?!\s*of)/i,
  // "knocked me out of the tournament/top spot/etc" is competitive
  // elimination language, not literal unconsciousness - same "out of"
  // exclusion the i'm-out pattern above already needed.
  /\bknocked me out\b(?!\s*of)/i,
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
