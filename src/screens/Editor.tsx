import { Icon } from "../components/Icon";
import { useEffect, useRef, useState } from "react";
import { useApp } from "../store";
import CaptionOverlay from "../components/CaptionOverlay";
import StickerOverlay from "../components/StickerOverlay";
import SafeZoneOverlay from "../components/SafeZoneOverlay";
import MainWaveform from "../components/MainWaveform";
import { useSplitter } from "../lib/useSplitter";
import TranscriptPanel from "../components/TranscriptPanel";
import StylePanel from "../components/StylePanel";
import ExportDrawer from "../components/ExportDrawer";
import HighlightsPanel from "../components/HighlightsPanel";
import { fmtTime, resolveSpeakerNames } from "../lib/captions";
import { SAFE_ZONE_PRESETS, getSafeZonePreset } from "../lib/safeZones";


export default function Editor() {
  const {
    videoPath,
    previewSrc,
    mediaInfo,
    segments,
    style,
    censor,
    closeVideo,
    restoredSession,
    dismissRestoredNotice,
    discardSession,
    undo,
    redo,
    canUndo,
    canRedo,
    activeRange,
    projectPath,
    saveProject,
    saveProjectAs,
    loadProject,
    speakerEmbeddings,
    speakerProfiles,
    safeZonePreset,
    setSafeZonePreset,
    addSticker,
  } = useApp();
  const speakerNames = resolveSpeakerNames(speakerEmbeddings, speakerProfiles);
  const activeSafeZone = getSafeZonePreset(safeZonePreset);
  const [savedFlash, setSavedFlash] = useState(false);

  // The timeline is the workspace; the preview is a reference you glance at.
  // Both dividers are draggable and remembered, so this is a starting point
  // rather than a decision imposed on every video.
  const timeline = useSplitter({
    storageKey: "cc.timelineHeight",
    // 300px is the right default at the app's own normal launch size
    // (1320x860 - tauri.conf.json - only 35% of window height). But this is
    // a flat, one-time first-launch default, not a live-responsive value -
    // at the app's advertised MINIMUM size (1040x680), a bare 300px is 44%
    // of the window and left only ~196px for the video preview and ~279px
    // for the whole sidebar on a first run, before anyone's ever dragged
    // the splitter to something they prefer. Scaling it down for a small
    // starting window keeps the same intent (timeline as the primary
    // workspace) without choking everything else out on a small display.
    initial: Math.min(300, Math.round(window.innerHeight * 0.35)),
    min: 140,
    max: () => Math.max(200, window.innerHeight - 260),
    axis: "y",
    invert: true, // the timeline is anchored to the bottom: dragging up grows it
  });
  const sidebar = useSplitter({
    storageKey: "cc.sidebarWidth",
    initial: 400,
    min: 300,
    max: () => Math.max(320, window.innerWidth - 420),
    axis: "x",
    invert: true, // anchored right: dragging left grows it
  });
  const doSave = async () => {
    const ok = await saveProject();
    if (ok) {
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1800);
    }
  };
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  // Tab lives in the store so other panels can navigate here (see the Export
  // tab pointing at Highlights for clip export).
  const tab = useApp((s) => s.editorTab);
  const setTab = useApp((s) => s.setEditorTab);
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
      // Undo/redo before the transport keys: these are the only shortcuts that
      // should work whether or not a video element exists yet.
      if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === "y" || e.key === "Y")) {
        e.preventDefault();
        redo();
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
  }, [mediaInfo, undo, redo]);

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
        <button
          className="btn btn-ghost btn-small"
          onClick={undo}
          disabled={!canUndo}
          title="Undo (Ctrl+Z)"
        >
          <Icon name="undo" size={14} />
        </button>
        <button
          className="btn btn-ghost btn-small"
          onClick={redo}
          disabled={!canRedo}
          title="Redo (Ctrl+Shift+Z)"
        >
          <Icon name="redo" size={14} />
        </button>
        {savedFlash && <span className="ed-saved-flash"><Icon name="check" size={14} /> Saved</span>}
        <button className="btn btn-ghost btn-small" onClick={doSave} title={projectPath ?? "Save the highlights, names, style, and transcript so far"}>
          <Icon name="save" size={14} /> Save Project
        </button>
        <button className="btn btn-ghost btn-small" onClick={() => void saveProjectAs()}>
          Save As…
        </button>
        <button
          className="btn btn-ghost btn-small"
          onClick={() => void loadProject()}
          title="Open a different saved .ccproj - your work on this video is autosaved first"
        >
          <Icon name="folder" size={14} /> Open Project…
        </button>
      </header>
      {restoredSession && (
        <div className="ed-restored">
          <span>
            Picked up where you left off — your transcript, clips and tweaks for this video were
            restored from an autosave.
          </span>
          <button className="btn btn-ghost btn-small btn-danger-outline" onClick={() => void discardSession()}>
            Start fresh
          </button>
          <button className="btn btn-ghost btn-small" onClick={dismissRestoredNotice}>
            Dismiss
          </button>
        </div>
      )}

      <div className="ed-body">
        <div className="ed-upper">
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
                  speakerNames={speakerNames}
                />
                <StickerOverlay stageW={stage.w} stageH={stage.h} time={time} />
                {activeSafeZone && (
                  <SafeZoneOverlay stageW={stage.w} stageH={stage.h} preset={activeSafeZone} />
                )}
              </div>
              {!playing && <div className="play-badge">▶</div>}
            </div>

            <div className="preview-toolbar">
              <label
                className="hl-count"
                title="Shows where TikTok/Reels/Shorts' own UI (profile, captions, like/share buttons) typically sits on a vertical export - approximate creator-tool guideline percentages, not a pixel-exact spec. Editing aid only, never affects the exported video."
              >
                <span className="muted small">Safe zones</span>
                <select
                  value={safeZonePreset ?? "off"}
                  onChange={(e) => setSafeZonePreset(e.target.value === "off" ? null : e.target.value)}
                >
                  <option value="off">Off</option>
                  {SAFE_ZONE_PRESETS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="btn btn-ghost btn-small"
                title="Adds a decorative reaction sticker at the current playhead - drag to place, click to edit text/rotation/size. Separate from the dialogue captions, its own opt-in layer."
                onClick={() => addSticker(time)}
              >
                <Icon name="sparkle" size={14} /> Add sticker
              </button>
            </div>

            <div className="transport">
              <button className="btn btn-ghost" onClick={togglePlay} aria-label={playing ? "Pause" : "Play"}>
                <Icon name={playing ? "pause" : "play"} size={16} />
              </button>
              <div className="seek-wrap">
                <input
                  className="seek"
                  type="range"
                  // While a clip's range is active, the bar covers just that
                  // clip instead of the whole recording - a highlight can be
                  // a few seconds inside an hours-long source, where the old
                  // full-length bar made the clip an invisible sliver and
                  // scrubbing within it imprecise to the point of unusable.
                  min={activeRange ? activeRange.start : 0}
                  max={activeRange ? activeRange.end : mediaInfo?.durationSec ?? 0}
                  step={0.05}
                  value={time}
                  onChange={(e) => {
                    const v = videoRef.current;
                    if (v) v.currentTime = Number(e.target.value);
                  }}
                />
              </div>
              <span className="time muted">
                {activeRange
                  ? // Clamped: `time` can briefly sit outside the range right
                    // as it becomes active, before the video has actually
                    // seeked there - fmtTime has no negative-input guard of
                    // its own, so an unclamped value here would flash a
                    // nonsensical "-1:57" for a frame or two.
                    `${fmtTime(Math.max(0, time - activeRange.start))} / ${fmtTime(activeRange.end - activeRange.start)}`
                  : `${fmtTime(time)} / ${fmtTime(mediaInfo?.durationSec ?? 0)}`}
              </span>
            </div>
            <p className="muted small kbd-hint">
              <kbd>Space</kbd> play/pause · <kbd>←</kbd>/<kbd>→</kbd> seek 5s
              <span className="kbd-hint-shift"> (+ Shift for 1s)</span>
            </p>

          </div>

          <div
            className={`ed-split ed-split-v${sidebar.dragging ? " dragging" : ""}`}
            title="Drag to resize · double-click to snap"
            {...sidebar.handleProps}
          />

          <aside className="ed-side" style={{ width: sidebar.size }}>
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

        <div
          className={`ed-split ed-split-h${timeline.dragging ? " dragging" : ""}`}
          title="Drag to resize · double-click to snap"
          {...timeline.handleProps}
        />

        <div className="ed-timeline" style={{ height: timeline.size }}>
          <MainWaveform videoRef={videoRef} />
        </div>
      </div>
    </div>
  );
}
