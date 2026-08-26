import { useApp } from "../store";
import { pickVideoFile, isTauri } from "../lib/tauri";

export default function Library() {
  const openVideo = useApp((s) => s.openVideo);
  const recent = useApp((s) => s.recent);
  const models = useApp((s) => s.models);
  const selectedModel = useApp((s) => s.selectedModel);
  const setSelectedModel = useApp((s) => s.setSelectedModel);
  const vocabulary = useApp((s) => s.vocabulary);
  const setVocabulary = useApp((s) => s.setVocabulary);
  const downloadModel = useApp((s) => s.downloadModel);
  const modelJob = useApp((s) => s.modelJob);
  const loadProject = useApp((s) => s.loadProject);
  const appVersion = useApp((s) => s.appVersion);
  const updateStatus = useApp((s) => s.updateStatus);
  const checkForUpdates = useApp((s) => s.checkForUpdates);

  const selected = models.find((m) => m.name === selectedModel);
  const pickerModels = models.filter((m) => !m.capabilityOnly);

  const openBatch = useApp((s) => s.openBatch);
  const openMontage = useApp((s) => s.openMontage);

  const browse = async () => {
    const p = await pickVideoFile();
    if (p) void openVideo(p);
  };

  return (
    <div className="library">
      <header className="lib-header">
        <div className="logo">
          <span className="logo-mark">CC</span>
          <span className="logo-text">ClipCaption</span>
        </div>
        <span className="tagline">local captions for game clips — no uploads, no limits</span>
        {isTauri && (
          <div className="version-row">
            {appVersion && <span className="muted small">v{appVersion}</span>}
            <button
              className="btn btn-ghost btn-small"
              disabled={updateStatus === "checking"}
              onClick={() => void checkForUpdates(false)}
            >
              {updateStatus === "checking" ? "Checking…" : "Check for updates"}
            </button>
            {updateStatus === "none" && <span className="muted small">You're up to date.</span>}
          </div>
        )}
      </header>

      <main className="lib-main">
        <div
          className="dropzone"
          onClick={browse}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              void browse();
            }
          }}
        >
          <div className="dropzone-icon">🎬</div>
          <h2>Drop a clip here</h2>
          <p>or click to browse — mp4 · mkv · mov · webm</p>
          {!isTauri && (
            <p className="dev-note">UI preview mode — run “npm run tauri dev” for the real app</p>
          )}
        </div>

        <button className="batch-launch" onClick={openBatch}>
          <span className="batch-launch-icon">🗂️</span>
          <span>
            <strong>Batch process clips</strong>
            <span className="muted"> — caption + compress a whole folder in one go</span>
          </span>
          <span className="batch-launch-arrow">→</span>
        </button>

        <button className="batch-launch" onClick={openMontage}>
          <span className="batch-launch-icon">🎞️</span>
          <span>
            <strong>Build a montage</strong>
            <span className="muted"> — stitch highlights from several projects into one reel</span>
          </span>
          <span className="batch-launch-arrow">→</span>
        </button>

        <button className="batch-launch" onClick={() => void loadProject()}>
          <span className="batch-launch-icon">📁</span>
          <span>
            <strong>Open a saved project</strong>
            <span className="muted"> — resume highlights, names, and captions from a .ccproj file</span>
          </span>
          <span className="batch-launch-arrow">→</span>
        </button>

        <section className="model-card">
          <div className="model-card-head">
            <h3>Speech model</h3>
            {selected && !selected.downloaded && !modelJob && (
              <button className="btn btn-small" onClick={() => downloadModel(selectedModel)}>
                Download ({selected.sizeMb} MB)
              </button>
            )}
            {selected?.downloaded && <span className="chip chip-ok">ready</span>}
          </div>
          <div className="model-list">
            {pickerModels.map((m) => (
              <label key={m.name} className={`model-row ${m.name === selectedModel ? "sel" : ""}`}>
                <input
                  type="radio"
                  name="model"
                  checked={m.name === selectedModel}
                  onChange={() => setSelectedModel(m.name)}
                />
                <span className="model-name">
                  {m.name}
                  {m.recommended ? " ★" : ""}
                </span>
                <span className="model-desc">{m.description}</span>
                <span className={`chip ${m.downloaded ? "chip-ok" : ""}`}>
                  {m.downloaded ? "installed" : `${m.sizeMb} MB`}
                </span>
              </label>
            ))}
            {pickerModels.length === 0 && (
              <p className="muted">Models appear here when running inside the app.</p>
            )}
          </div>
          <label className="vocab-field">
            <span className="model-name">Names &amp; jargon</span>
            <input
              type="text"
              value={vocabulary}
              placeholder="Christian, Luke, Tommy, proximity chat, skinwalker"
              onChange={(e) => setVocabulary(e.target.value)}
            />
            <span className="muted small">
              Fed to whisper as context before it transcribes, so it spells names it has never
              heard the way you do — and has a better shot at accented speech. Applies next time
              you transcribe.
            </span>
          </label>
          {modelJob && (
            <div className="progress-wrap">
              <div className="progress-bar">
                <div
                  className="progress-fill"
                  style={{ width: `${Math.max(0, modelJob.progress * 100)}%` }}
                />
              </div>
              <span className="muted">Downloading… {Math.round(modelJob.progress * 100)}%</span>
            </div>
          )}
          <p className="muted small">
            Speakers are detected automatically by real voice recognition (not just turn
            alternation) and colored per-speaker in the captions — no setup needed.
          </p>
        </section>

        {recent.length > 0 && (
          <section className="recent">
            <h3>Recent</h3>
            {recent.map((r) => (
              <button key={r} className="recent-row" onClick={() => openVideo(r)}>
                <span className="recent-icon">▶</span>
                <span className="recent-path">{r}</span>
              </button>
            ))}
          </section>
        )}
      </main>
    </div>
  );
}
