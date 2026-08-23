import type { RefObject } from "react";
import { useApp } from "../store";
import { fmtTime } from "../lib/captions";
import { pickDirectory } from "../lib/tauri";
import type { Highlight } from "../types";

interface Props {
  videoRef: RefObject<HTMLVideoElement | null>;
}

export default function HighlightsPanel({ videoRef }: Props) {
  const {
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
    cancelJob,
    transcribe,
    exportDone,
  } = useApp();

  const duration = mediaInfo?.durationSec ?? Infinity;

  const preview = (start: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = start + 0.001;
    void v.play();
  };

  const exportSelected = async () => {
    const dir = await pickDirectory();
    if (dir) void exportSelectedHighlights(dir);
  };

  const rangeOf = (h: Highlight) => clipOverrides[h.rank] ?? { start: h.start, end: h.end };

  const nudge = (h: Highlight, field: "start" | "end", delta: number) => {
    const r = rangeOf(h);
    const next =
      field === "start" ? { start: r.start + delta, end: r.end } : { start: r.start, end: r.end + delta };
    adjustHighlightRange(h.rank, next.start, next.end);
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
          return (
            <div key={`${h.rank}-${h.start}`} className="hl-item">
              <div className={`hl-row ${isActive ? "sel" : ""}`}>
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
                  title="Preview: play from the start of this clip"
                  onClick={() => preview(range.start)}
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
                    <button className="btn btn-ghost btn-small" onClick={() => preview(range.start)}>
                      ▶ Preview
                    </button>
                    <button className="btn btn-small" onClick={() => transcribe()}>
                      ✦ Caption this range
                    </button>
                    <button className="btn btn-ghost btn-small" onClick={stopEditingHighlight}>
                      Done
                    </button>
                  </div>
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

      {!batch && (
        <button
          className="btn btn-primary btn-big"
          disabled={selectedRanks.length === 0}
          onClick={exportSelected}
        >
          ⚡ Caption + export selected ({selectedRanks.length})
        </button>
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
