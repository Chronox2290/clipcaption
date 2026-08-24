import { useState, type RefObject } from "react";
import { useApp } from "../store";
import { fmtTime, isProfane } from "../lib/captions";
import { chronoPositions } from "../lib/highlights";
import WaveformEditor from "./WaveformEditor";

interface Props {
  videoRef: RefObject<HTMLVideoElement | null>;
}

export default function TranscriptPanel({ videoRef }: Props) {
  const segments = useApp((s) => s.segments);
  const updateWord = useApp((s) => s.updateWord);
  const insertWord = useApp((s) => s.insertWord);
  const removeWord = useApp((s) => s.removeWord);
  const setWordTime = useApp((s) => s.setWordTime);
  const censor = useApp((s) => s.censor);
  const setCensor = useApp((s) => s.setCensor);
  const transcribeJob = useApp((s) => s.transcribeJob);
  const transcribe = useApp((s) => s.transcribe);
  const models = useApp((s) => s.models);
  const selectedModel = useApp((s) => s.selectedModel);
  const transcriptSourceRank = useApp((s) => s.transcriptSourceRank);
  const highlights = useApp((s) => s.highlights);
  const clipOverrides = useApp((s) => s.clipOverrides);

  const [tuning, setTuning] = useState<{ segId: string; idx: number } | null>(null);

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
  const chrono = chronoPositions(highlights);
  const sourceClipNum = sourceHighlight ? chrono[sourceHighlight.rank] : null;

  const NUDGE = 0.1;
  const nudgeWord = (segId: string, idx: number, field: "start" | "end", delta: number) => {
    const w = segments.find((s) => s.id === segId)?.words[idx];
    if (w) setWordTime(segId, idx, field, w[field] + delta);
  };

  const syncWordToPlayhead = (segId: string, idx: number, field: "start" | "end") => {
    const v = videoRef.current;
    if (v) setWordTime(segId, idx, field, v.currentTime);
  };

  // Inserting/removing shifts every later index in the segment, so the
  // tuning panel (keyed by index) would silently start pointing at the
  // wrong word — safer to just close it and let the user re-open it.
  const doInsert = (segId: string, atIndex: number) => {
    insertWord(segId, atIndex);
    if (tuning?.segId === segId) setTuning(null);
  };
  const doRemove = (segId: string, idx: number) => {
    removeWord(segId, idx);
    if (tuning?.segId === segId) setTuning(null);
  };

  return (
    <div className="transcript">
      {transcriptSourceRank != null && (
        <div className="clip-divider">
          <span className="clip-badge">Clip #{sourceClipNum ?? "?"}</span>
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
      <p className="muted small">
        Click a word to jump the preview there. Drag a word directly on the waveform below it to
        retime it — drag an edge to move just that boundary, or the middle to shift the whole word.
      </p>
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
            <div className="seg-body">
              <div className="seg-words">
                <button
                  className="word-gap"
                  title="Insert a word here"
                  onClick={() => doInsert(seg.id, 0)}
                >
                  +
                </button>
                {seg.words.map((w, i) => (
                  <span key={i} className="word-unit">
                    <span className="word-box">
                      <input
                        className={`word-input ${isProfane(w.text) ? "profane" : ""} ${
                          tuning?.segId === seg.id && tuning.idx === i ? "tuning" : ""
                        }`}
                        value={w.text}
                        size={Math.max(w.text.length, 1)}
                        onChange={(e) => updateWord(seg.id, i, e.target.value)}
                        onBlur={(e) => {
                          if (e.target.value.trim() === "") doRemove(seg.id, i);
                        }}
                        onFocus={() => {
                          setTuning({ segId: seg.id, idx: i });
                          const v = videoRef.current;
                          if (v) v.currentTime = w.start + 0.001;
                        }}
                      />
                      <button
                        className="word-del"
                        title="Remove this word"
                        tabIndex={-1}
                        onClick={() => doRemove(seg.id, i)}
                      >
                        ×
                      </button>
                    </span>
                    <button
                      className="word-gap"
                      title="Insert a word here"
                      onClick={() => doInsert(seg.id, i + 1)}
                    >
                      +
                    </button>
                  </span>
                ))}
              </div>

              <WaveformEditor
                segId={seg.id}
                words={seg.words}
                activeIndex={tuning?.segId === seg.id ? tuning.idx : null}
                onSelectWord={(idx) => setTuning({ segId: seg.id, idx })}
                videoRef={videoRef}
              />

              {tuning?.segId === seg.id && seg.words[tuning.idx] && (
                <div className="word-tune">
                  <div className="word-tune-head">
                    <span className="muted small">Tuning “{seg.words[tuning.idx].text}” — drag it on the waveform, or nudge precisely:</span>
                    <button className="btn btn-ghost btn-small" onClick={() => setTuning(null)}>
                      Done
                    </button>
                  </div>
                  <div className="word-tune-row">
                    <span className="hl-nudge-label">Start</span>
                    <button className="btn btn-ghost btn-small" onClick={() => nudgeWord(seg.id, tuning.idx, "start", -NUDGE)}>
                      −0.1s
                    </button>
                    <span className="hl-nudge-val">{seg.words[tuning.idx].start.toFixed(2)}s</span>
                    <button className="btn btn-ghost btn-small" onClick={() => nudgeWord(seg.id, tuning.idx, "start", NUDGE)}>
                      +0.1s
                    </button>
                    <button className="btn btn-small" onClick={() => syncWordToPlayhead(seg.id, tuning.idx, "start")}>
                      📍 here
                    </button>
                  </div>
                  <div className="word-tune-row">
                    <span className="hl-nudge-label">End</span>
                    <button className="btn btn-ghost btn-small" onClick={() => nudgeWord(seg.id, tuning.idx, "end", -NUDGE)}>
                      −0.1s
                    </button>
                    <span className="hl-nudge-val">{seg.words[tuning.idx].end.toFixed(2)}s</span>
                    <button className="btn btn-ghost btn-small" onClick={() => nudgeWord(seg.id, tuning.idx, "end", NUDGE)}>
                      +0.1s
                    </button>
                    <button className="btn btn-small" onClick={() => syncWordToPlayhead(seg.id, tuning.idx, "end")}>
                      📍 here
                    </button>
                  </div>
                </div>
              )}
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
