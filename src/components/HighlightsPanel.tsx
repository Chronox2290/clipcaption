import { useState, type RefObject } from "react";
import { useApp, autoHighlightCount } from "../store";
import { fmtTime, capitalize } from "../lib/captions";
import { pickDirectory, pickSavePath } from "../lib/tauri";
import { EXPORT_PRESETS as PRESETS, RESOLUTION_OPTIONS, resolveResolution } from "../lib/exportPresets";
import { chronoPositions } from "../lib/highlights";
import TimeField from "./TimeField";
import type { Highlight } from "../types";

interface Props {
  videoRef: RefObject<HTMLVideoElement | null>;
}

export default function HighlightsPanel({ videoRef }: Props) {
  const {
    videoPath,
    mediaInfo,
    highlights,
    analyzeJob,
    analyzeHighlights,
    addBookmark,
    highlightCount,
    setHighlightCount,
    activeRange,
    setActiveRange,
    selectedRanks,
    clipOverrides,
    clipNames,
    editingRank,
    toggleHighlightSelected,
    selectAllHighlights,
    selectNoneHighlights,
    startEditingHighlight,
    stopEditingHighlight,
    adjustHighlightRange,
    setClipName,
    batch,
    exportSelectedHighlights,
    compileSelectedHighlights,
    cancelJob,
    transcribe,
    transcribeJob,
    segments,
    exportDone,
  } = useApp();

  const duration = mediaInfo?.durationSec ?? Infinity;
  const [cappedRank, setCappedRank] = useState<number | null>(null);
  const [mode, setMode] = useState<"separate" | "compile">("separate");
  const [presetId, setPresetId] = useState("original");
  const [customMb, setCustomMb] = useState(25);
  const [resolutionId, setResolutionId] = useState("source");
  const [fitMode, setFitMode] = useState<"fill" | "fit">("fill");
  const [sortMode, setSortMode] = useState<"time" | "hype">("time");

  // Preview a clip by making it the active range — Editor's own playback
  // effect then loops at activeRange.end instead of rolling into whatever
  // comes next in the source video, so this really does "replay the clip"
  // no matter how playback is triggered afterward (transport button, or
  // clicking the video frame itself).
  const previewRange = (start: number, end: number) => {
    setActiveRange({ start, end });
    const v = videoRef.current;
    if (v) {
      v.currentTime = start + 0.001;
      void v.play();
    }
  };

  const exportSelected = async () => {
    const dir = await pickDirectory();
    if (dir) void exportSelectedHighlights(dir, presetId, customMb, resolutionId, fitMode);
  };

  const compileSelected = async () => {
    if (!videoPath) return;
    const base = videoPath.replace(/\.[^./\\]+$/, "");
    const out = await pickSavePath(`${base}.highlight-reel.mp4`);
    if (out) void compileSelectedHighlights(out, presetId, customMb, resolutionId, fitMode);
  };

  const rangeOf = (h: Highlight) => clipOverrides[h.rank] ?? { start: h.start, end: h.end };

  const setEdgeFromPlayhead = (h: Highlight, field: "start" | "end") => {
    const v = videoRef.current;
    if (!v) return;
    const r = rangeOf(h);
    const t = v.currentTime;
    adjustHighlightRange(
      h.rank,
      field === "start" ? Math.min(t, r.end - 0.2) : r.start,
      field === "end" ? Math.max(t, r.start + 0.2) : r.end
    );
  };

  const captionThisRange = (h: Highlight) => {
    setCappedRank(h.rank);
    void transcribe();
  };

  const maxScore = highlights.reduce((m, h) => Math.max(m, h.score), 0.0001);
  const isLong = (mediaInfo?.durationSec ?? 0) > 300;

  if (analyzeJob) {
    return (
      <div className="panel-empty">
        <div className="progress-wrap" style={{ width: "100%" }}>
          <div className="progress-bar">
            <div
              className="progress-fill"
              style={{ width: `${Math.max(0, analyzeJob.progress * 100)}%` }}
            />
          </div>
          <div className="progress-row">
            <span className="muted">
              {capitalize(analyzeJob.message ?? "analyzing")}…{" "}
              {analyzeJob.progress >= 0 ? `${Math.round(analyzeJob.progress * 100)}%` : ""}
            </span>
            <button className="btn btn-ghost btn-small" onClick={() => cancelJob(analyzeJob.id)}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (highlights.length === 0) {
    return (
      <div className="panel-empty">
        <p className="muted">
          Scans the whole recording's audio for excitement — shouting, sustained
          hype, clutch moments — and proposes ready-to-cut clips.
          {isLong ? "" : " Works best on longer recordings (streams, full sessions)."}
        </p>
        <button className="btn btn-primary" onClick={() => analyzeHighlights()}>
          ⚡ Find highlights
        </button>
      </div>
    );
  }

  const preset = PRESETS.find((p) => p.id === presetId)!;
  const isCropped = !!(preset.targetW && preset.targetH);
  const chrono = chronoPositions(highlights);
  const sortedHighlights = [...highlights].sort((a, b) =>
    sortMode === "time" ? a.start - b.start : b.score - a.score
  );

  return (
    <div className="hl-panel">
      <div className="hl-head">
        <div className="hl-head-row">
          <span className="muted small">
            {highlights.length} highlight{highlights.length === 1 ? "" : "s"} ·{" "}
            {selectedRanks.length} selected
          </span>
          <div className="hl-sort-toggle">
            <button
              className={`btn btn-small ${sortMode === "time" ? "btn-primary" : "btn-ghost"}`}
              title="List clips in the order they happen in the recording"
              onClick={() => setSortMode("time")}
            >
              Time
            </button>
            <button
              className={`btn btn-small ${sortMode === "hype" ? "btn-primary" : "btn-ghost"}`}
              title="List clips most-exciting first"
              onClick={() => setSortMode("hype")}
            >
              🔥 Hype
            </button>
          </div>
        </div>
        <div className="hl-head-actions">
          <button className="btn btn-ghost btn-small" onClick={selectAllHighlights}>
            Select all
          </button>
          <button className="btn btn-ghost btn-small" onClick={selectNoneHighlights}>
            Select none
          </button>
          <button
            className="btn btn-ghost btn-small"
            title="Mark a clip around where the video is paused — for the moments the loudness scan won't find"
            onClick={() => {
              const v = videoRef.current;
              if (v) addBookmark(v.currentTime);
            }}
          >
            ＋ Mark here
          </button>
          <button className="btn btn-ghost btn-small" onClick={() => analyzeHighlights()}>
            ↻ Re-scan
          </button>
          <label className="hl-count" title="How many clips a scan may return. Auto scales with the length of the recording.">
            <span className="muted small">Find</span>
            <select
              value={highlightCount == null ? "auto" : String(highlightCount)}
              onChange={(e) =>
                setHighlightCount(e.target.value === "auto" ? null : Number(e.target.value))
              }
            >
              <option value="auto">
                auto ({autoHighlightCount(null, mediaInfo?.durationSec)})
              </option>
              {[12, 25, 40, 60, 100].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        </div>
        {sortMode === "hype" && (
          <p className="muted small">
            Sorted most-exciting first — the Clip # is its position in the recording, not this
            order.
          </p>
        )}
      </div>

      <div className="hl-list">
        {sortedHighlights.map((h) => {
          const range = rangeOf(h);
          const isAdjusted = !!clipOverrides[h.rank];
          const isEditing = editingRank === h.rank;
          const isSelected = selectedRanks.includes(h.rank);
          const isActive = activeRange && Math.abs(activeRange.start - range.start) < 0.01;
          const capturing = isEditing && cappedRank === h.rank && !!transcribeJob;
          const captured = isEditing && cappedRank === h.rank && !transcribeJob && segments.length > 0;
          return (
            <div key={`${h.rank}-${h.start}`} className="hl-item">
              <div className={`hl-row ${isActive ? "sel" : ""} ${isSelected ? "picked" : ""}`}>
                <input
                  type="checkbox"
                  className="hl-check"
                  checked={isSelected}
                  onChange={() => toggleHighlightSelected(h.rank)}
                  title="Include in export"
                />
                <span className="hl-rank">
                  Clip #{chrono[h.rank]}
                  {h.manual ? (
                    <span className="hl-manual-tag" title="You marked this clip by hand">
                      {" "}
                      · 📌
                    </span>
                  ) : (
                    sortMode === "hype" && <span className="hl-hype-tag"> · 🔥{h.rank}</span>
                  )}
                </span>
                <div className="hl-mid">
                  <input
                    className="hl-name-input"
                    value={clipNames[h.rank] ?? ""}
                    placeholder={`Clip ${chrono[h.rank]} (name it, or keep the default filename)`}
                    title="Custom name — used as the exported file's name"
                    onChange={(e) => setClipName(h.rank, e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                  />
                  <div className="hl-times">
                    {fmtTime(range.start)} – {fmtTime(range.end)}
                    <span className="muted"> · {(range.end - range.start).toFixed(0)}s</span>
                    {isAdjusted && <span className="hl-adjusted"> · trimmed</span>}
                  </div>
                  <div className="hl-score">
                    <div
                      className="hl-score-fill"
                      style={{ width: `${Math.max(8, (h.score / maxScore) * 100)}%` }}
                    />
                  </div>
                </div>
                <button
                  className="btn btn-ghost btn-small"
                  title="Preview: play just this clip, stops at its end"
                  onClick={() => previewRange(range.start, range.end)}
                >
                  ▶ Play
                </button>
                <button
                  className={`btn btn-small ${isEditing ? "btn-primary" : ""}`}
                  title="Extend or trim this clip's start/end, then caption it"
                  onClick={() => (isEditing ? stopEditingHighlight() : startEditingHighlight(h))}
                >
                  {isEditing ? "Editing…" : "Edit"}
                </button>
              </div>

              {isEditing && (
                <div className="hl-edit">
                  <div className="range-grid">
                    <span className="hl-nudge-label">Start</span>
                    <TimeField
                      value={range.start}
                      min={0}
                      max={range.end - 0.2}
                      title="Type a time like 29:02.4 and press Enter"
                      onCommit={(t) => adjustHighlightRange(h.rank, t, range.end)}
                    >
                      <button
                        className="btn btn-ghost btn-small"
                        title="Set to where the video is paused"
                        onClick={() => setEdgeFromPlayhead(h, "start")}
                      >
                        📍
                      </button>
                    </TimeField>
                    <span className="hl-nudge-label">End</span>
                    <TimeField
                      value={range.end}
                      min={range.start + 0.2}
                      max={duration}
                      title="Type a time like 29:16.0 and press Enter"
                      onCommit={(t) => adjustHighlightRange(h.rank, range.start, t)}
                    >
                      <button
                        className="btn btn-ghost btn-small"
                        title="Set to where the video is paused"
                        onClick={() => setEdgeFromPlayhead(h, "end")}
                      >
                        📍
                      </button>
                    </TimeField>
                  </div>
                  <div className="hl-edit-actions">
                    <span className="muted small">
                      Duration: {(range.end - range.start).toFixed(1)}s
                      {range.start <= 0 || range.end >= duration ? " · clamped to clip bounds" : ""}
                    </span>
                    <button
                      className="btn btn-ghost btn-small"
                      onClick={() => previewRange(range.start, range.end)}
                    >
                      ▶ Preview
                    </button>
                    <button className="btn btn-small" onClick={() => captionThisRange(h)}>
                      ✦ Caption this range
                    </button>
                    <button className="btn btn-ghost btn-small" onClick={stopEditingHighlight}>
                      Done
                    </button>
                  </div>
                  {capturing && (
                    <div className="hl-cap-status">
                      <div className="progress-wrap" style={{ width: "100%" }}>
                        <div className="progress-bar">
                          <div
                            className="progress-fill"
                            style={{ width: `${Math.max(0, transcribeJob!.progress * 100)}%` }}
                          />
                        </div>
                        <span className="muted small">
                          {capitalize(transcribeJob!.stage)}…{" "}
                          {transcribeJob!.progress >= 0
                            ? `${Math.round(transcribeJob!.progress * 100)}%`
                            : ""}
                        </span>
                      </div>
                    </div>
                  )}
                  {captured && (
                    <div className="hl-cap-status ok">
                      ✓ Captioned — {segments.reduce((n, s) => n + s.words.length, 0)} words. Open
                      the Transcript tab to review, or it's used automatically on export.
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {activeRange && !editingRank && (
        <div className="hl-active">
          Working range: {fmtTime(activeRange.start)} – {fmtTime(activeRange.end)}
          <button className="btn btn-ghost btn-small" onClick={() => setActiveRange(null)}>
            ✕ clear
          </button>
          <button className="btn btn-small" onClick={() => transcribe()}>
            ✦ Caption this range
          </button>
        </div>
      )}

      <div className="hl-mode-toggle">
        <button
          className={`btn btn-small ${mode === "separate" ? "btn-primary" : "btn-ghost"}`}
          onClick={() => setMode("separate")}
        >
          Separate files
        </button>
        <button
          className={`btn btn-small ${mode === "compile" ? "btn-primary" : "btn-ghost"}`}
          onClick={() => setMode("compile")}
        >
          One combined file
        </button>
      </div>

      {!batch && (
        <div className="hl-compile">
          <div className="preset-list">
            {PRESETS.map((p) => (
              <label key={p.id} className={`preset-row ${presetId === p.id ? "sel" : ""}`}>
                <input
                  type="radio"
                  name="hlpreset"
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

          {mode === "separate" && (
            <button
              className="btn btn-primary btn-big"
              disabled={selectedRanks.length === 0}
              onClick={exportSelected}
            >
              ⚡ Caption + export selected ({selectedRanks.length})
            </button>
          )}

          {mode === "compile" && (
            <button
              className="btn btn-primary btn-big"
              disabled={selectedRanks.length === 0}
              onClick={compileSelected}
            >
              🎬 Compile {selectedRanks.length} clip{selectedRanks.length === 1 ? "" : "s"} into one
              file ({preset.name})
            </button>
          )}
        </div>
      )}

      {batch && (
        <div className="progress-wrap">
          <div className="progress-bar">
            <div
              className="progress-fill"
              style={{
                width: `${((batch.current - 1) / batch.total) * 100 + (batch.stage === "exporting" ? 50 / batch.total : 25 / batch.total)}%`,
              }}
            />
          </div>
          <span className="muted">
            Clip {batch.current}/{batch.total} — {capitalize(batch.stage)}…
          </span>
        </div>
      )}

      {exportDone && !batch && (
        <div className="export-done">
          ✔ Saved to
          <code>{exportDone}</code>
        </div>
      )}
    </div>
  );
}
