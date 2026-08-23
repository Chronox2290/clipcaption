import type { RefObject } from "react";
import { useApp } from "../store";
import { fmtTime, isProfane } from "../lib/captions";

interface Props {
  videoRef: RefObject<HTMLVideoElement | null>;
}

export default function TranscriptPanel({ videoRef }: Props) {
  const segments = useApp((s) => s.segments);
  const updateWord = useApp((s) => s.updateWord);
  const censor = useApp((s) => s.censor);
  const setCensor = useApp((s) => s.setCensor);
  const transcribeJob = useApp((s) => s.transcribeJob);
  const transcribe = useApp((s) => s.transcribe);
  const models = useApp((s) => s.models);
  const selectedModel = useApp((s) => s.selectedModel);

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

  return (
    <div className="transcript">
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
                <input
                  key={i}
                  className={`word-input ${isProfane(w.text) ? "profane" : ""}`}
                  value={w.text}
                  size={Math.max(w.text.length, 1)}
                  onChange={(e) => updateWord(seg.id, i, e.target.value)}
                  onFocus={() => {
                    const v = videoRef.current;
                    if (v) v.currentTime = w.start + 0.001;
                  }}
                />
              ))}
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
