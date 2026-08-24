import { useEffect, useRef, useState, type RefObject } from "react";
import { useApp } from "../store";
import TimeField from "./TimeField";
import { fmtTime, isProfane, isUnsure, resolveSpeakerNames, speakerLetter } from "../lib/captions";
import { chronoPositions } from "../lib/highlights";

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
  const style = useApp((s) => s.style);
  const tuning = useApp((s) => s.tuningWord);
  const setTuning = useApp((s) => s.setTuningWord);
  const speakerCount = useApp((s) => s.speakerCount);
  const setSpeakerCount = useApp((s) => s.setSpeakerCount);
  const speakerEmbeddings = useApp((s) => s.speakerEmbeddings);
  const speakerProfiles = useApp((s) => s.speakerProfiles);
  const setSpeakerName = useApp((s) => s.setSpeakerName);

  const model = models.find((m) => m.name === selectedModel);

  // Deleting a run of consecutive bad words by hunting down a tiny × that
  // lands in a different spot on every word (boxes are only as wide as their
  // text) was the actual complaint here — so Ctrl/Cmd+Backspace (or plain
  // Backspace on an already-empty box) deletes the word AND moves focus to
  // the previous one, so a run of garbage words can be cleared by holding
  // one key combo and tapping repeatedly without re-aiming the mouse at all.
  const wordRefs = useRef(new Map<string, HTMLInputElement>());
  const [focusKey, setFocusKey] = useState<string | null>(null);
  useEffect(() => {
    if (!focusKey) return;
    const el = wordRefs.current.get(focusKey);
    if (el) {
      el.focus();
      el.select();
    }
    setFocusKey(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey, segments]);

  if (transcribeJob) {
    const pct = transcribeJob.progress >= 0 ? Math.round(transcribeJob.progress * 100) : null;
    return (
      <div className="panel-empty">
        <div className="progress-wrap" style={{ width: "80%", maxWidth: 320 }}>
          <div className="progress-bar">
            <div
              className={`progress-fill ${pct === null ? "indeterminate" : ""}`}
              style={pct === null ? undefined : { width: `${pct}%` }}
            />
          </div>
          <p className="muted" style={{ textAlign: "center" }}>
            {transcribeJob.stage === "extracting" && "Extracting audio…"}
            {transcribeJob.stage === "transcribing" &&
              `Transcribing…${pct !== null ? ` ${pct}%` : ""}`}
            {!["extracting", "transcribing"].includes(transcribeJob.stage) && "Working…"}
          </p>
        </div>
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

  const distinctSpeakers = [
    ...new Set(segments.map((s) => s.speaker).filter((s): s is number => s != null)),
  ].sort((a, b) => a - b);
  const resolvedSpeakerNames = resolveSpeakerNames(speakerEmbeddings, speakerProfiles);

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
      <div className="speakers-panel">
        <label className="speaker-count">
          <span className="muted small">People talking in this recording</span>
          <select
            value={speakerCount == null ? "auto" : String(speakerCount)}
            onChange={(e) =>
              setSpeakerCount(e.target.value === "auto" ? null : Number(e.target.value))
            }
            title="Telling it how many voices there are beats letting it guess. On a real three-player clip, guessing produced six speakers - one person split across several - while asking for three got it right. Applies next time you transcribe."
          >
            <option value="auto">Work it out</option>
            {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
              <option key={n} value={n}>
                {n} {n === 1 ? "person" : "people"}
              </option>
            ))}
          </select>
        </label>
      </div>
      {distinctSpeakers.length > 0 && (
        <div className="speakers-panel">
          <p className="muted small" style={{ marginBottom: 4 }}>
            Speakers in this clip — name one and it'll follow that voice into exports and
            batch runs too, not just show up here.
          </p>
          <div className="speakers-list">
            {distinctSpeakers.map((idx) => {
              const hasEmbedding = Boolean(speakerEmbeddings[String(idx)]);
              return (
                <div key={idx} className="speaker-row">
                  <span
                    className="speaker-dot"
                    style={{ background: style.speakerColors[idx % style.speakerColors.length] }}
                  />
                  <input
                    className="speaker-name-input"
                    value={resolvedSpeakerNames[idx] ?? ""}
                    placeholder={
                      hasEmbedding
                        ? `Speaker ${speakerLetter(idx)} (name it, e.g. Alex)`
                        : `Speaker ${speakerLetter(idx)} (too short to identify — can't be named)`
                    }
                    title={
                      hasEmbedding
                        ? "Naming this speaker matches their voice, not just this run's index"
                        : "This speaker's lines were too brief to fingerprint their voice"
                    }
                    disabled={!hasEmbedding}
                    onChange={(e) => setSpeakerName(idx, e.target.value)}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}
      <label className="check-row">
        <input type="checkbox" checked={censor} onChange={(e) => setCensor(e.target.checked)} />
        <span>Censor profanity (f***)</span>
      </label>
      <p className="muted small">
        Click a word to jump the preview there and select it for fine-tuning. Drag its timing on
        the big waveform below the video — that's also where you can drag on an empty stretch to
        add a line whisper missed entirely. To clear out a run of bad words fast: click the first
        one, then hold <kbd>Ctrl</kbd>+<kbd>Backspace</kbd> and tap it repeatedly — no need to
        re-aim at the little × each time.
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
              {seg.speaker != null && (
                <span
                  className="speaker-dot"
                  title={resolvedSpeakerNames[seg.speaker] ?? `Speaker ${speakerLetter(seg.speaker)}`}
                  style={{
                    background: style.speakerColors[seg.speaker % style.speakerColors.length],
                  }}
                />
              )}
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
                        ref={(el) => {
                          const key = `${seg.id}:${i}`;
                          if (el) wordRefs.current.set(key, el);
                          else wordRefs.current.delete(key);
                        }}
                        className={`word-input ${isProfane(w.text) ? "profane" : ""} ${
                          tuning?.segId === seg.id && tuning.idx === i ? "tuning" : ""
                        } ${isUnsure(w) ? "unsure" : ""}`}
                        title={
                          isUnsure(w)
                            ? `Whisper wasn't sure about this word (${Math.round((w.confidence ?? 0) * 100)}%)`
                            : undefined
                        }
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
                        onKeyDown={(e) => {
                          const wholeWord = (e.key === "Backspace" || e.key === "Delete") && (e.ctrlKey || e.metaKey);
                          const emptyBackspace = e.key === "Backspace" && e.currentTarget.value === "";
                          if (!wholeWord && !emptyBackspace) return;
                          e.preventDefault();
                          const nextKey =
                            i > 0 ? `${seg.id}:${i - 1}` : seg.words.length > 1 ? `${seg.id}:0` : null;
                          doRemove(seg.id, i);
                          setFocusKey(nextKey);
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

              {tuning?.segId === seg.id && seg.words[tuning.idx] && (
                <div className="word-tune">
                  <div className="word-tune-head">
                    <span className="muted small">Tuning “{seg.words[tuning.idx].text}” — drag it on the waveform, or type exact times:</span>
                    <button className="btn btn-ghost btn-small" onClick={() => setTuning(null)}>
                      Done
                    </button>
                  </div>
                  <div className="range-grid">
                    <span className="hl-nudge-label">Start</span>
                    <TimeField
                      value={seg.words[tuning.idx].start}
                      min={0}
                      max={seg.words[tuning.idx].end - 0.02}
                      title="Type a time like 29:08.4 and press Enter"
                      onCommit={(t) => setWordTime(seg.id, tuning.idx, "start", t)}
                    >
                      <button
                        className="btn btn-ghost btn-small"
                        title="Set to where the video is paused"
                        onClick={() => syncWordToPlayhead(seg.id, tuning.idx, "start")}
                      >
                        📍
                      </button>
                    </TimeField>
                    <span className="hl-nudge-label">End</span>
                    <TimeField
                      value={seg.words[tuning.idx].end}
                      min={seg.words[tuning.idx].start + 0.02}
                      title="Type a time like 29:09.1 and press Enter"
                      onCommit={(t) => setWordTime(seg.id, tuning.idx, "end", t)}
                    >
                      <button
                        className="btn btn-ghost btn-small"
                        title="Set to where the video is paused"
                        onClick={() => syncWordToPlayhead(seg.id, tuning.idx, "end")}
                      >
                        📍
                      </button>
                    </TimeField>
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
