import { useState } from "react";
import { useApp } from "../store";
import { buildAss } from "../lib/ass";
import { paginate, applyCensor, shiftPages, fmtTime } from "../lib/captions";
import { pickSavePath } from "../lib/tauri";
import { EXPORT_PRESETS as PRESETS } from "../lib/exportPresets";

export default function ExportDrawer() {
  const {
    videoPath,
    mediaInfo,
    segments,
    style,
    censor,
    activeRange,
    exportJob,
    exportDone,
    startExport,
    cancelJob,
  } = useApp();
  const [presetId, setPresetId] = useState("original");
  const [customMb, setCustomMb] = useState(25);
  const [burn, setBurn] = useState(true);

  const preset = PRESETS.find((p) => p.id === presetId)!;

  const go = async () => {
    if (!videoPath || !mediaInfo) return;
    const base = videoPath.replace(/\.[^./\\]+$/, "");
    const suffix = activeRange ? ".highlight.mp4" : ".captioned.mp4";
    const out = await pickSavePath(`${base}${suffix}`);
    if (!out) return;

    const outW = preset.targetW ?? mediaInfo.width;
    const outH = preset.targetH ?? mediaInfo.height;
    const segs = censor ? applyCensor(segments) : segments;
    let pages = paginate(segs, style.maxWordsPerPage);
    if (activeRange) {
      pages = shiftPages(
        pages.filter((p) => p.end > activeRange.start && p.start < activeRange.end),
        activeRange.start
      );
    }
    const ass = burn && pages.length ? buildAss(pages, style, { playResX: outW, playResY: outH }) : "";

    void startExport({
      inputPath: videoPath,
      outputPath: out,
      assContent: ass,
      targetW: preset.targetW,
      targetH: preset.targetH,
      targetSizeMb: preset.id === "custom" ? customMb : preset.targetSizeMB,
      crf: preset.crf,
      fps: preset.fps,
      audioKbps: preset.audioKbps,
      durationSec: mediaInfo.durationSec,
      trimStart: activeRange?.start ?? null,
      trimEnd: activeRange?.end ?? null,
    });
  };

  return (
    <div className="export-panel">
      <h4>Destination preset</h4>
      <div className="preset-list">
        {PRESETS.map((p) => (
          <label key={p.id} className={`preset-row ${presetId === p.id ? "sel" : ""}`}>
            <input
              type="radio"
              name="epreset"
              checked={presetId === p.id}
              onChange={() => setPresetId(p.id)}
            />
            <span>{p.name}</span>
          </label>
        ))}
      </div>

      {presetId === "custom" && (
        <div className="field">
          <label>Target size (MB)</label>
          <input
            type="number"
            min={1}
            max={2000}
            value={customMb}
            onChange={(e) => setCustomMb(Number(e.target.value))}
          />
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
              {exportJob.stage} {exportJob.progress >= 0 ? `${Math.round(exportJob.progress * 100)}%` : ""}
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
