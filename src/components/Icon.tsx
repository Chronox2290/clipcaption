/** A small monoline icon set, inline SVG, zero dependencies — offline-first
 * like every other sidecar/asset in this app, so no icon font or CDN.
 *
 * Replaces the raw emoji (🎬 ✨ ⚡ ↻ 📍 ⚠ ⤢ ✦ ⬇ 🎭) used as button glyphs
 * throughout the app before this — the single biggest visual tell that read
 * as "hobby project" rather than "shipped tool" (see the design proposal
 * this came from). Add a new name here rather than reaching for an emoji.
 *
 * Sizing/stroke are set on the <svg> itself so every icon matches at any
 * call site without per-usage tuning; override via className/style only for
 * genuine one-offs.
 */
import type { SVGProps } from "react";

export type IconName =
  | "play"
  | "pause"
  | "cut"
  | "undo"
  | "redo"
  | "reel"
  | "sparkle"
  | "pin"
  | "warning"
  | "zoom"
  | "check"
  | "close"
  | "chevronDown"
  | "download"
  | "save"
  | "mask"
  | "fire"
  | "refresh"
  | "film"
  | "thumbUp"
  | "thumbDown";

const PATHS: Record<IconName, string> = {
  play: "M6 4l14 8-14 8V4z",
  pause: "M8 5v14M16 5v14",
  cut: "M8 6L20 18M20 6L8 18",
  undo: "M12 3v4M5 6l2.5 2.5M19 6l-2.5 2.5M3 13a9 9 0 1018 0",
  redo: "M12 3v4M19 6l-2.5 2.5M5 6l2.5 2.5M21 13a9 9 0 10-18 0",
  reel: "M4 20l4-11 4 11M6.5 13h3M14 12h6M17 9l3 3-3 3",
  sparkle: "M12 3l1.8 5.3L19 10l-5.2 1.7L12 17l-1.8-5.3L5 10l5.2-1.7L12 3z",
  pin: "M12 2a5 5 0 015 5v5a5 5 0 01-10 0V7a5 5 0 015-5zM5 11a7 7 0 0014 0M12 18v4",
  warning: "M12 9v4M12 16.5h.01M12 3l9 16H3L12 3z",
  zoom: "M11 3a8 8 0 100 16 8 8 0 000-16zM21 21l-4.35-4.35M11 8v3l2 2",
  check: "M20 6L9 17l-5-5",
  close: "M18 6L6 18M6 6l12 12",
  chevronDown: "M6 9l6 6 6-6",
  download: "M12 3v12M7 10l5 5 5-5M5 21h14",
  save: "M5 4h11l3 3v13H5V4zM8 4v6h8V4M8 15h8",
  mask: "M4 8a8 5 0 0116 0v3a8 5 0 01-16 0V8zM8 10h.01M16 10h.01",
  fire: "M12 2s5 4.5 5 9.5a5 5 0 01-10 0c0-1 .3-2 .8-2.8.6 1 1.7 1.8 2.7 1.3-.5-2 .5-4 1.5-5",
  refresh: "M4 4v5h5M20 20v-5h-5M4.5 15a8 8 0 0014.5 3.5M19.5 9A8 8 0 005 5.5",
  film: "M4 4h16v16H4V4zM4 9h16M4 15h16M8 4v16M16 4v16",
  thumbUp: "M7 11v9H4a1 1 0 01-1-1v-7a1 1 0 011-1h3zM7 11l3.5-7a2 2 0 013.6 1.2L13 9h5a2 2 0 012 2.3l-1.5 7A2 2 0 0116.6 20H10a3 3 0 01-3-3v-6z",
  thumbDown: "M17 13V4h3a1 1 0 011 1v7a1 1 0 01-1 1h-3zM17 13l-3.5 7a2 2 0 01-3.6-1.2L11 15H6a2 2 0 01-2-2.3l1.5-7A2 2 0 017.4 4H14a3 3 0 013 3v6z",
};

export function Icon({
  name,
  size = 16,
  strokeWidth = 1.8,
  ...rest
}: { name: IconName; size?: number; strokeWidth?: number } & Omit<
  SVGProps<SVGSVGElement>,
  "viewBox" | "width" | "height"
>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
