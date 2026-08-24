// Standalone verification script (not part of the app) — generates real .ass
// files for every animation kind + a diarized 2-speaker page using the real
// buildAss()/STYLE_PRESETS code, so the new glow/shake/karaoke ASS syntax and
// the speaker-aware active-word color can be burned with real ffmpeg/libass
// instead of just trusting the string templates by eye.
import { buildAss } from "../src/lib/ass";
import { STYLE_PRESETS } from "../src/lib/styles";
import type { CaptionPage } from "../src/types";

const pages: CaptionPage[] = [
  {
    start: 0,
    end: 2.4,
    speaker: null,
    words: [
      { text: "this", start: 0, end: 0.6 },
      { text: "is", start: 0.6, end: 0.9 },
      { text: "a", start: 0.9, end: 1.05 },
      { text: "test", start: 1.05, end: 1.6 },
    ],
  },
  {
    start: 2.6,
    end: 4.6,
    speaker: 0,
    words: [
      { text: "speaker", start: 2.6, end: 3.1 },
      { text: "one", start: 3.1, end: 3.5 },
    ],
  },
  {
    start: 4.7,
    end: 6.7,
    speaker: 1,
    words: [
      { text: "speaker", start: 4.7, end: 5.2 },
      { text: "two", start: 5.2, end: 5.6 },
    ],
  },
];

for (const style of STYLE_PRESETS) {
  const ass = buildAss(pages, style, { playResX: 1280, playResY: 720 });
  console.log(`===== ${style.id} (animation=${style.animation}, fontWeight=${style.fontWeight}) =====`);
  console.log(ass);
}
