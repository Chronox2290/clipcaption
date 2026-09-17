import { Icon, type IconName } from "./Icon";
import { RESOLUTION_OPTIONS } from "../lib/exportPresets";

/** Replaces the vertical 6-7 radio-button "SKU inventory" (Discord Free,
 * Discord Nitro Basic, Discord Lv3, ...) that used to be hand-rolled
 * separately in BatchScreen/Montage/ExportDrawer with one platform-first
 * tile picker, shared across all three. A creator thinks "this is going to
 * Discord" or "this is for TikTok" - not "I need a 50MB target with CRF
 * unset and 128kbps audio". The MB/CRF mechanics stay exactly the same
 * underneath (this is a UI layer over the existing EXPORT_PRESETS ids in
 * lib/exportPresets.ts, not a new data model - every call site still ends
 * up with the same presetId/customMb/resolutionId/fitMode it always did,
 * so nothing about the actual export pipeline changes).
 *
 * Progressive disclosure: picking Discord reveals a tier pill row instead
 * of showing all four tiers' worth of MB numbers up front; picking TikTok/
 * Reels reveals the framing mode (Fill/Fit/Auto-track) instead of a
 * separate always-visible "Frame" field.
 */

export type FitMode = "fill" | "fit" | "track";
type Platform = "discord" | "vertical" | "original" | "custom";

const DISCORD_TIERS: { id: string; label: string; sub: string }[] = [
  { id: "discord20", label: "Free", sub: "20 MB" },
  { id: "discord50", label: "Nitro Basic", sub: "50 MB" },
  { id: "discord100", label: "Boosted", sub: "100 MB" },
  { id: "discord500", label: "Nitro Max", sub: "500 MB" },
];

const TILES: { platform: Platform; icon: IconName; title: string; badge: string; defaultPreset: string }[] = [
  { platform: "discord", icon: "discord", title: "Discord", badge: "Fit file size cap", defaultPreset: "discord50" },
  { platform: "vertical", icon: "phone", title: "TikTok / Reels / Shorts", badge: "9:16 vertical crop", defaultPreset: "vertical" },
  { platform: "original", icon: "film", title: "Original master", badge: "Source res · CRF 20", defaultPreset: "original" },
  { platform: "custom", icon: "sliders", title: "Custom size…", badge: "Manual MB limit", defaultPreset: "custom" },
];

function platformForPreset(presetId: string): Platform {
  if (presetId.startsWith("discord")) return "discord";
  if (presetId === "vertical") return "vertical";
  if (presetId === "custom") return "custom";
  return "original";
}

export interface DestinationControlProps {
  presetId: string;
  customMb: number;
  resolutionId: string;
  fitMode: FitMode;
  onPresetChange: (id: string) => void;
  onCustomMbChange: (mb: number) => void;
  onResolutionChange: (id: string) => void;
  onFitModeChange: (mode: FitMode) => void;
  /** "cap" (default): a downscale ceiling on the source's own resolution -
   * what Batch/Export use. "uniform": a fixed output resolution every clip
   * gets rendered to regardless of its own source size - what Montage needs
   * so clips from different sessions actually join into one file. Only
   * changes the field's label; the value/options are the same either way. */
  resolutionMode?: "cap" | "uniform";
  /** ExportDrawer alone has a separate "combine a size limit with ANY
   * preset" checkbox (its own targetSizeMb mechanism, richer than Batch/
   * Montage's "custom platform only" model) - it supplies its own MB input
   * for that via `children`, so this suppresses this component's inline one
   * to avoid showing the same number in two fields at once. */
  hideCustomInput?: boolean;
  /** Montage historically had no "custom" preset at all - its own separate
   * "combine a size limit" checkbox (via `children`, same mechanism as
   * ExportDrawer's) already covers that case for the joined output, and a
   * per-clip custom target never meant anything there. Default true. */
  allowCustom?: boolean;
  /** Extra call-site-specific controls (encoding block, save-to, burn-
   * captions toggle, ...) rendered after the platform/tier controls. */
  children?: React.ReactNode;
}

export default function DestinationControl({
  presetId,
  customMb,
  resolutionId,
  fitMode,
  onPresetChange,
  onCustomMbChange,
  onResolutionChange,
  onFitModeChange,
  resolutionMode = "cap",
  hideCustomInput = false,
  allowCustom = true,
  children,
}: DestinationControlProps) {
  const platform = platformForPreset(presetId);
  const isVertical = platform === "vertical";
  const tiles = allowCustom ? TILES : TILES.filter((t) => t.platform !== "custom");

  return (
    <div className="dest-control">
      <h4>Destination platform</h4>
      <div className="dest-tiles">
        {tiles.map((t) => (
          <button
            key={t.platform}
            type="button"
            className={`dest-tile ${platform === t.platform ? "sel" : ""}`}
            onClick={() => onPresetChange(t.defaultPreset)}
          >
            <Icon name={t.icon} size={20} />
            <span className="dest-tile-title">{t.title}</span>
            <span className="dest-tile-badge">{t.badge}</span>
          </button>
        ))}
      </div>

      {platform === "discord" && (
        <div className="field">
          <label>Discord upload cap</label>
          <div className="seg-toggle dest-discord-tiers">
            {DISCORD_TIERS.map((tier) => (
              <button
                key={tier.id}
                type="button"
                className={`seg-toggle-btn ${presetId === tier.id ? "sel" : ""}`}
                onClick={() => onPresetChange(tier.id)}
              >
                {tier.label} <span className="muted small">({tier.sub})</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {isVertical && (
        <div className="field">
          <label>Frame</label>
          <div className="seg-toggle">
            <button
              type="button"
              className={`seg-toggle-btn ${fitMode === "fill" ? "sel" : ""}`}
              title="Fill the frame edge-to-edge, cropping whatever doesn't fit"
              onClick={() => onFitModeChange("fill")}
            >
              Fill (crop)
            </button>
            <button
              type="button"
              className={`seg-toggle-btn ${fitMode === "fit" ? "sel" : ""}`}
              title="Show the whole frame, padded with a blurred zoomed copy instead of cropping"
              onClick={() => onFitModeChange("fit")}
            >
              Fit (show all)
            </button>
            <button
              type="button"
              className={`seg-toggle-btn ${fitMode === "track" ? "sel" : ""}`}
              title="Smart auto-reframe: tracks where the on-screen motion actually is and pans the crop to follow it, instead of a fixed center-crop. Motion-based, not face/object tracking - works best when the action is clearly the biggest moving thing in frame."
              onClick={() => onFitModeChange("track")}
            >
              <Icon name="sparkle" size={13} /> Auto-track
            </button>
          </div>
        </div>
      )}

      {platform === "custom" && !hideCustomInput && (
        <div className="field">
          <label>Target size (MB)</label>
          <input
            type="number"
            min={1}
            max={2000}
            value={customMb}
            onChange={(e) => onCustomMbChange(Number(e.target.value))}
          />
        </div>
      )}

      <div className="field">
        <label>{resolutionMode === "uniform" ? "Output resolution" : "Resolution"}</label>
        <select value={resolutionId} onChange={(e) => onResolutionChange(e.target.value)}>
          {RESOLUTION_OPTIONS.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </select>
      </div>

      {children}
    </div>
  );
}
