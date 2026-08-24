import type { Segment, WordSpan } from "../types";

// Curated, deliberately conservative — only strong, unambiguous trigger
// words, matched as whole words (not substrings), so an emoji reads as
// punctuation on a real beat instead of random noise. Capped at one per
// caption segment (see addEmojis below) for the same reason.
const EMOJI_MAP: Record<string, string> = {
  dead: "💀", died: "💀", death: "💀", rip: "💀", kill: "💀", killed: "💀", killer: "💀",
  lol: "😂", lmao: "😂", lmfao: "😂", haha: "😂", hilarious: "😂", funny: "😂",
  fire: "🔥", insane: "🔥", crazy: "🔥", nuts: "🔥", sick: "🔥", cracked: "🔥",
  wow: "😲", whoa: "😲", woah: "😲", what: "😲",
  love: "❤️", beautiful: "❤️",
  sad: "😢", cry: "😢", crying: "😢", heartbroken: "😢",
  angry: "😡", mad: "😡", rage: "😡", furious: "😡",
  win: "🏆", won: "🏆", winner: "🏆", victory: "🏆", champion: "🏆", clutch: "🏆",
  lose: "😭", lost: "😭", losing: "😭",
  money: "💰", rich: "💰", bank: "💰",
  boom: "💥", explode: "💥", explosion: "💥", exploded: "💥",
  scared: "😨", scary: "😨", terrifying: "😨", terrified: "😨",
  think: "🤔", thinking: "🤔", hmm: "🤔",
  clap: "👏", clapping: "👏",
  king: "👑", queen: "👑", goat: "🐐",
  yes: "✅", yeah: "✅", yep: "✅", facts: "💯", "100": "💯",
  no: "❌", nope: "❌", never: "❌",
  eyes: "👀", watch: "👀", watching: "👀", look: "👀", looking: "👀",
  please: "🙏", pray: "🙏", praying: "🙏", thanks: "🙏", thank: "🙏",
  run: "🏃", running: "🏃", ran: "🏃",
  gun: "🔫", shoot: "🔫", shot: "🔫", shooting: "🔫",
};

function lookupKey(word: string): string | null {
  const stripped = word.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
  return stripped || null;
}

/** Display-only transform (never mutates the real transcript, same pattern
 * as applyCensor) that appends a relevant emoji after the first strong
 * trigger word in each caption segment. One per segment, on purpose — this
 * is meant to land as emphasis on the segment's key beat, not decorate
 * every other word. */
export function addEmojis(segments: Segment[]): Segment[] {
  return segments.map((seg) => {
    let used = false;
    const words: WordSpan[] = seg.words.map((w) => {
      if (used) return w;
      const key = lookupKey(w.text);
      const emoji = key ? EMOJI_MAP[key] : undefined;
      if (!emoji) return w;
      used = true;
      return { ...w, text: `${w.text} ${emoji}` };
    });
    return { ...seg, words };
  });
}
