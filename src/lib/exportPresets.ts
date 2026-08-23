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

/** Resolution cap choices shown alongside a destination preset. `h` is a
 * height in pixels; null means "use the source's own resolution". These
 * only ever scale down — picking a cap taller than the source is a no-op. */
export const RESOLUTION_OPTIONS: { id: string; label: string; h: number | null }[] = [
  { id: "source", label: "Source", h: null },
  { id: "2160", label: "4K (2160p)", h: 2160 },
  { id: "1440", label: "1440p", h: 1440 },
  { id: "1080", label: "1080p", h: 1080 },
  { id: "720", label: "720p", h: 720 },
  { id: "480", label: "480p", h: 480 },
];

/** Resolves a preset + chosen resolution cap into the concrete targetW/
 * targetH/maxHeight to send in an ExportRequest. For a preset with forced
 * dimensions (e.g. the 9:16 vertical crop), the cap scales those dimensions
 * down proportionally instead of setting maxHeight (which the backend only
 * honors when there's no forced crop). Never upscales past the preset's own
 * (or the source's) resolution. */
export function resolveResolution(
  preset: ExportPreset,
  resolutionId: string
): { targetW: number | null; targetH: number | null; maxHeight: number | null } {
  const cap = RESOLUTION_OPTIONS.find((r) => r.id === resolutionId)?.h ?? null;
  if (preset.targetW && preset.targetH) {
    if (cap && cap < preset.targetH) {
      const targetH = cap;
      const targetW = Math.round((targetH * (preset.targetW / preset.targetH)) / 2) * 2;
      return { targetW, targetH, maxHeight: null };
    }
    return { targetW: preset.targetW, targetH: preset.targetH, maxHeight: null };
  }
  return { targetW: null, targetH: null, maxHeight: cap };
}
