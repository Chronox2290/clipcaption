import type { ExportPreset } from "../types";

export const EXPORT_PRESETS: ExportPreset[] = [
  { id: "original", name: "Original quality", targetW: null, targetH: null, targetSizeMB: null, crf: 20, fps: null, audioKbps: 160 },
  { id: "vertical", name: "TikTok / Reels / Shorts (9:16 crop)", targetW: 1080, targetH: 1920, targetSizeMB: null, crf: 21, fps: 60, audioKbps: 160 },
  { id: "discord20", name: "Discord Free — fit 20 MB", targetW: null, targetH: null, targetSizeMB: 20, crf: null, fps: 30, audioKbps: 96 },
  { id: "discord50", name: "Discord Nitro Basic / Lv2 boost — fit 50 MB", targetW: null, targetH: null, targetSizeMB: 50, crf: null, fps: 60, audioKbps: 128 },
  { id: "discord100", name: "Discord Lv3 boosted server — fit 100 MB", targetW: null, targetH: null, targetSizeMB: 100, crf: null, fps: 60, audioKbps: 160 },
  { id: "discord500", name: "Discord Nitro — fit 500 MB", targetW: null, targetH: null, targetSizeMB: 500, crf: null, fps: null, audioKbps: 160 },
  { id: "custom", name: "Custom size…", targetW: null, targetH: null, targetSizeMB: 25, crf: null, fps: null, audioKbps: 128 },
];

export function getExportPreset(id: string): ExportPreset {
  return EXPORT_PRESETS.find((p) => p.id === id) ?? EXPORT_PRESETS[0];
}
