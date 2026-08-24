import { useEffect, useRef, useState } from "react";
import { useApp } from "../store";
import CaptionOverlay from "../components/CaptionOverlay";
import TranscriptPanel from "../components/TranscriptPanel";
import StylePanel from "../components/StylePanel";
import ExportDrawer from "../components/ExportDrawer";
import HighlightsPanel from "../components/HighlightsPanel";
import { fmtTime } from "../lib/captions";

type Tab = "transcript" | "highlights" | "style" | "export";

export default function Editor() {
  const {
    videoPath,
    previewSrc,
    mediaInfo,
    segments,
    style,
    censor,
    closeVideo,
    activeRange,
    projectPath,
    saveProject,
    saveProjectAs,
  } = useApp();
  const [savedFlash, setSavedFlash] = useState(false);
  const doSave = async () => {
    const ok = await saveProject();
    if (ok) {
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1800);
    }
  };
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [tab, setTab] = useState<Tab>("transcript");
  const [stage, setStage] = useState({ w: 0, h: 0 });
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);

  // Compute the actual displayed video rect (object-fit: contain math)
  useEffect(() => {
    const el = frameRef.current;
    if (!el || !mediaInfo) return;
    const compute = () => {
      const box = el.getBoundingClientRect();
      const ar = mediaInfo.width / mediaInfo.height;
      let w = box.width;
      let h = w / ar;
      if (h > box.height) {
        h = box.height;
        w = h * ar;
      }
      setStage({ w, h });
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [mediaInfo]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onTime = () => {
      // While a highlight's range is active, loop playback at its end
      // instead of rolling into whatever comes next in the source video —
      // this is what actually makes Play "replay the selected clip".
      if (activeRange && v.currentTime >= activeRange.end) {
        v.currentTime = activeRange.start;
      }
      setTime(v.currentTime);
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    return () => {
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
    };
  }, [previewSrc, activeRange]);

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play();
    else v.pause();
  };

  // Space/arrow-key transport, ignored while typing in a text field, word
  // box, or number input so it never hijacks normal editing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (el as HTMLElement)?.isContentEditable) {
        return;
      }
      const v = videoRef.current;
      if (!v) return;
      if (e.code === "Space") {
        e.preventDefault();
        togglePlay();
      } else if (e.code === "ArrowLeft") {
        e.preventDefault();
        v.currentTime = Math.max(0, v.currentTime - (e.shiftKey ? 1 : 5));
      } else if (e.code === "ArrowRight") {
        e.preventDefault();
        v.currentTime = Math.min(mediaInfo?.durationSec ?? Infinity, v.currentTime + (e.shiftKey ? 1 : 5));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mediaInfo]);

  const fileName = videoPath?.split(/[/\\]/).pop() ?? "";

  return (
    <div className="editor">
      <header className="ed-header">
        <button className="btn btn-ghost" onClick={closeVideo}>
          ← Library
        </button>
        <span className="ed-file" title={videoPath ?? ""}>
          {fileName}
        </span>
        {mediaInfo && (
          <span className="ed-meta muted">
            {mediaInfo.width}×{mediaInfo.height} · {Math.round(mediaInfo.fps)}fps ·{" "}
            {(mediaInfo.sizeBytes / 1024 / 1024).toFixed(1)} MB
          </span>
        )}
        <span className="ed-header-spacer" />
        {savedFlash && <span className="ed-saved-flash">✔ Saved</span>}
        <button className="btn btn-ghost btn-small" onClick={doSave} title={projectPath ?? "Save the highlights, names, style, and transcript so far"}>
          💾 Save Project
        </button>
        <button className="btn btn-ghost btn-small" onClick={() => void saveProjectAs()}>
          Save As…
        </button>
      </header>

      <div className="ed-body">
        <div className="ed-preview">
          <div className="video-frame" ref={frameRef} onClick={togglePlay}>
            {previewSrc && (
              <video
                ref={videoRef}
                src={previewSrc}
                className="video-el"
                playsInline
              />
            )}
            <div
              className="stage"
              style={{ width: stage.w, height: stage.h }}
            >
              <CaptionOverlay
                videoRef={videoRef}
                segments={segments}
                style={style}
                censor={censor}
                stageHeight={stage.h}
              />
            </div>
            {!playing && <div className="play-badge">▶</div>}
          </div>

          <div className="transport">
            <button className="btn btn-ghost" onClick={togglePlay}>
              {playing ? "❚❚" : "▶"}
            </button>
            <div className="seek-wrap">
              {activeRange && mediaInfo && mediaInfo.durationSec > 0 && (
                <div
                  className="seek-range"
                  style={{
                    left: `${(activeRange.start / mediaInfo.durationSec) * 100}%`,
                    width: `${((activeRange.end - activeRange.start) / mediaInfo.durationSec) * 100}%`,
                  }}
                />
              )}
              <input
                className="seek"
                type="range"
                min={0}
                max={mediaInfo?.durationSec ?? 0}
                step={0.05}
                value={time}
                onChange={(e) => {
                  const v = videoRef.current;
                  if (v) v.currentTime = Number(e.target.value);
                }}
              />
            </div>
            <span className="time muted">
              {fmtTime(time)} / {fmtTime(mediaInfo?.durationSec ?? 0)}
            </span>
          </div>
          <p className="muted small kbd-hint">
            <kbd>Space</kbd> play/pause · <kbd>←</kbd>/<kbd>→</kbd> seek 5s
            <span className="kbd-hint-shift"> (+ Shift for 1s)</span>
          </p>
        </div>

        <aside className="ed-side">
          <nav className="tabs">
            <button className={tab === "transcript" ? "sel" : ""} onClick={() => setTab("transcript")}>
              Transcript
            </button>
            <button
              className={tab === "highlights" ? "sel" : ""}
              onClick={() => setTab("highlights")}
            >
              Highlights
            </button>
            <button className={tab === "style" ? "sel" : ""} onClick={() => setTab("style")}>
              Style
            </button>
            <button className={tab === "export" ? "sel" : ""} onClick={() => setTab("export")}>
              Export
            </button>
          </nav>
          <div className="tab-body">
            {tab === "transcript" && <TranscriptPanel videoRef={videoRef} />}
            {tab === "highlights" && <HighlightsPanel videoRef={videoRef} />}
            {tab === "style" && <StylePanel />}
            {tab === "export" && <ExportDrawer />}
          </div>
        </aside>
      </div>
    </div>
  );
}
