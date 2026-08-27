import { useState } from "react";
import { useApp } from "../store";
import { buildAss } from "../lib/ass";
import { paginate, applyCensor, shiftPages, layoutRows, fmtTime, capitalize } from "../lib/captions";
import { addEmojis } from "../lib/emojis";
import { pickSavePath } from "../lib/tauri";
import { EXPORT_PRESETS as PRESETS, RESOLUTION_OPTIONS, resolveResolution } from "../lib/exportPresets";
import EncodingOptions from "./EncodingOptions";

export default function ExportDrawer() {
  const {
    videoPath,
    mediaInfo,
    segments,
    style,
    censor,
    activeRange,
    selectedRanks,
    setEditorTab,
    exportJob,
    exportDone,
    startExport,
    cancelJob,
    fpsOverride,
    encoder,
    discordWebhook,
    setDiscordWebhook,
    autoPostToDiscord,
    setAutoPostToDiscord,
    discordJob,
    polishAvailable,
    generateMetadata,
    metadataJob,
    clipMetadata,
  } = useApp();
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const copy = (field: string, text: string) => {
    void navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField((f) => (f === field ? null : f)), 1500);
  };
  const [presetId, setPresetId] = useState("original");
  // Independent of which preset is picked - previously only the "custom"
  // preset (no forced resolution at all) could target a file size, so a
  // 9:16 crop for TikTok had no way to also fit Facebook's 25MB limit or a
  // Discord upload cap. Any preset's resolution/crop/fps now combines freely
  // with a size limit.
  const [sizeLimitEnabled, setSizeLimitEnabled] = useState(false);
  const [sizeLimitMb, setSizeLimitMb] = useState(25);
  const [burn, setBurn] = useState(true);
  const [resolutionId, setResolutionId] = useState("source");
  const [fitMode, setFitMode] = useState<"fill" | "fit">("fill");

  const preset = PRESETS.find((p) => p.id === presetId)!;
  const isCropped = !!(preset.targetW && preset.targetH);
  const { targetW, targetH, maxHeight } = resolveResolution(preset, resolutionId);

  const go = async () => {
    if (!videoPath || !mediaInfo) return;
    const base = videoPath.replace(/\.[^./\\]+$/, "");
    const suffix = activeRange ? ".highlight.mp4" : ".captioned.mp4";
    const out = await pickSavePath(`${base}${suffix}`);
    if (!out) return;

    const outW = targetW ?? mediaInfo.width;
    const outH = targetH ?? mediaInfo.height;
    let segs = censor ? applyCensor(segments) : segments;
    if (style.emojis) segs = addEmojis(segs);
    let pages = paginate(segs, style.maxWordsPerPage);
    if (activeRange) {
      pages = shiftPages(
        pages.filter((p) => p.end > activeRange.start && p.start < activeRange.end),
        activeRange.start
      );
    }
    pages = layoutRows(pages);
    const ass = burn && pages.length ? buildAss(pages, style, { playResX: outW, playResY: outH }) : "";

    void startExport({
      inputPath: videoPath,
      outputPath: out,
      assContent: ass,
      targetW,
      targetH,
      targetSizeMb: sizeLimitEnabled ? sizeLimitMb : null,
      crf: preset.crf,
      fps: fpsOverride ?? preset.fps,
      audioKbps: preset.audioKbps,
      durationSec: mediaInfo.durationSec,
      trimStart: activeRange?.start ?? null,
      trimEnd: activeRange?.end ?? null,
      cutRanges: null,
      encoder,
      fitMode: isCropped ? fitMode : null,
      maxHeight,
    });
  };

  return (
    <div className="export-panel">
      {/* This tab exports one thing: the whole video, or the selected range.
          Anyone with clips ticked comes here expecting to export THOSE - it's
          the obvious place - and finds no mention of them, because that lives
          at the bottom of the Highlights tab. Point at it rather than leaving
          people to conclude the feature doesn't exist. */}
      {selectedRanks.length > 0 && (
        <div className="export-redirect">
          <span>
            {selectedRanks.length} clip{selectedRanks.length === 1 ? " is" : "s are"} ticked.
            Export {selectedRanks.length === 1 ? "it" : "them"} as separate files, or joined into
            one video, from the Highlights tab.
          </span>
          <button className="btn btn-small btn-primary" onClick={() => setEditorTab("highlights")}>
            Go to Highlights
          </button>
        </div>
      )}
      <h4>Destination preset</h4>
      <div className="preset-list">
        {PRESETS.map((p) => (
          <label key={p.id} className={`preset-row ${presetId === p.id ? "sel" : ""}`}>
            <input
              type="radio"
              name="epreset"
              checked={presetId === p.id}
              onChange={() => {
                setPresetId(p.id);
                // Discord presets carry a known platform limit - prefill it
                // as a convenience. Doesn't touch the checkbox for a preset
                // with no inherent size (original/vertical/etc), so it never
                // fights a limit the user already turned on by hand.
                if (p.targetSizeMB != null) {
                  setSizeLimitEnabled(true);
                  setSizeLimitMb(p.targetSizeMB);
                }
              }}
            />
            <span>{p.name}</span>
          </label>
        ))}
      </div>

      <div className="field">
        <label title="Works with any preset above - e.g. TikTok's 9:16 crop capped to fit Facebook's 25MB upload limit, not just the Discord presets.">
          Limit file size
        </label>
        <input
          type="checkbox"
          checked={sizeLimitEnabled}
          onChange={(e) => setSizeLimitEnabled(e.target.checked)}
        />
        {sizeLimitEnabled && (
          <input
            type="number"
            min={1}
            max={2000}
            value={sizeLimitMb}
            onChange={(e) => setSizeLimitMb(Number(e.target.value))}
          />
        )}
        {sizeLimitEnabled && <span className="field-val">MB</span>}
      </div>

      <div className="field">
        <label>Resolution</label>
        <select value={resolutionId} onChange={(e) => setResolutionId(e.target.value)}>
          {RESOLUTION_OPTIONS.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </select>
      </div>

      {isCropped && (
        <div className="field">
          <label>Frame</label>
          <div className="seg-toggle">
            <button
              className={`seg-toggle-btn ${fitMode === "fill" ? "sel" : ""}`}
              title="Fill the frame edge-to-edge, cropping whatever doesn't fit"
              onClick={() => setFitMode("fill")}
            >
              Fill (crop)
            </button>
            <button
              className={`seg-toggle-btn ${fitMode === "fit" ? "sel" : ""}`}
              title="Show the whole frame, padded with a blurred zoomed copy instead of cropping"
              onClick={() => setFitMode("fit")}
            >
              Fit (show all)
            </button>
          </div>
        </div>
      )}

      {activeRange && (
        <div className="hl-active">
          Exporting range {fmtTime(activeRange.start)} – {fmtTime(activeRange.end)} (from the
          Highlights tab)
        </div>
      )}

      <label className="check-row">
        <input type="checkbox" checked={burn} onChange={(e) => setBurn(e.target.checked)} />
        <span>Burn captions into video {segments.length === 0 && "(no transcript yet)"}</span>
      </label>

      <h4>Encoding</h4>
      <EncodingOptions />

      <h4>Discord</h4>
      <div className="field">
        <label title="From a channel's Settings → Integrations → Webhooks. Paste it once - it's remembered.">
          Webhook URL
        </label>
        <input
          type="text"
          placeholder="https://discord.com/api/webhooks/…"
          value={discordWebhook}
          onChange={(e) => setDiscordWebhook(e.target.value)}
        />
      </div>
      {discordWebhook && (
        <label className="check-row">
          <input
            type="checkbox"
            checked={autoPostToDiscord}
            onChange={(e) => setAutoPostToDiscord(e.target.checked)}
          />
          <span>Post to Discord automatically when this export finishes</span>
        </label>
      )}
      {discordJob && (
        <p className="muted small">Posting to Discord…</p>
      )}

      {polishAvailable && segments.length > 0 && (
        <>
          <h4>Title, hook &amp; hashtags</h4>
          <button
            className="btn btn-small"
            onClick={() => void generateMetadata()}
            disabled={!!metadataJob}
          >
            {metadataJob ? "Generating…" : clipMetadata ? "Regenerate" : "✨ Generate from transcript"}
          </button>
          {clipMetadata && (
            <div className="metadata-result">
              <div className="metadata-row">
                <span className="metadata-label">Title</span>
                <span className="metadata-text">{clipMetadata.title}</span>
                <button className="btn btn-ghost btn-small" onClick={() => copy("title", clipMetadata.title)}>
                  {copiedField === "title" ? "Copied" : "Copy"}
                </button>
              </div>
              <div className="metadata-row">
                <span className="metadata-label">Hook</span>
                <span className="metadata-text">{clipMetadata.hook}</span>
                <button className="btn btn-ghost btn-small" onClick={() => copy("hook", clipMetadata.hook)}>
                  {copiedField === "hook" ? "Copied" : "Copy"}
                </button>
              </div>
              <div className="metadata-row">
                <span className="metadata-label">Hashtags</span>
                <span className="metadata-text">{clipMetadata.hashtags.join(" ")}</span>
                <button
                  className="btn btn-ghost btn-small"
                  onClick={() => copy("hashtags", clipMetadata.hashtags.join(" "))}
                >
                  {copiedField === "hashtags" ? "Copied" : "Copy"}
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {!exportJob && (
        <button className="btn btn-primary btn-big" onClick={go} disabled={!videoPath}>
          ⬇ Export
        </button>
      )}

      {exportJob && (
        <div className="progress-wrap">
          <div className="progress-bar">
            <div
              className="progress-fill"
              style={{ width: `${Math.max(0, exportJob.progress * 100)}%` }}
            />
          </div>
          <div className="progress-row">
            <span className="muted">
              {capitalize(exportJob.stage)} {exportJob.progress >= 0 ? `${Math.round(exportJob.progress * 100)}%` : ""}
            </span>
            <button className="btn btn-ghost btn-small" onClick={() => cancelJob(exportJob.id)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {exportDone && (
        <div className="export-done">
          ✔ Exported to
          <code>{exportDone}</code>
        </div>
      )}
    </div>
  );
}
