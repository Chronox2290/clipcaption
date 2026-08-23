import { useApp } from "../store";
import { pickVideoFile, isTauri } from "../lib/tauri";

export default function Library() {
  const openVideo = useApp((s) => s.openVideo);
  const recent = useApp((s) => s.recent);
  const models = useApp((s) => s.models);
  const selectedModel = useApp((s) => s.selectedModel);
  const setSelectedModel = useApp((s) => s.setSelectedModel);
  const downloadModel = useApp((s) => s.downloadModel);
  const modelJob = useApp((s) => s.modelJob);

  const selected = models.find((m) => m.name === selectedModel);

  const openBatch = useApp((s) => s.openBatch);

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
      </header>

      <main className="lib-main">
        <div className="dropzone" onClick={browse} role="button" tabIndex={0}>
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
            {models.map((m) => (
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
            {models.length === 0 && (
              <p className="muted">Models appear here when running inside the app.</p>
            )}
          </div>
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
