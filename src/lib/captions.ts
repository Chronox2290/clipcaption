import type { CaptionPage, CaptionStyle, Segment, SpeakerProfile, WordSpan } from "../types";

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

      // Break AFTER a sentence ends, rather than only when the word budget
      // runs out. Counting words alone cuts sentences at arbitrary points and
      // then strands their tail with the start of the next one, which is what
      // made captions read as a stream of fragments rather than lines someone
      // said. A one-word "Yeah." is left to join what follows instead of
      // flashing on its own.
      if (current.length >= MIN_WORDS_TO_END_A_PAGE && endsSentence(w.text)) {
        pages.push(toPage(current, seg));
        current = [];
      }
    }
    if (current.length) pages.push(toPage(current, seg));
  }
  return pages;
}

/** Below this, a "sentence" is too short to deserve its own caption - a lone
 * "Yeah." or "No." reads better carried into the next line than flashed up
 * and cleared. */
const MIN_WORDS_TO_END_A_PAGE = 3;

function endsSentence(text: string): boolean {
  // Trailing quotes and brackets come after the punctuation that ends the
  // sentence: ...great!" still ends it.
  const t = text.trim();
  // A single capital letter before the dot is an initial ("J."), not the end
  // of a sentence. Anything longer ending in a dot is.
  if (/(^|\s)[A-Z]\.$/.test(t)) return false;
  return /[.!?]["')\]]*$/.test(t);
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

export const CAPTION_LINGER = 0.25;

export function pageAt(pages: CaptionPage[], t: number, linger = CAPTION_LINGER): CaptionPage | null {
  for (const p of pages) {
    if (t >= p.start && t <= p.end + linger) return p;
  }
  return null;
}

/** Every caption live at `t`, not just the first.
 *
 * In a proximity-chat game people talk over each other constantly, so
 * returning one page meant the other speaker's line simply never appeared -
 * and whichever page happened to come first in the array won. */
export function pagesAt(pages: CaptionPage[], t: number, linger = CAPTION_LINGER): CaptionPage[] {
  return pages.filter((p) => t >= p.start && t <= p.end + linger);
}

/** Assigns each page a row so simultaneous captions stack instead of drawing
 * on top of each other.
 *
 * A page's row is how many *later-starting* captions overlap it, so the newest
 * line always sits at the style's own position and older ones are lifted above
 * it. Reading top to bottom then follows the order things were said. The
 * obvious alternative - give each caption the lowest free row - does exactly
 * the opposite: the second speaker lands above the first, so a reply appears
 * over the line it answers and the screen reads backwards.
 *
 * Rows are fixed per page rather than recomputed per frame, so a caption never
 * jumps rows mid-display. The cost is that a caption about to be joined sits
 * lifted slightly early, with its slot empty beneath it. */
/** Roughly how many lines a caption will wrap to.
 *
 * Only the burned-in export needs this - the preview measures itself. The
 * budget is deliberately conservative (assume the narrow, spatial-caption
 * width), because guessing too few lines makes captions overlap, while
 * guessing too many only leaves a little extra air between them. */
const CHARS_PER_LINE = 24;

function estimateLines(page: CaptionPage): number {
  const chars = page.words.reduce((n, w) => n + w.text.length + 1, 0);
  return Math.max(1, Math.ceil(chars / CHARS_PER_LINE));
}

export function layoutRows(pages: CaptionPage[], linger = CAPTION_LINGER): CaptionPage[] {
  const sorted = [...pages].sort((a, b) => a.start - b.start);
  const rowOf = new Map<CaptionPage, number>();

  for (let i = 0; i < sorted.length; i++) {
    const page = sorted[i];
    let lines = 0;
    // Sorted by start, so once a page begins after this one's display window
    // there are no further overlaps to count. Summing the LINES of the
    // captions below rather than counting them is what stops a wrapped
    // caption growing into the one above it - the preview gets this for free
    // from flexbox, the burned-in export has to be told.
    for (let j = i + 1; j < sorted.length && sorted[j].start <= page.end + linger; j++) {
      lines += estimateLines(sorted[j]);
    }
    rowOf.set(page, lines);
  }

  return pages.map((p) => ({ ...p, row: rowOf.get(p) ?? 0 }));
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

/** Below this, a word is worth a second look. Whisper is confidently wrong
 * often enough that this can't be a guarantee - it's a shortlist, not a
 * verdict. Set where it flags the genuinely mangled words on real game audio
 * without lighting up half the transcript. */
export const UNSURE_BELOW = 0.55;

/** True when whisper wasn't sure about this word. Words with no confidence at
 * all (typed by hand, or from an older transcript) are treated as certain -
 * flagging them would bury the ones that need attention. */
export function isUnsure(w: WordSpan): boolean {
  return w.confidence != null && w.confidence < UNSURE_BELOW;
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

// ---------------- speaker names ----------------
//
// A diarized speaker index (Segment.speaker) is only ever a *local* id -
// sherpa-onnx's clustering reassigns 0, 1, 2... fresh on every single
// diarization run, so it carries no identity of its own across the live
// preview and each export's own independent re-transcription. A
// SpeakerProfile instead identifies a real voice by its embedding (see
// TranscribeResult.speakerEmbeddings); resolveSpeakerNames below is what
// turns "this run's speaker 0" back into "Alex" by matching embeddings.

/** The same generic per-clip letter used before names existed ("Speaker A",
 * "Speaker B", ...) - still the fallback for any speaker that hasn't been
 * named, or whose voice didn't match a saved profile closely enough. */
export function speakerLetter(speaker: number): string {
  return String.fromCharCode(65 + (((speaker % 26) + 26) % 26));
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Minimum cosine similarity to call two embeddings "the same voice". Set
 * from a real measurement, not a guess: extracting embeddings independently
 * for the same person's voice in different real audio files (this app's own
 * titanet embedding model, via the extract-embedding sidecar) scored
 * 0.63-0.75; different people's voices scored 0.06-0.30 - a clean, wide
 * gap. 0.5 sits solidly in the middle of that gap with margin on both
 * sides, so it's a threshold with real headroom rather than one riding
 * right up against where the two populations start to overlap. */
export const SPEAKER_MATCH_THRESHOLD = 0.5;

/** For every distinct speaker id `speakerEmbeddings` has an embedding for,
 * finds the best-matching saved SpeakerProfile (by cosine similarity).
 * Returns the whole matched profile (not just its name) so callers that
 * need to update/replace a profile - not just display it - have its id
 * too. A speaker with no embedding, or whose closest match doesn't clear
 * SPEAKER_MATCH_THRESHOLD, is simply absent from the result. */
export function matchSpeakerProfiles(
  speakerEmbeddings: Record<string, number[]>,
  profiles: SpeakerProfile[]
): Record<number, SpeakerProfile> {
  const matched: Record<number, SpeakerProfile> = {};
  if (!profiles.length) return matched;
  for (const [key, embedding] of Object.entries(speakerEmbeddings)) {
    let best: SpeakerProfile | null = null;
    let bestScore = -Infinity;
    for (const profile of profiles) {
      const score = cosineSimilarity(embedding, profile.embedding);
      if (score > bestScore) {
        bestScore = score;
        best = profile;
      }
    }
    if (best && bestScore >= SPEAKER_MATCH_THRESHOLD) {
      matched[Number(key)] = best;
    }
  }
  return matched;
}

/** Same as matchSpeakerProfiles, but just the names - what the rendering
 * paths (CaptionOverlay, buildAss, the transcript's speaker-dot tooltip)
 * actually need. */
export function resolveSpeakerNames(
  speakerEmbeddings: Record<string, number[]>,
  profiles: SpeakerProfile[]
): Record<number, string> {
  const matched = matchSpeakerProfiles(speakerEmbeddings, profiles);
  const names: Record<number, string> = {};
  for (const [key, profile] of Object.entries(matched)) {
    names[Number(key)] = profile.name;
  }
  return names;
}

/** Display label for a caption page/transcript row's speaker: the resolved
 * name if one matched, else the generic "Speaker A" fallback, else null for
 * no detected speaker at all. */
export function speakerLabel(
  speaker: number | null,
  resolvedNames: Record<number, string>
): string | null {
  if (speaker == null) return null;
  return resolvedNames[speaker] ?? `Speaker ${speakerLetter(speaker)}`;
}
