import type { CSSProperties } from "react";
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
    shadow: true,
    boxColor: null,
    animation: "pop",
    positionPct: 76,
    maxWordsPerPage: 4,
    speakerColors: ["#FFFFFF", "#B9AFFF"],
    emojis: false,
  },
  {
    id: "neon",
    name: "Neon",
    font: "Verdana",
    uppercase: true,
    fontSizePct: 4.8,
    fill: "#EDFDFF",
    activeFill: "#2EE6FF",
    outline: "#062A4A",
    outlineWidthPct: 0.4,
    shadow: true,
    boxColor: null,
    animation: "karaoke",
    positionPct: 78,
    maxWordsPerPage: 5,
    speakerColors: ["#EDFDFF", "#FF6FD8"],
    emojis: false,
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
    shadow: false,
    boxColor: "#000000B4",
    animation: "none",
    positionPct: 80,
    maxWordsPerPage: 6,
    speakerColors: ["#FFFFFF", "#FFD866"],
    emojis: false,
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
    shadow: true,
    boxColor: null,
    animation: "bounce",
    positionPct: 74,
    maxWordsPerPage: 3,
    speakerColors: ["#FFF200", "#00E5FF"],
    emojis: false,
  },
];

export function getPreset(id: string): CaptionStyle {
  return STYLE_PRESETS.find((s) => s.id === id) ?? STYLE_PRESETS[0];
}

/** CSS for the caption container, sized against the rendered video height. */
export function containerCss(style: CaptionStyle, videoHeightPx: number): CSSProperties {
  return {
    position: "absolute",
    left: "50%",
    top: `${style.positionPct}%`,
    transform: "translate(-50%, -50%)",
    display: "flex",
    gap: "0.28em",
    flexWrap: "wrap",
    justifyContent: "center",
    maxWidth: "92%",
    fontFamily: `"${style.font}", sans-serif`,
    fontSize: `${(style.fontSizePct / 100) * videoHeightPx}px`,
    fontWeight: 900,
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
  const base: CSSProperties = {
    color: active ? style.activeFill : baseFill,
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
  }
  return base;
}

export function hex8ToRgba(hex: string): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const a = h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return `rgba(${r},${g},${b},${a.toFixed(2)})`;
}
