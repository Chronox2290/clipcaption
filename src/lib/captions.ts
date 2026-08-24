import type { CaptionPage, CaptionStyle, Segment, WordSpan } from "../types";

/** Chunk transcript words into on-screen caption pages. */
export function paginate(
  segments: Segment[],
  maxWordsPerPage: number,
  // Any silence longer than this starts a new caption page — which is what
  // actually clears the screen, since nothing is drawn between pages. Too
  // high and captions bridge real pauses (dead air, punchline beats) and
  // just sit there; too low and normal mid-sentence breathing gaps would
  // fragment captions into flashy, hard-to-read shards. 0.45s comfortably
  // bridges natural word-to-word gaps in speech while still clearing for a
  // genuine pause.
  maxGapSec = 0.45
): CaptionPage[] {
  // A whisper "segment" is already one continuous spoken unit (whisper's own
  // silence detection drew that boundary) — if it fits on one page by word
  // count, a merely-noticeable gap inside it (a dramatic pause, or timing
  // jitter from word-level alignment) shouldn't fragment it into orphaned
  // one/two-word captions that lose their sentence's context. Only break a
  // short segment early for a genuinely long pause; a segment that has to
  // split anyway (too many words) still uses the tighter threshold to find a
  // natural place to do it.
  const hardGapSec = maxGapSec * 2;

  const pages: CaptionPage[] = [];
  for (const seg of segments) {
    const gapThreshold = seg.words.length <= maxWordsPerPage ? hardGapSec : maxGapSec;
    let current: WordSpan[] = [];
    for (const w of seg.words) {
      const prev = current[current.length - 1];
      const gapBreak = prev && w.start - Math.min(prev.end, w.start) > gapThreshold;
      if (current.length >= maxWordsPerPage || gapBreak) {
        if (current.length) pages.push(toPage(current, seg));
        current = [];
      }
      current.push(w);
    }
    if (current.length) pages.push(toPage(current, seg));
  }
  return pages;
}

function toPage(words: WordSpan[], seg: Segment): CaptionPage {
  const start = words[0].start;
  // Belt-and-braces against a page that can never satisfy pageAt's
  // `t >= start && t <= end`. The backend now guarantees every word ends
  // after it starts, but a project saved before that fix - or a hand edit -
  // can still carry an inverted word, and the failure mode is silent: the
  // caption simply never appears, with the words all present and correct in
  // the transcript panel.
  const end = Math.max(words[words.length - 1].end, start + 0.06);
  return {
    start,
    end,
    words,
    speaker: seg.speaker,
    pan: seg.pan ?? null,
    intensity: seg.intensity ?? null,
  };
}

// ---------------- voice-driven caption dynamics ----------------

/** Furthest a caption may slide from centre, as a % of video width. Past
 * roughly this the text starts colliding with the frame edge on 16:9 once
 * it's a few words long. */
const MAX_OFFSET_PCT = 26;
/** Size at the quietest and loudest speech in the clip. */
const MIN_SCALE = 0.72;
const MAX_SCALE = 1.34;
/** Intensity at or above which a line is treated as a shout. */
const SHAKE_AT = 0.88;
/** Used when a transcript predates the analysis pass: dead centre, normal
 * size, no shake — i.e. exactly the old behaviour. */
const NEUTRAL_INTENSITY = 0.5;

export interface CaptionDynamics {
  /** Horizontal shift from centre, % of video width. */
  offsetPct: number;
  /** Multiplier on the caption's font size. */
  scale: number;
  /** Whether this line should shake, because someone is shouting. */
  shake: boolean;
}

/** How a caption page should be presented, given what the voice was doing.
 *
 * Shared deliberately by the live preview (styles.ts) and the burned-in ASS
 * export (ass.ts): they have to agree exactly, and the only way to guarantee
 * that is for both to ask the same function rather than each implementing
 * "slide it a bit left" in their own units. */
export function captionDynamics(page: CaptionPage, style: CaptionStyle): CaptionDynamics {
  if (!style.dynamic) return { offsetPct: 0, scale: 1, shake: false };

  const amount = Math.max(0, Math.min(100, style.dynamicAmountPct ?? 100)) / 100;
  const pan = page.pan ?? 0;
  const intensity = page.intensity ?? NEUTRAL_INTENSITY;

  // Scale is anchored at the middle of the clip's own loudness range, so a
  // normal speaking voice stays normal size and only genuinely quiet or
  // genuinely loud lines move away from it.
  const spread = intensity - NEUTRAL_INTENSITY;
  const reach = spread >= 0 ? MAX_SCALE - 1 : 1 - MIN_SCALE;
  const scale = 1 + spread * 2 * reach * amount;

  return {
    offsetPct: pan * MAX_OFFSET_PCT * amount,
    scale,
    shake: intensity >= SHAKE_AT && amount > 0,
  };
}

export function pageAt(pages: CaptionPage[], t: number, linger = 0.25): CaptionPage | null {
  for (const p of pages) {
    if (t >= p.start && t <= p.end + linger) return p;
  }
  return null;
}

export function activeWordIndex(page: CaptionPage, t: number): number {
  let idx = 0;
  for (let i = 0; i < page.words.length; i++) {
    if (t >= page.words[i].start) idx = i;
  }
  return idx;
}

// ---------------- profanity ----------------

const PROFANITY = [
  "fuck", "fucking", "fucked", "fucker", "shit", "shitty", "bullshit",
  "bitch", "asshole", "dickhead", "cunt", "bastard", "goddamn",
];

const profanityRe = new RegExp(
  `^(${PROFANITY.join("|")})([.,!?'"]*)$`,
  "i"
);

/** Star out profane words: "fucking" -> "f*****" (keeps first letter + punctuation). */
export function censorWord(text: string): string {
  const m = text.trim().match(profanityRe);
  if (!m) return text;
  const word = m[1];
  const tail = m[2] ?? "";
  return word[0] + "*".repeat(Math.max(word.length - 1, 1)) + tail;
}

export function applyCensor(segments: Segment[]): Segment[] {
  return segments.map((s) => ({
    ...s,
    words: s.words.map((w) => ({ ...w, text: censorWord(w.text) })),
  }));
}

export function isProfane(text: string): boolean {
  return profanityRe.test(text.trim());
}

/** Shift caption pages onto a clip-relative timeline (e.g. for trimmed exports). */
export function shiftPages(pages: CaptionPage[], offset: number): CaptionPage[] {
  return pages.map((p) => ({
    // Spread first: this used to list every field by hand, which quietly
    // dropped anything added to CaptionPage later (pan/intensity would have
    // vanished from exactly the trimmed exports this exists for).
    ...p,
    start: Math.max(0, p.start - offset),
    end: Math.max(0, p.end - offset),
    words: p.words.map((w) => ({
      ...w,
      start: Math.max(0, w.start - offset),
      end: Math.max(0, w.end - offset),
    })),
  }));
}

// ---------------- helpers ----------------

export function fmtTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

/** Parses what fmtTime prints, plus the obvious variations people type:
 * "1:23.4", "1:23", "83.4", "83". Returns null for anything unparseable so
 * the caller can leave the field's previous value alone rather than
 * committing a NaN that would blow up the timeline. */
export function parseTime(text: string): number | null {
  const t = text.trim().replace(/\s+/g, "");
  if (!t) return null;
  const m = t.match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const mins = m[1] ? Number(m[1]) : 0;
  const secs = Number(m[2]);
  // "1:75" is a typo, not 2:15 — reject rather than silently reinterpret.
  if (m[1] && secs >= 60) return null;
  const total = mins * 60 + secs;
  return Number.isFinite(total) ? total : null;
}

/** Job-stage strings from the Rust backend ("exporting", "pass 1/2", …) are
 * lowercase identifiers, not display text — capitalize the first letter
 * wherever one is shown directly in the UI. */
export function capitalize(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

/** Splits manually-typed caption text into individual, independently-timed
 * words spanning [start,end] — proportioned by each word's length so a long
 * word gets more screen time than "a" or "to". Without this, typing a whole
 * sentence into the "add a missed line" prompt produced ONE WordSpan holding
 * the entire sentence, which broke the karaoke/pop/bounce per-word highlight
 * (there's only one "word" to ever be "active") and made it look like static
 * text for the whole duration. Splitting it here makes a hand-typed caption
 * behave exactly like a whisper-produced one — same animation, same
 * per-word drag-to-retime afterward. */
export function distributeWordTimes(tokens: string[], start: number, end: number): WordSpan[] {
  if (tokens.length === 0) return [];
  const dur = Math.max(0.02 * tokens.length, end - start);
  const weights = tokens.map((t) => Math.max(1, t.length));
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const words: WordSpan[] = [];
  let t = start;
  tokens.forEach((tok, i) => {
    const isLast = i === tokens.length - 1;
    const share = (weights[i] / totalWeight) * dur;
    const wStart = t;
    const wEnd = isLast ? start + dur : Math.min(start + dur, t + share);
    words.push({ text: tok, start: wStart, end: Math.max(wStart + 0.02, wEnd) });
    t = words[words.length - 1].end;
  });
  return words;
}

let idCounter = 0;
export function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter}`;
}
