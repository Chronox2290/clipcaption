import type { ReactNode } from "react";
import { useEffect } from "react";
import { useApp } from "../store";
import { pickDirectory, pickVideoFiles } from "../lib/tauri";
import { STYLE_PRESETS } from "../lib/styles";
import EncodingOptions from "../components/EncodingOptions";
import { Icon } from "../components/Icon";
import DestinationControl from "../components/DestinationControl";

const STATUS_ICON: Record<string, ReactNode> = {
  pending: "•",
  transcribing: <Icon name="sparkle" size={14} />,
  exporting: <Icon name="download" size={14} />,
  done: "✔",
  error: "✕",
  skipped: "–",
  needs_review: <Icon name="warning" size={14} />,
};

/** A small poster-frame thumbnail per queued clip - reuses the exact same
 * recentThumbnails cache/loadRecentThumbnail action the Library screen's
 * recents grid uses (keyed by path), rather than a second thumbnail
 * pipeline: a batch item that later shows up in "recent" gets its
 * thumbnail for free, and vice versa. Was raw filenames only before this -
 * a real usability gap when queuing a folder of dozens of similarly-named
 * OBS replay files, since there was no way to tell them apart before
 * processing without opening each one. */
function BatchThumb({ path }: { path: string }) {
  const src = useApp((s) => s.recentThumbnails[path]);
  const loadRecentThumbnail = useApp((s) => s.loadRecentThumbnail);

  useEffect(() => {
    void loadRecentThumbnail(path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  return (
    <div className="batch-thumb">
      {src ? <img src={src} alt="" /> : <Icon name="film" size={16} />}
    </div>
  );
}

export default function BatchScreen() {
  const {
    batchItems,
    batchRunning,
    addBatchPaths,
    addBatchFolder,
    removeBatchItem,
    clearBatchItems,
    runFileBatch,
    cancelFileBatch,
    reviewBatchItem,
    style,
    setStyle,
    censor,
    setCensor,
    models,
    selectedModel,
    watching,
    watchFolderPath,
    watchFolderCount,
    startWatchFolder,
    stopWatchFolder,
    discordWebhook,
    autoDigestOnBatch,
    setAutoDigestOnBatch,
    batchExportSettings,
    setBatchExportSettings,
  } = useApp();
  const setScreen = () => useApp.setState({ screen: "library" });

  const toggleWatch = async () => {
    if (watching) {
      stopWatchFolder();
      return;
    }
    const dir = await pickDirectory();
    if (dir) void startWatchFolder(dir);
  };

  // Lifted into the store (see batchExportSettings) rather than local state -
  // the watch-folder listener runs from the store, not from this mounted
  // component, and needs to see exactly what's selected here.
  const {
    presetId,
    customMb,
    resolutionId,
    fitMode,
    saveMode,
    outputDir,
  } = batchExportSettings;
  const setPresetId = (v: string) => setBatchExportSettings({ presetId: v });
  const setCustomMb = (v: number) => setBatchExportSettings({ customMb: v });
  const setResolutionId = (v: string) => setBatchExportSettings({ resolutionId: v });
  const setFitMode = (v: "fill" | "fit" | "track") => setBatchExportSettings({ fitMode: v });
  const setSaveMode = (v: "beside" | "folder") => setBatchExportSettings({ saveMode: v });
  const setOutputDir = (v: string | null) => setBatchExportSettings({ outputDir: v });

  const model = models.find((m) => m.name === selectedModel);
  const pendingCount = batchItems.filter((i) => i.status === "pending").length;
  const doneCount = batchItems.filter((i) => i.status === "done").length;

  const addFiles = async () => {
    const paths = await pickVideoFiles();
    if (paths.length) addBatchPaths(paths);
  };

  const addFolder = async () => {
    const dir = await pickDirectory();
    if (dir) void addBatchFolder(dir);
  };

  const chooseOutputDir = async () => {
    const dir = await pickDirectory();
    if (dir) {
      setOutputDir(dir);
      setSaveMode("folder");
    }
  };

  const start = () => {
    void runFileBatch(
      presetId,
      customMb,
      saveMode === "folder" ? outputDir : null,
      resolutionId,
      fitMode
    );
  };

  return (
    <div className="batch-screen">
      <header className="ed-header">
        <button className="btn btn-ghost" onClick={setScreen} disabled={batchRunning}>
          ← Library
        </button>
        <span className="ed-file">Batch process clips</span>
        <span className="ed-meta muted">
          caption + compress many clips in one go
        </span>
      </header>

      <div className={`watch-hero ${watching ? "active" : ""}`}>
        <div className="watch-hero-head">
          <div className="watch-hero-title">
            <span className="watch-hero-pulse" />
            <strong>{watching ? "Live OBS watch folder" : "OBS watch folder"}</strong>
            <span className="chip watch-hero-badge">{watching ? "WATCHER ACTIVE" : "HANDS-OFF ENGINE"}</span>
          </div>
          <button className={`btn ${watching ? "btn-danger-outline" : "btn-primary"}`} onClick={() => void toggleWatch()}>
            {watching ? (
              <>
                <Icon name="stop" size={13} /> Stop watching
              </>
            ) : (
              "Start watching…"
            )}
          </button>
        </div>
        <p className="muted small watch-hero-copy">
          Listening in the background. Any new recording saved to this folder is automatically
          transcribed, captioned with your active style, and exported with the settings on the
          right - no manual step.
        </p>
        {watching && (
          <div className="watch-hero-path">
            <Icon name="folder" size={14} />
            <span title={watchFolderPath ?? undefined}>{watchFolderPath}</span>
            {watchFolderCount > 0 && (
              <span className="muted small">· {watchFolderCount} captioned so far this session</span>
            )}
          </div>
        )}
        {discordWebhook && (
          <label className="check-row watch-hero-digest">
            <input
              type="checkbox"
              checked={autoDigestOnBatch}
              onChange={(e) => setAutoDigestOnBatch(e.target.checked)}
            />
            <span>
              Post an end-of-session digest to Discord once a watch session goes quiet — clip
              count, a compiled reel of everything that finished, and anything flagged for review.
            </span>
          </label>
        )}
      </div>

      <div className="batch-body">
        <div className="batch-queue">
          <div className="batch-toolbar">
            <button className="btn" onClick={addFiles} disabled={batchRunning}>
              + Add clips
            </button>
            <button className="btn" onClick={addFolder} disabled={batchRunning}>
              + Add folder
            </button>
            {batchItems.length > 0 && !batchRunning && (
              <button className="btn btn-ghost btn-danger-outline" onClick={clearBatchItems}>
                Clear
              </button>
            )}
            <span className="muted small batch-count">
              {batchItems.length} clip{batchItems.length === 1 ? "" : "s"}
              {doneCount > 0 ? ` · ${doneCount} done` : ""}
            </span>
          </div>

          {batchItems.length === 0 ? (
            <div className="ghost-queue">
              <div
                className="ghost-row ghost-row-active"
                onClick={addFiles}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    void addFiles();
                  }
                }}
              >
                <Icon name="plus" size={16} />
                <span>Drop video clips or a folder here to queue for batch processing</span>
              </div>
              <div className="ghost-row ghost-row-phantom" style={{ opacity: 0.5 }}>
                <span className="ghost-row-dot" />
                <span className="ghost-row-bar" style={{ width: "45%" }} />
                <span className="ghost-row-bar ghost-row-bar-sm" />
              </div>
              <div className="ghost-row ghost-row-phantom" style={{ opacity: 0.28 }}>
                <span className="ghost-row-dot" />
                <span className="ghost-row-bar" style={{ width: "30%" }} />
                <span className="ghost-row-bar ghost-row-bar-sm" />
              </div>
            </div>
          ) : (
            <div className="batch-list">
              {batchItems.map((item) => (
                <div key={item.id} className={`batch-row st-${item.status}`}>
                  <BatchThumb path={item.path} />
                  <span className="batch-status">{STATUS_ICON[item.status]}</span>
                  <div className="batch-mid">
                    <span className="batch-name" title={item.path}>
                      {item.name}
                    </span>
                    {(item.status === "transcribing" || item.status === "exporting") && (
                      <div className="progress-bar thin">
                        <div
                          className="progress-fill"
                          style={{
                            width: `${Math.max(4, Math.max(0, item.progress) * 100)}%`,
                          }}
                        />
                      </div>
                    )}
                    {item.status === "error" && (
                      <span className="batch-err">{item.error}</span>
                    )}
                    {item.status === "done" && item.output && (
                      <span className="muted small">{item.output}</span>
                    )}
                    {item.status === "done" && item.note && (
                      <span className="batch-err">{item.note}</span>
                    )}
                    {item.status === "needs_review" && (
                      <span className="muted small">
                        AI cleanup found a word it wasn't sure about - held back from export.
                      </span>
                    )}
                  </div>
                  <span className="muted small">
                    {item.status === "transcribing" && "captioning…"}
                    {item.status === "exporting" && "exporting…"}
                  </span>
                  {item.status === "needs_review" && (
                    <button
                      className="btn btn-small btn-primary"
                      onClick={() => void reviewBatchItem(item.id)}
                      disabled={batchRunning}
                    >
                      Review & export
                    </button>
                  )}
                  {!batchRunning && item.status === "pending" && (
                    <button
                      className="btn btn-ghost btn-small"
                      onClick={() => removeBatchItem(item.id)}
                    >
                      ✕
                    </button>
                  )}
                </div>
              ))}
              {!batchRunning && (
                <div
                  className="ghost-row ghost-row-active ghost-row-trailing"
                  onClick={addFiles}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      void addFiles();
                    }
                  }}
                >
                  <Icon name="plus" size={14} />
                  <span>Drop more clips or folders here</span>
                </div>
              )}
            </div>
          )}
        </div>

        <aside className="batch-side">
          <h4>Caption style</h4>
          <div className="field">
            <select
              value={style.id}
              onChange={(e) => {
                const p = STYLE_PRESETS.find((s) => s.id === e.target.value);
                if (p) setStyle({ ...p });
              }}
            >
              {STYLE_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <label className="check-row">
            <input
              type="checkbox"
              checked={censor}
              onChange={(e) => setCensor(e.target.checked)}
            />
            <span>Censor profanity</span>
          </label>
          <p className="muted small">
            Fine-tune the style on any single clip in the editor first — the batch
            uses whatever is currently set.
          </p>

          <DestinationControl
            presetId={presetId}
            customMb={customMb}
            resolutionId={resolutionId}
            fitMode={fitMode}
            onPresetChange={setPresetId}
            onCustomMbChange={setCustomMb}
            onResolutionChange={setResolutionId}
            onFitModeChange={setFitMode}
          />

          <h4>Encoding</h4>
          <EncodingOptions />

          <h4>Save to</h4>
          <label className={`preset-row ${saveMode === "beside" ? "sel" : ""}`}>
            <input
              type="radio"
              name="bsave"
              checked={saveMode === "beside"}
              onChange={() => setSaveMode("beside")}
            />
            <span>Next to each original (.captioned.mp4)</span>
          </label>
          <label className={`preset-row ${saveMode === "folder" ? "sel" : ""}`} onClick={chooseOutputDir}>
            <input
              type="radio"
              name="bsave"
              checked={saveMode === "folder"}
              readOnly
            />
            <span>{outputDir ? outputDir : "Choose a folder…"}</span>
          </label>

          {!batchRunning ? (
            <button
              className="btn btn-primary btn-big"
              onClick={start}
              disabled={
                pendingCount === 0 ||
                !model?.downloaded ||
                (saveMode === "folder" && !outputDir)
              }
            >
              <Icon name="bolt" size={14} />{" "}
              {pendingCount === 0
                ? "Add clips to process"
                : saveMode === "folder" && !outputDir
                  ? "Choose an output folder"
                  : `Process ${pendingCount} clip${pendingCount === 1 ? "" : "s"}`}
            </button>
          ) : (
            <button className="btn btn-big" onClick={cancelFileBatch}>
              <Icon name="stop" size={13} /> Stop after current clip
            </button>
          )}
          {!model?.downloaded && (
            <p className="muted small">
              Download the "{selectedModel}" speech model on the home screen first.
            </p>
          )}
        </aside>
      </div>
    </div>
  );
}
