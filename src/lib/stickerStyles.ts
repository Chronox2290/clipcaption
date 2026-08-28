// Sticker visual presets - see types.ts's Sticker.styleId and lib/stickerAss.ts.
// Same shape of decision lib/styles.ts's STYLE_PRESETS already made for
// dialogue captions: a fixed, hand-tuned array of complete looks rather than
// a general-purpose font/color-picker UI, picked via preset cards. The first
// sticker layer shipped with exactly one hardcoded look (rainbow/Comic Sans)
// built from one reference screenshot - the user was clear afterward that
// was just a starting reference, not the spec: the real want is a real
// library to choose from, the same way dialogue captions already have one.
//
// Every font here is one Windows ships with by default (same reasoning
// styles.ts's own font choices already use, so libass's burn-in resolves
// the same face the CSS preview does) - no font-embedding infrastructure
// exists in this app, so anything not already on the system silently
// substitutes to a default at burn-in time.

export interface StickerStyle {
  id: string;
  name: string;
  font: string;
  uppercase: boolean;
  /** Per-letter cycling fill colors, in order - length 1 renders as a plain
   * solid fill (no cycling), length 2-3 cycles like the original rainbow
   * reference. Never randomized - always the same fixed repeating pattern,
   * matching the reference spec's own "confirmed pattern, not random." */
  palette: string[];
  /** Text outline (ASS \3c/\bord) - null means no outline at all. */
  outlineColor: string | null;
  /** Text glow via a soft blur on the fill (ASS \blur) - a cheap stand-in
   * for real neon glow, which libass can't do natively (no bloom/glow
   * filter, just blur). */
  glow: boolean;
  /** Sticker background box - null means no box, the text floats free. */
  boxColor: string | null;
  /** Drop shadow on both the box (if any) and the text. */
  shadow: boolean;
  /** Applied to a newly-placed sticker using this style - still freely
   * adjustable afterward via the rotation slider, not locked in. */
  defaultRotationDeg: number;
}

export const STICKER_STYLES: StickerStyle[] = [
  {
    id: "rainbow-pop",
    name: "Rainbow Pop",
    font: "Comic Sans MS",
    uppercase: true,
    palette: ["#FF3E9E", "#2EE6D6", "#FFD93D"],
    outlineColor: "#000000",
    glow: false,
    boxColor: "#FFF8EC",
    shadow: true,
    defaultRotationDeg: -6,
  },
  {
    id: "bubble-gum",
    name: "Bubble Gum",
    font: "Comic Sans MS",
    uppercase: true,
    palette: ["#FF4FA3"],
    outlineColor: "#FFFFFF",
    glow: false,
    boxColor: null,
    shadow: true,
    defaultRotationDeg: 4,
  },
  {
    id: "neon-glow",
    name: "Neon Glow",
    font: "Segoe UI",
    uppercase: true,
    palette: ["#3CF2FF"],
    outlineColor: "#0A2A2E",
    glow: true,
    boxColor: "#0A0F14",
    shadow: false,
    defaultRotationDeg: 0,
  },
  {
    id: "caution-tape",
    name: "Caution Tape",
    font: "Impact",
    uppercase: true,
    palette: ["#111111"],
    outlineColor: null,
    glow: false,
    boxColor: "#FFE100",
    shadow: false,
    defaultRotationDeg: 0,
  },
  {
    id: "handwritten-note",
    name: "Handwritten Note",
    font: "Segoe Script",
    uppercase: false,
    palette: ["#2B2B2B"],
    outlineColor: null,
    glow: false,
    boxColor: "#FFFDF5",
    shadow: true,
    defaultRotationDeg: -3,
  },
  {
    id: "retro-stamp",
    name: "Retro Stamp",
    font: "Courier New",
    uppercase: true,
    palette: ["#C21F2E"],
    outlineColor: "#C21F2E",
    glow: false,
    boxColor: null,
    shadow: false,
    defaultRotationDeg: -4,
  },
  {
    id: "cyber-glitch",
    name: "Cyber Glitch",
    font: "Consolas",
    uppercase: true,
    palette: ["#39FF88", "#FF2FE0"],
    outlineColor: "#000000",
    glow: true,
    boxColor: "#0B0B12",
    shadow: false,
    defaultRotationDeg: 2,
  },
  {
    id: "minimal-white",
    name: "Minimal White",
    font: "Segoe UI",
    uppercase: false,
    palette: ["#FFFFFF"],
    outlineColor: "#000000",
    glow: false,
    boxColor: null,
    shadow: false,
    defaultRotationDeg: 0,
  },
  {
    id: "gold-foil",
    name: "Gold Foil",
    font: "Georgia",
    uppercase: true,
    palette: ["#F4CE6B", "#D9A63E"],
    outlineColor: "#5C3F0E",
    glow: false,
    boxColor: "#161104",
    shadow: true,
    defaultRotationDeg: -2,
  },
  {
    id: "warning-block",
    name: "Warning Block",
    font: "Arial Black",
    uppercase: true,
    palette: ["#FFFFFF"],
    outlineColor: "#111111",
    glow: false,
    boxColor: "#E31C1C",
    shadow: false,
    defaultRotationDeg: 0,
  },
  {
    id: "kawaii-pastel",
    name: "Kawaii Pastel",
    font: "Comic Sans MS",
    uppercase: false,
    palette: ["#FFB6D9", "#C9B6FF", "#B6FFE0"],
    outlineColor: null,
    glow: false,
    boxColor: "#FFFFFF",
    shadow: true,
    defaultRotationDeg: 5,
  },
  {
    id: "horror-drip",
    name: "Horror Drip",
    font: "Segoe Print",
    uppercase: true,
    palette: ["#8A0F0F"],
    outlineColor: "#000000",
    glow: false,
    boxColor: "#0D0505",
    shadow: true,
    defaultRotationDeg: -8,
  },
  {
    id: "sports-broadcast",
    name: "Sports Broadcast",
    font: "Bahnschrift",
    uppercase: true,
    palette: ["#FFFFFF"],
    outlineColor: null,
    glow: false,
    boxColor: "#1450C4",
    shadow: true,
    defaultRotationDeg: 0,
  },
  {
    id: "vaporwave",
    name: "Vaporwave",
    font: "Trebuchet MS",
    uppercase: true,
    palette: ["#B26BFF", "#FF6BD6", "#6BE0FF"],
    outlineColor: "#22093E",
    glow: false,
    boxColor: "#1B0C33",
    shadow: true,
    defaultRotationDeg: -3,
  },
  {
    id: "chalkboard",
    name: "Chalkboard",
    font: "Segoe Print",
    uppercase: false,
    palette: ["#F3F3EA"],
    outlineColor: null,
    // Tried with glow on first (a "soft chalk smudge" idea) - rendered and
    // checked against the real burn-in, and the blur wrecked legibility
    // (white-on-dark-green has little contrast margin to spare). Off.
    glow: false,
    boxColor: "#1B3B2F",
    shadow: false,
    defaultRotationDeg: -2,
  },
];

export function getStickerStyle(id: string): StickerStyle {
  return STICKER_STYLES.find((s) => s.id === id) ?? STICKER_STYLES[0];
}
