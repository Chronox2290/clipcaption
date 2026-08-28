// Renders the decorative sticker layer (see Sticker in types.ts) as extra
// ASS Dialogue lines, appended to buildAss()'s own output - see buildAss's
// doc comment for why a second Dialogue block needs no new [Script
// Info]/[V4+ Styles] section of its own: everything a sticker needs (font,
// size, color, box, rotation) is carried entirely via inline override tags
// on top of the same "Cap" style already declared there, so plain string
// concatenation is enough for the two layers to coexist in one .ass file.
//
// Visual spec (from a real reference: an Instagram Reel's sticker-style
// reaction text, confirmed across 5 screenshots incl. two in Korean):
// per-letter rainbow cycling (pink -> teal -> yellow, repeating, not
// random), bold cartoon font, an off-white background box, a soft
// down-right drop shadow, free placement + slight rotation. One thing this
// deliberately does NOT attempt: the reference's subtle grid/crosshatch
// TEXTURE and rough/torn paper edges - libass has no bitmap-texture fill,
// only flat vector shapes and solid colors, so the box below is a flat
// rounded rectangle, not a textured/torn sticker cutout. Noted here rather
// than silently shipping a flatter look than the spec called for.

import type { Sticker } from "../types";
import { assColor, assTime, esc } from "./ass";

const RAINBOW = ["#FF3E9E", "#2EE6D6", "#FFD93D"]; // pink/magenta, teal/cyan, yellow

/** Comic Sans MS ships with every Windows install (same reasoning
 * lib/styles.ts's own preset fonts use) and is the literal, unambiguous
 * "cartoon/comic sans-serif" match the reference spec calls for. Its
 * Unicode fallback for non-Latin scripts (Korean confirmed in the
 * reference) goes through the same libass automatic font-substitution path
 * already verified for the dialogue captions (Segoe UI -> Malgun Gothic) -
 * not re-verified separately here, same underlying mechanism. */
const STICKER_FONT = "Comic Sans MS";

/** Builds a rounded-rectangle ASS vector drawing path (relative to the
 * shape's own top-left, before \pos moves it), width w / height h / corner
 * radius r. Same bezier-corner technique any "rounded rect" drawing helper
 * uses - ASS draw commands have no native rounded-rect primitive, only
 * lines (`l`) and cubic beziers (`b`). */
function roundedRectPath(w: number, h: number, r: number): string {
  const c = Math.min(r, w / 2, h / 2);
  return (
    `m ${c} 0 ` +
    `l ${w - c} 0 ` +
    `b ${w} 0 ${w} 0 ${w} ${c} ` +
    `l ${w} ${h - c} ` +
    `b ${w} ${h} ${w} ${h} ${w - c} ${h} ` +
    `l ${c} ${h} ` +
    `b 0 ${h} 0 ${h} 0 ${h - c} ` +
    `l 0 ${r} ` +
    `b 0 0 0 0 ${c} 0`
  );
}

/** No real text-shaping/font-metrics available outside a browser canvas
 * measurement here (this runs the same on both the frontend build and,
 * conceptually, wherever the .ass string gets assembled) - approximates a
 * bold cartoon font's average advance width as a fraction of its own point
 * size. Comic Sans Bold runs wide, hence the higher multiplier than a
 * typical caption font would use. An approximation, not exact metrics -
 * errs slightly wide on purpose so the box is never visibly too tight. */
function estimateTextWidth(text: string, fontSize: number): number {
  return text.length * fontSize * 0.62;
}

/** Filters stickers to whichever overlap [rangeStart,rangeEnd) on the
 * SOURCE video's timeline, then shifts them by `offset` onto the exported
 * output's own local timeline - same idea as lib/captions.ts's shiftPages,
 * used the same way at every trim/compile export call site (a single active
 * range, or one range per compiled highlight in a multi-range reel, each
 * with its own cumulative offset). A sticker only partially inside the
 * range still gets included, clamped to the range's own edges - same
 * "don't silently drop a sticker that's mostly in view" reasoning as a
 * caption page that starts just before a trim point. */
export function stickersForRange(
  stickers: Sticker[],
  rangeStart: number,
  rangeEnd: number,
  offset: number
): Sticker[] {
  return stickers
    .filter((s) => s.endSec > rangeStart && s.startSec < rangeEnd)
    .map((s) => ({
      ...s,
      startSec: Math.max(0, Math.max(s.startSec, rangeStart) - offset),
      endSec: Math.max(0, Math.min(s.endSec, rangeEnd) - offset),
    }));
}

export interface StickerAssOptions {
  playResX: number;
  playResY: number;
}

export function buildStickerAss(stickers: Sticker[], opts: StickerAssOptions): string {
  if (stickers.length === 0) return "";
  const lines: string[] = [];

  for (const s of stickers) {
    const text = esc(s.text.trim());
    if (!text) continue;
    const fontSize = Math.max(10, Math.round((s.fontSizePct / 100) * opts.playResY));
    const x = Math.round(opts.playResX * (s.xPct / 100));
    const y = Math.round(opts.playResY * (s.yPct / 100));
    const w = Math.round(estimateTextWidth(text, fontSize) + fontSize * 1.1);
    const h = Math.round(fontSize * 1.7);
    const radius = Math.round(fontSize * 0.35);

    // Layer 0: the sticker box, drawn first (lower layers render below
    // higher ones in ASS) - cream fill, soft down-right drop shadow via
    // \shad. Drawn from its own (0,0) top-left in local shape space; \an5
    // (same alignment mechanism the dialogue captions already rely on for
    // \pos centering) tells libass to center the shape's own bounding box
    // on (x,y), so no manual offset math is needed here.
    const boxPath = roundedRectPath(w, h, radius);
    lines.push(
      dialogue(
        s.startSec,
        s.endSec,
        0,
        `{\\an5\\pos(${x},${y})\\frz${s.rotationDeg}` +
          `\\p1\\1c${assColor("#FFF8EC")}\\bord0\\shad4\\4c&H000000&\\4a&H60&}` +
          `${boxPath}{\\p0}`
      )
    );

    // Layer 1: the text itself, one override block per character so each
    // letter cycles through the fixed 3-color rainbow palette - confirmed
    // as a fixed repeating pattern in the reference, not randomized. `\h`
    // is ASS's hard (non-breaking, non-collapsing) space - a plain literal
    // space between override blocks can get trimmed by some renderers.
    const chars = [...text];
    const perChar = chars
      .map((ch, i) => `{\\1c${assColor(RAINBOW[i % RAINBOW.length])}}${ch === " " ? "\\h" : ch}`)
      .join("");
    lines.push(
      dialogue(
        s.startSec,
        s.endSec,
        1,
        `{\\an5\\pos(${x},${y})\\frz${s.rotationDeg}\\fn${STICKER_FONT}\\fs${fontSize}\\b1` +
          `\\bord2\\3c&H000000&\\shad2\\4c&H000000&\\4a&H60&}${perChar}`
      )
    );
  }

  return lines.join("\n") + (lines.length ? "\n" : "");

  function dialogue(start: number, end: number, layer: number, text: string): string {
    return `Dialogue: ${layer},${assTime(start)},${assTime(end)},Cap,,0,0,0,,${text}`;
  }
}
