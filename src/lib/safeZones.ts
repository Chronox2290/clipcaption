/** Where each platform's own UI (profile pic, caption text, like/comment/
 * share column, progress bar) sits on top of a vertical (9:16) video, so
 * captions and important action can be placed to avoid it while editing -
 * "confirm current status against the original MVP brainstorm" (brief);
 * confirmed not started, built here.
 *
 * Values are approximate creator-tool guideline percentages of a 9:16
 * frame, not pulled from each platform's current pixel-exact spec (none
 * publish one) - a guide to plan around, not a pixel-perfect guarantee. All
 * four margins are % of the vertical frame's own width/height, measured
 * inward from each edge.
 */
export interface SafeZonePreset {
  id: string;
  name: string;
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export const SAFE_ZONE_PRESETS: SafeZonePreset[] = [
  {
    id: "tiktok",
    name: "TikTok",
    top: 8,
    bottom: 22,
    left: 4,
    right: 16,
  },
  {
    id: "reels",
    name: "Instagram Reels",
    top: 10,
    bottom: 22,
    left: 4,
    right: 16,
  },
  {
    id: "shorts",
    name: "YouTube Shorts",
    top: 10,
    bottom: 18,
    left: 4,
    right: 14,
  },
];

export function getSafeZonePreset(id: string | null): SafeZonePreset | null {
  return SAFE_ZONE_PRESETS.find((p) => p.id === id) ?? null;
}
