import type { ExportPreset } from "../types";

export const EXPORT_PRESETS: ExportPreset[] = [
  { id: "original", name: "Original quality", targetW: null, targetH: null, targetSizeMB: null, crf: 20, fps: null, audioKbps: 160 },
  { id: "vertical", name: "TikTok / Reels / Shorts (9:16 crop)", targetW: 1080, targetH: 1920, targetSizeMB: null, crf: 21, fps: 60, audioKbps: 160 },
  { id: "discord10", name: "Discord — fit 10 MB", targetW: null, targetH: null, targetSizeMB: 10, crf: null, fps: 30, audioKbps: 96 },
  { id: "discord50", name: "Discord Nitro Basic — fit 50 MB", targetW: null, targetH: null, targetSizeMB: 50, crf: null, fps: 60, audioKbps: 128 },
  { id: "custom", name: "Custom size…", targetW: null, targetH: null, targetSizeMB: 25, crf: null, fps: null, audioKbps: 128 },
];

export function getExportPreset(id: string): ExportPreset {
  return EXPORT_PRESETS.find((p) => p.id === id) ?? EXPORT_PRESETS[0];
}
