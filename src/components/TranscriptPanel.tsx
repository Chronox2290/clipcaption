import type { RefObject } from "react";
import { useApp } from "../store";
import { fmtTime, isProfane } from "../lib/captions";

interface Props {
  videoRef: RefObject<HTMLVideoElement | null>;
}

export default function TranscriptPanel({ videoRef }: Props) {
  const segments = useApp((s) => s.segments);
  const updateWord = useApp((s) => s.updateWord);
  const addWord = useApp((s) => s.addWord);
  const removeWord = useApp((s) => s.removeWord);
  const censor = useApp((s) => s.censor);
  const setCensor = useApp((s) => s.setCensor);
  const transcribeJob = useApp((s) => s.transcribeJob);
  const transcribe = useApp((s) => s.transcribe);
  const models = useApp((s) => s.models);
  const selectedModel = useApp((s) => s.selectedModel);
  const transcriptSourceRank = useApp((s) => s.transcriptSourceRank);
  const highlights = useApp((s) => s.highlights);
  const clipOverrides = useApp((s) => s.clipOverrides);

  const model = models.find((m) => m.name === selectedModel);

  if (transcribeJob) {
    return (
      <div className="panel-empty">
        <div className="spinner" />
        <p>
          {transcribeJob.stage === "extracting" && "Extracting audio…"}
          {transcribeJob.stage === "transcribing" &&
            `Transcribing… ${transcribeJob.progress >= 0 ? Math.round(transcribeJob.progress * 100) + "%" : ""}`}
          {!["extracting", "transcribing"].includes(transcribeJob.stage) && "Working…"}
        </p>
      </div>
    );
  }

  if (segments.length === 0) {
    return (
      <div className="panel-empty">
        <p className="muted">No transcript yet.</p>
        <button className="btn btn-primary" onClick={() => transcribe()} disabled={!model?.downloaded}>
          ✦ Auto-caption this clip
        </button>
        {!model?.downloaded && (
          <p className="muted small">
            Download the “{selectedModel}” model on the home screen first.
          </p>
        )}
      </div>
    );
  }

  const sourceHighlight = highlights.find((h) => h.rank === transcriptSourceRank);
  const sourceRange = sourceHighlight
    ? (clipOverrides[sourceHighlight.rank] ?? { start: sourceHighlight.start, end: sourceHighlight.end })
    : null;

  return (
    <div className="transcript">
      {transcriptSourceRank != null && (
        <div className="clip-divider">
          <span className="clip-badge">Clip #{transcriptSourceRank}</span>
          {sourceRange && (
            <span className="muted small">
              {fmtTime(sourceRange.start)} – {fmtTime(sourceRange.end)}
            </span>
          )}
        </div>
      )}
      <label className="check-row">
        <input type="checkbox" checked={censor} onChange={(e) => setCensor(e.target.checked)} />
        <span>Censor profanity (f***)</span>
      </label>
      <div className="transcript-list">
        {segments.map((seg) => (
          <div key={seg.id} className="seg">
            <button
              className="seg-time"
              onClick={() => {
                const v = videoRef.current;
                if (v && seg.words.length) v.currentTime = seg.words[0].start + 0.001;
              }}
            >
              {seg.words.length ? fmtTime(seg.words[0].start) : "–"}
            </button>
            <div className="seg-words">
              {seg.words.map((w, i) => (
                <div key={i} className="word-box">
                  <input
                    className={`word-input ${isProfane(w.text) ? "profane" : ""}`}
                    value={w.text}
                    size={Math.max(w.text.length, 1)}
                    onChange={(e) => updateWord(seg.id, i, e.target.value)}
                    onBlur={(e) => {
                      if (e.target.value.trim() === "") removeWord(seg.id, i);
                    }}
                    onFocus={() => {
                      const v = videoRef.current;
                      if (v) v.currentTime = w.start + 0.001;
                    }}
                  />
                  <button
                    className="word-del"
                    title="Remove this word"
                    tabIndex={-1}
                    onClick={() => removeWord(seg.id, i)}
                  >
                    ×
                  </button>
                </div>
              ))}
              <button className="btn btn-ghost btn-small word-add" onClick={() => addWord(seg.id)}>
                + word
              </button>
            </div>
          </div>
        ))}
      </div>
      <button className="btn btn-ghost" onClick={() => transcribe()}>
        ↻ Re-transcribe
      </button>
    </div>
  );
}
