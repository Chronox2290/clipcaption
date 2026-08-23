import { useRef, useState, type RefObject } from "react";
import { useApp } from "../store";
import { fmtTime } from "../lib/captions";
import { pickDirectory, pickSavePath } from "../lib/tauri";
import { EXPORT_PRESETS as PRESETS } from "../lib/exportPresets";
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
    activeRange,
    setActiveRange,
    selectedRanks,
    clipOverrides,
    editingRank,
    toggleHighlightSelected,
    selectAllHighlights,
    selectNoneHighlights,
    startEditingHighlight,
    stopEditingHighlight,
    adjustHighlightRange,
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
  // Tracks the timeupdate listener from the last preview, so a new preview
  // (or a different clip) doesn't leave an old one pausing the video early.
  const stopAtRef = useRef<{ end: number; handler: () => void } | null>(null);

  // Play + auto-stop at the clip's own end, instead of rolling into whatever
  // comes next in the source recording.
  const previewRange = (start: number, end: number) => {
    const v = videoRef.current;
    if (!v) return;
    if (stopAtRef.current) {
      v.removeEventListener("timeupdate", stopAtRef.current.handler);
      stopAtRef.current = null;
    }
    const handler = () => {
      if (v.currentTime >= end) {
        v.pause();
        v.removeEventListener("timeupdate", handler);
        if (stopAtRef.current?.handler === handler) stopAtRef.current = null;
      }
    };
    stopAtRef.current = { end, handler };
    v.addEventListener("timeupdate", handler);
    v.currentTime = start + 0.001;
    void v.play();
  };

  const exportSelected = async () => {
    const dir = await pickDirectory();
    if (dir) void exportSelectedHighlights(dir);
  };

  const compileSelected = async () => {
    if (!videoPath) return;
    const base = videoPath.replace(/\.[^./\\]+$/, "");
    const out = await pickSavePath(`${base}.highlight-reel.mp4`);
    if (out) void compileSelectedHighlights(out, presetId, customMb);
  };

  const rangeOf = (h: Highlight) => clipOverrides[h.rank] ?? { start: h.start, end: h.end };

  // "+" always makes the clip longer, "−" always makes it shorter — same
  // meaning on both the Start and End row, regardless of which direction
  // that actually moves the underlying timestamp.
  const nudge = (h: Highlight, field: "start" | "end", durationDelta: number) => {
    const r = rangeOf(h);
    const start = field === "start" ? r.start - durationDelta : r.start;
    const end = field === "end" ? r.end + durationDelta : r.end;
    adjustHighlightRange(h.rank, start, end);
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
              {analyzeJob.message ?? "analyzing"}…{" "}
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

  return (
    <div className="hl-panel">
      <div className="hl-head">
        <span className="muted small">
          {highlights.length} highlight{highlights.length === 1 ? "" : "s"} found ·{" "}
          {selectedRanks.length} selected
        </span>
        <div className="hl-head-actions">
          <button className="btn btn-ghost btn-small" onClick={selectAllHighlights}>
            All
          </button>
          <button className="btn btn-ghost btn-small" onClick={selectNoneHighlights}>
            None
          </button>
          <button className="btn btn-ghost btn-small" onClick={() => analyzeHighlights()}>
            ↻ Re-scan
          </button>
        </div>
      </div>

      <div className="hl-list">
        {highlights.map((h) => {
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
                <span className="hl-rank">#{h.rank}</span>
                <div className="hl-mid">
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
                  <div className="hl-nudge-row">
                    <span className="hl-nudge-label">Start</span>
                    <button className="btn btn-ghost btn-small" onClick={() => nudge(h, "start", -5)}>
                      −5s
                    </button>
                    <button className="btn btn-ghost btn-small" onClick={() => nudge(h, "start", -1)}>
                      −1s
                    </button>
                    <span className="hl-nudge-val">{fmtTime(range.start)}</span>
                    <button className="btn btn-ghost btn-small" onClick={() => nudge(h, "start", 1)}>
                      +1s
                    </button>
                    <button className="btn btn-ghost btn-small" onClick={() => nudge(h, "start", 5)}>
                      +5s
                    </button>
                  </div>
                  <div className="hl-nudge-row">
                    <span className="hl-nudge-label">End</span>
                    <button className="btn btn-ghost btn-small" onClick={() => nudge(h, "end", -5)}>
                      −5s
                    </button>
                    <button className="btn btn-ghost btn-small" onClick={() => nudge(h, "end", -1)}>
                      −1s
                    </button>
                    <span className="hl-nudge-val">{fmtTime(range.end)}</span>
                    <button className="btn btn-ghost btn-small" onClick={() => nudge(h, "end", 1)}>
                      +1s
                    </button>
                    <button className="btn btn-ghost btn-small" onClick={() => nudge(h, "end", 5)}>
                      +5s
                    </button>
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
                          {transcribeJob!.stage}…{" "}
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

      {mode === "separate" && !batch && (
        <button
          className="btn btn-primary btn-big"
          disabled={selectedRanks.length === 0}
          onClick={exportSelected}
        >
          ⚡ Caption + export selected ({selectedRanks.length})
        </button>
      )}

      {mode === "compile" && !batch && (
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
          <button
            className="btn btn-primary btn-big"
            disabled={selectedRanks.length === 0}
            onClick={compileSelected}
          >
            🎬 Compile {selectedRanks.length} clip{selectedRanks.length === 1 ? "" : "s"} into one
            file ({preset.name})
          </button>
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
            Clip {batch.current}/{batch.total} — {batch.stage}…
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
