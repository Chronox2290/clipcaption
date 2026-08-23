import type { RefObject } from "react";
import { useApp } from "../store";
import { fmtTime } from "../lib/captions";
import { pickDirectory } from "../lib/tauri";

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
    batch,
    processAllHighlights,
    cancelJob,
    transcribe,
    exportDone,
  } = useApp();

  const preview = (start: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = start + 0.001;
    void v.play();
  };

  const useRange = (start: number, end: number) => {
    setActiveRange({ start, end });
    const v = videoRef.current;
    if (v) v.currentTime = start + 0.001;
  };

  const exportAll = async () => {
    const dir = await pickDirectory();
    if (dir) void processAllHighlights(dir);
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
          {highlights.length} highlight{highlights.length === 1 ? "" : "s"} found
        </span>
        <button className="btn btn-ghost btn-small" onClick={() => analyzeHighlights()}>
          ↻ Re-scan
        </button>
      </div>

      <div className="hl-list">
        {highlights.map((h) => {
          const active =
            activeRange && Math.abs(activeRange.start - h.start) < 0.01 ? true : false;
          return (
            <div key={`${h.rank}-${h.start}`} className={`hl-row ${active ? "sel" : ""}`}>
              <span className="hl-rank">#{h.rank}</span>
              <div className="hl-mid">
                <div className="hl-times">
                  {fmtTime(h.start)} – {fmtTime(h.end)}
                  <span className="muted"> · {(h.end - h.start).toFixed(0)}s</span>
                </div>
                <div className="hl-score">
                  <div
                    className="hl-score-fill"
                    style={{ width: `${Math.max(8, (h.score / maxScore) * 100)}%` }}
                  />
                </div>
              </div>
              <button className="btn btn-ghost btn-small" title="Preview" onClick={() => preview(h.start)}>
                ▶
              </button>
              <button
                className="btn btn-small"
                title="Work on this clip: transcript + export apply to this range"
                onClick={() => useRange(h.start, h.end)}
              >
                Use
              </button>
            </div>
          );
        })}
      </div>

      {activeRange && (
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
        <button className="btn btn-primary btn-big" onClick={exportAll}>
          ⚡ Caption + export all {highlights.length} clips
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
