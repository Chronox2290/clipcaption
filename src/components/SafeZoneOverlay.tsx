import type { CSSProperties } from "react";
import type { SafeZonePreset } from "../lib/safeZones";

interface Props {
  /** The displayed video box (object-fit: contain result) - see Editor.tsx's
   * own `stage` state. Matches the SOURCE video's aspect ratio, which is
   * usually 16:9, not the 9:16 a vertical export would actually produce. */
  stageW: number;
  stageH: number;
  preset: SafeZonePreset;
}

/** Draws platform UI safe-zone guides over the video preview - shaded bands
 * where TikTok/Reels/Shorts' own chrome typically sits, inscribed as a 9:16
 * rect centered in the current preview (matching what a vertical "Fill"
 * export preset would actually crop to), not stretched over the whole
 * preview regardless of its own aspect ratio. */
export default function SafeZoneOverlay({ stageW, stageH, preset }: Props) {
  if (stageW <= 0 || stageH <= 0) return null;

  const targetAr = 9 / 16;
  let cropW = stageW;
  let cropH = stageW / targetAr;
  if (cropH > stageH) {
    cropH = stageH;
    cropW = stageH * targetAr;
  }
  const cropLeft = (stageW - cropW) / 2;
  const cropTop = (stageH - cropH) / 2;

  const topH = (preset.top / 100) * cropH;
  const bottomH = (preset.bottom / 100) * cropH;
  const leftW = (preset.left / 100) * cropW;
  const rightW = (preset.right / 100) * cropW;

  const band: CSSProperties = {
    position: "absolute",
    background: "rgba(255, 60, 60, 0.16)",
    pointerEvents: "none",
  };

  return (
    <div
      className="safezone-overlay"
      style={{
        position: "absolute",
        left: cropLeft,
        top: cropTop,
        width: cropW,
        height: cropH,
        pointerEvents: "none",
      }}
    >
      <div className="safezone-frame" />
      <div style={{ ...band, left: 0, top: 0, width: "100%", height: topH }} />
      <div style={{ ...band, left: 0, bottom: 0, width: "100%", height: bottomH }} />
      <div style={{ ...band, left: 0, top: 0, width: leftW, height: "100%" }} />
      <div style={{ ...band, right: 0, top: 0, width: rightW, height: "100%" }} />
      <span className="safezone-label" style={{ top: 4, left: 6 }}>
        {preset.name} safe zone
      </span>
    </div>
  );
}
