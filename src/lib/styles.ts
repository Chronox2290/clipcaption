import type { CSSProperties } from "react";
import type { CaptionDynamics } from "./captions";
import type { CaptionStyle } from "../types";

// Fonts chosen because they ship with Windows, so the ffmpeg/libass burn-in
// matches the in-app preview without bundling font files (that comes later).

export const STYLE_PRESETS: CaptionStyle[] = [
  {
    id: "beast",
    name: "Beast",
    font: "Arial Black",
    uppercase: true,
    fontSizePct: 5.2,
    fill: "#FFFFFF",
    activeFill: "#FFD400",
    outline: "#000000",
    outlineWidthPct: 0.45,
    fontWeight: 900, // Arial Black is a true black-weight face — 900 renders crisp, not synthetic
    shadow: true,
    boxColor: null,
    animation: "pop",
    positionPct: 76,
    maxWordsPerPage: 4,
    speakerColors: ["#FFFFFF", "#B9AFFF", "#FFD166", "#5EE6D0"],
    emojis: true,
    dynamic: true,
    dynamicAmountPct: 70,
    showSpeakerNames: false,
  },
  {
    id: "neon",
    name: "Neon",
    // Bahnschrift ships with Windows 10+ and has a real condensed/modern look
    // suited to a neon HUD vibe — Verdana at forced weight 900 (the old
    // setting) has no true black cut and just looked synthetically bolded.
    font: "Bahnschrift",
    uppercase: true,
    fontSizePct: 4.8,
    fill: "#EDFDFF",
    activeFill: "#2EE6FF",
    outline: "#062A4A",
    outlineWidthPct: 0.4,
    fontWeight: 700,
    shadow: true,
    boxColor: null,
    animation: "glow",
    positionPct: 78,
    maxWordsPerPage: 5,
    speakerColors: ["#EDFDFF", "#FF6FD8", "#7CFFB2", "#FFD166"],
    emojis: true,
    dynamic: true,
    dynamicAmountPct: 70,
    showSpeakerNames: false,
  },
  {
    id: "clean",
    name: "Clean",
    font: "Segoe UI",
    uppercase: false,
    fontSizePct: 4.2,
    fill: "#FFFFFF",
    activeFill: "#FFFFFF",
    outline: "#000000",
    outlineWidthPct: 0,
    fontWeight: 700, // bold, not forced-black — Segoe UI has no real 900 cut
    shadow: false,
    boxColor: "#000000B4",
    animation: "none",
    positionPct: 80,
    maxWordsPerPage: 6,
    speakerColors: ["#FFFFFF", "#FFD866", "#7EC8FF", "#FF8A65"],
    emojis: true,
    dynamic: true,
    dynamicAmountPct: 70,
    showSpeakerNames: false,
  },
  {
    id: "retro",
    name: "Retro",
    font: "Impact",
    uppercase: true,
    fontSizePct: 5.6,
    fill: "#FFF200",
    activeFill: "#FF5C00",
    outline: "#000000",
    outlineWidthPct: 0.5,
    // Impact is already a heavy condensed display face by design — forcing
    // 900 on top of that (the old setting) over-bolds it into mush.
    fontWeight: 400,
    shadow: true,
    boxColor: null,
    animation: "bounce",
    positionPct: 74,
    maxWordsPerPage: 3,
    speakerColors: ["#FFF200", "#00E5FF", "#FF5C00", "#B9FF66"],
    emojis: true,
    dynamic: true,
    dynamicAmountPct: 70,
    showSpeakerNames: false,
  },
  {
    id: "hype",
    name: "Hype",
    font: "Bahnschrift",
    uppercase: true,
    fontSizePct: 5.8,
    fill: "#FFE8D6",
    activeFill: "#FF3B30",
    outline: "#1A0500",
    outlineWidthPct: 0.5,
    fontWeight: 800,
    shadow: true,
    boxColor: null,
    animation: "shake",
    positionPct: 76,
    maxWordsPerPage: 4,
    speakerColors: ["#FFE8D6", "#7CFFB2", "#FF6FD8", "#7EC8FF"],
    emojis: true,
    dynamic: true,
    dynamicAmountPct: 70,
    showSpeakerNames: false,
  },
  {
    id: "comic",
    name: "Comic",
    font: "Comic Sans MS",
    uppercase: false,
    fontSizePct: 5.0,
    fill: "#FFFFFF",
    activeFill: "#FFEA00",
    outline: "#1B1B1B",
    outlineWidthPct: 0.42,
    fontWeight: 700,
    shadow: true,
    boxColor: null,
    animation: "bounce",
    positionPct: 78,
    maxWordsPerPage: 5,
    speakerColors: ["#FFFFFF", "#7EC8FF", "#FFD166", "#FF8A80"],
    emojis: true,
    dynamic: true,
    dynamicAmountPct: 70,
    showSpeakerNames: false,
  },
];

export function getPreset(id: string): CaptionStyle {
  return STYLE_PRESETS.find((s) => s.id === id) ?? STYLE_PRESETS[0];
}

/** CSS for the caption container, sized against the rendered video height.
 *
 * `dyn` comes from captionDynamics() — the same values the ASS export uses, so
 * the preview and the burned-in file place and size the caption identically. */
export function containerCss(
  style: CaptionStyle,
  videoHeightPx: number,
  dyn: CaptionDynamics = { offsetPct: 0, scale: 1, shake: false },
  row = 0
): CSSProperties {
  // Each stacked row lifts the caption by a little over one line height, so
  // two people talking at once read as two lines rather than one pile.
  const rowLift = (row ?? 0) * style.fontSizePct * 1.45;
  return {
    position: "absolute",
    left: `${50 + dyn.offsetPct}%`,
    top: `${Math.max(6, style.positionPct - rowLift)}%`,
    transform: "translate(-50%, -50%)",
    display: "flex",
    gap: "0.28em",
    flexWrap: "wrap",
    justifyContent: "center",
    // Narrower once captions can move sideways: a full-width line has nowhere
    // left to slide, and would just clip against the frame edge.
    maxWidth: dyn.offsetPct === 0 ? "92%" : "62%",
    fontFamily: `"${style.font}", sans-serif`,
    fontSize: `${(style.fontSizePct / 100) * videoHeightPx * dyn.scale}px`,
    fontWeight: style.fontWeight ?? 900,
    lineHeight: 1.15,
    textTransform: style.uppercase ? "uppercase" : "none",
    pointerEvents: "none",
    textAlign: "center",
  };
}

export function wordCss(
  style: CaptionStyle,
  active: boolean,
  videoHeightPx: number,
  speaker?: number | null
): CSSProperties {
  const ow = (style.outlineWidthPct / 100) * videoHeightPx;
  const stroke =
    ow > 0
      ? `${ow}px 0 0 ${style.outline}, -${ow}px 0 0 ${style.outline}, 0 ${ow}px 0 ${style.outline}, 0 -${ow}px 0 ${style.outline}, ${ow}px ${ow}px 0 ${style.outline}, -${ow}px ${ow}px 0 ${style.outline}, ${ow}px -${ow}px 0 ${style.outline}, -${ow}px -${ow}px 0 ${style.outline}`
      : undefined;
  const shadow = style.shadow ? `0 ${ow * 2.2}px ${ow * 2.5}px rgba(0,0,0,0.55)` : undefined;
  const textShadow = [stroke, shadow].filter(Boolean).join(", ") || undefined;

  const baseFill =
    speaker != null ? style.speakerColors[speaker % style.speakerColors.length] : style.fill;
  // The currently-spoken word is the most visually prominent thing on
  // screen (biggest, animated) — if it always used one global activeFill
  // regardless of speaker, a diarized caption effectively lost its speaker
  // coloring the instant a word became active, which made two-speaker
  // coloring look like it wasn't working at all. Lightening that speaker's
  // own color for the active word keeps the "pop" contrast while keeping
  // the color identity intact.
  const activeColor = speaker != null ? lighten(baseFill, 0.55) : style.activeFill;
  const base: CSSProperties = {
    color: active ? activeColor : baseFill,
    textShadow,
    padding: style.boxColor ? "0.05em 0.28em" : undefined,
    background: style.boxColor ? hex8ToRgba(style.boxColor) : undefined,
    borderRadius: style.boxColor ? "0.18em" : undefined,
    display: "inline-block",
    transition: "color 60ms linear",
  };

  if (active && style.animation === "pop") {
    base.animation = "cc-pop 160ms ease-out";
  } else if (active && style.animation === "bounce") {
    base.animation = "cc-bounce 220ms cubic-bezier(.34,1.56,.64,1)";
  } else if (active && style.animation === "karaoke") {
    base.animation = "cc-flick 130ms ease-out";
  } else if (active && style.animation === "glow") {
    base.animation = "cc-glow 420ms ease-out";
  } else if (active && style.animation === "shake") {
    base.animation = "cc-shake 260ms ease-out";
  }
  return base;
}

/** CSS for a speaker-name label rendered just above the caption words —
 * positioned as an absolutely-positioned child of containerCss's own div
 * (which is itself position:"absolute", a valid containing block), anchored
 * to the words block's own top edge via bottom:"100%" rather than a fixed
 * offset, so it doesn't overlap even when a page wraps onto extra lines. */
export function speakerNameCss(
  style: CaptionStyle,
  videoHeightPx: number,
  speaker: number
): CSSProperties {
  return {
    position: "absolute",
    left: "50%",
    bottom: "100%",
    transform: "translateX(-50%)",
    marginBottom: "0.3em",
    color: style.speakerColors[speaker % style.speakerColors.length],
    fontSize: "0.55em",
    fontWeight: 700,
    textShadow: "0 1px 3px rgba(0,0,0,0.7)",
    whiteSpace: "nowrap",
  };
}

/** Mixes a hex color toward white by `amt` (0..1) — used to derive the
 * "active word" highlight from a speaker's own base color instead of one
 * global highlight color that would erase which speaker is talking. */
export function lighten(hex: string, amt: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const mix = (c: number) => Math.round(c + (255 - c) * amt);
  return `#${[mix(r), mix(g), mix(b)]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("")}`;
}

export function hex8ToRgba(hex: string): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const a = h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return `rgba(${r},${g},${b},${a.toFixed(2)})`;
}
