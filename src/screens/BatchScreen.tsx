import { useState } from "react";
import { useApp } from "../store";
import { pickDirectory, pickVideoFiles } from "../lib/tauri";
import { EXPORT_PRESETS, RESOLUTION_OPTIONS } from "../lib/exportPresets";
import { STYLE_PRESETS } from "../lib/styles";
import EncodingOptions from "../components/EncodingOptions";

const STATUS_ICON: Record<string, string> = {
  pending: "•",
  transcribing: "✦",
  exporting: "⬇",
  done: "✔",
  error: "✕",
  skipped: "–",
  needs_review: "⚠",
};

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
  } = useApp();
  const setScreen = () => useApp.setState({ screen: "library" });

  const [presetId, setPresetId] = useState("original");
  const [customMb, setCustomMb] = useState(25);
  const [resolutionId, setResolutionId] = useState("source");
  const [fitMode, setFitMode] = useState<"fill" | "fit">("fill");
  const [saveMode, setSaveMode] = useState<"beside" | "folder">("beside");
  const [outputDir, setOutputDir] = useState<string | null>(null);

  const model = models.find((m) => m.name === selectedModel);
  const preset = EXPORT_PRESETS.find((p) => p.id === presetId)!;
  const isCropped = !!(preset.targetW && preset.targetH);
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
              <button className="btn btn-ghost" onClick={clearBatchItems}>
                Clear
              </button>
            )}
            <span className="muted small batch-count">
              {batchItems.length} clip{batchItems.length === 1 ? "" : "s"}
              {doneCount > 0 ? ` · ${doneCount} done` : ""}
            </span>
          </div>

          {batchItems.length === 0 ? (
            <div
              className="dropzone batch-empty"
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
              <div className="dropzone-icon">🗂️</div>
              <h2>Queue up your clips</h2>
              <p>Add individual clips or a whole folder of OBS recordings</p>
            </div>
          ) : (
            <div className="batch-list">
              {batchItems.map((item) => (
                <div key={item.id} className={`batch-row st-${item.status}`}>
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

          <h4>Export preset</h4>
          <div className="preset-list">
            {EXPORT_PRESETS.map((p) => (
              <label key={p.id} className={`preset-row ${presetId === p.id ? "sel" : ""}`}>
                <input
                  type="radio"
                  name="bpreset"
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

          <div className="field">
            <label>Resolution</label>
            <select value={resolutionId} onChange={(e) => setResolutionId(e.target.value)}>
              {RESOLUTION_OPTIONS.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>

          {isCropped && (
            <div className="field">
              <label>Frame</label>
              <div className="seg-toggle">
                <button
                  className={`seg-toggle-btn ${fitMode === "fill" ? "sel" : ""}`}
                  title="Fill the frame edge-to-edge, cropping whatever doesn't fit"
                  onClick={() => setFitMode("fill")}
                >
                  Fill (crop)
                </button>
                <button
                  className={`seg-toggle-btn ${fitMode === "fit" ? "sel" : ""}`}
                  title="Show the whole frame, padded with a blurred zoomed copy instead of cropping"
                  onClick={() => setFitMode("fit")}
                >
                  Fit (show all)
                </button>
              </div>
            </div>
          )}

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
              ⚡ Process {pendingCount} clip{pendingCount === 1 ? "" : "s"}
            </button>
          ) : (
            <button className="btn btn-big" onClick={cancelFileBatch}>
              ■ Stop after current clip
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
