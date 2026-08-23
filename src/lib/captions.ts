import type { CaptionPage, Segment, WordSpan } from "../types";

/** Chunk transcript words into on-screen caption pages. */
export function paginate(
  segments: Segment[],
  maxWordsPerPage: number,
  maxGapSec = 0.8
): CaptionPage[] {
  const pages: CaptionPage[] = [];
  for (const seg of segments) {
    let current: WordSpan[] = [];
    for (const w of seg.words) {
      const prev = current[current.length - 1];
      const gapBreak = prev && w.start - prev.end > maxGapSec;
      if (current.length >= maxWordsPerPage || gapBreak) {
        if (current.length) pages.push(toPage(current));
        current = [];
      }
      current.push(w);
    }
    if (current.length) pages.push(toPage(current));
  }
  return pages;
}

function toPage(words: WordSpan[]): CaptionPage {
  return { start: words[0].start, end: words[words.length - 1].end, words };
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

let idCounter = 0;
export function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter}`;
}
