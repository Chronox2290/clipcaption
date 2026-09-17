import { useEffect, useState } from "react";
import { Icon } from "../components/Icon";
import { useApp, type AppTheme } from "../store";
import { pickVideoFile, isTauri } from "../lib/tauri";

/** App theme changes how Substrike ITSELF looks - the editor chrome,
 * buttons, panels - a global preference, not a per-clip one. Used to live
 * inside a single clip's Style panel (which is about how CAPTIONS look in
 * the exported video), a real reported confusion: an app-wide setting
 * tucked inside one clip's editing context. Lives on the home screen now,
 * the same "global settings behind a click" pattern as the engine chip. */
const APP_THEMES: { id: AppTheme; name: string; blurb: string; a: string; b: string }[] = [
  { id: "precision", name: "Precision", blurb: "Dense, cool, restrained — Resolve/Premiere-adjacent.", a: "#7c5cff", b: "#2ee6ff" },
  { id: "warm", name: "Creator warm", blurb: "Roomier, warmer, fully rounded — Descript/CapCut-adjacent.", a: "#9b7bff", b: "#3ce6c2" },
  { id: "gamer", name: "High-energy", blurb: "Gradient glow, sharper actions — Discord/RGB-gear-adjacent.", a: "#8b5cf6", b: "#22d3ee" },
];

/** One recents-grid card. Its own component (not inlined in the map) so the
 * lazy thumbnail fetch is a normal per-item mount effect instead of a
 * hand-rolled "for each path, kick off a fetch" loop in the parent. */
function RecentCard({ path, onOpen }: { path: string; onOpen: () => void }) {
  const src = useApp((s) => s.recentThumbnails[path]);
  const loadRecentThumbnail = useApp((s) => s.loadRecentThumbnail);
  const name = path.split(/[\\/]/).pop() ?? path;

  useEffect(() => {
    void loadRecentThumbnail(path);
    // Only re-fetch if the path itself changes - loadRecentThumbnail is a
    // stable store action reference, and including it would refire this on
    // every unrelated store update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  return (
    <button className="recent-card" onClick={onOpen} title={path}>
      <div className="recent-card-poster">
        {src ? <img src={src} alt="" /> : <Icon name="film" size={22} />}
      </div>
      <span className="recent-card-name">{name}</span>
    </button>
  );
}

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

  // The speech-model/vocab panel used to always occupy prime real estate
  // before a first-time user has ever captioned a clip - demoted to a
  // compact header status chip that expands on demand, the same "settings
  // live behind a click, not in the way" pattern CapCut/Descript use.
  const [showEngine, setShowEngine] = useState(false);
  const [showTheme, setShowTheme] = useState(false);
  const theme = useApp((s) => s.theme);
  const setTheme = useApp((s) => s.setTheme);

  const browse = async () => {
    const p = await pickVideoFile();
    if (p) void openVideo(p);
  };

  return (
    <div className="library">
      <header className="lib-header">
        <div className="logo">
          <span className="logo-mark" aria-label="Substrike">
            <svg viewBox="0 0 34 34" width="34" height="34" fill="none" xmlns="http://www.w3.org/2000/svg">
              <defs>
                <linearGradient id="badgeGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#8E6EFF" />
                  <stop offset="100%" stopColor="#623DE6" />
                </linearGradient>
              </defs>
              <rect width="34" height="34" rx="10" fill="url(#badgeGrad)" />
              <path
                d="M 14 13 L 20 13 L 20 25 A 2 2 0 0 1 18 27 L 16 27 A 2 2 0 0 1 14 25 Z"
                fill="#0B0D12"
              />
              <rect x="6" y="7" width="22" height="6" rx="2" fill="#0B0D12" />
              <rect x="17" y="9" width="8" height="2" rx="1" fill="#2EE6FF" />
            </svg>
          </span>
          <span className="logo-text">Substrike</span>
        </div>
        <span className="tagline">local captions for game clips — no uploads, no limits</span>
        <div className="version-row">
          <button
            className={`engine-chip ${selected?.downloaded ? "ready" : ""}`}
            onClick={() => setShowEngine((v) => !v)}
          >
            <span className="engine-chip-dot" />
            {selectedModel} · {selected?.downloaded ? "ready" : "not downloaded"}
          </button>
          <button className="engine-chip" onClick={() => setShowTheme((v) => !v)}>
            <Icon name="sliders" size={12} /> Appearance
          </button>
          {isTauri && (
            <>
              {appVersion && <span className="muted small">v{appVersion}</span>}
              <button
                className="btn btn-ghost btn-small"
                disabled={updateStatus === "checking"}
                onClick={() => void checkForUpdates(false)}
              >
                {updateStatus === "checking" ? "Checking…" : "Check for updates"}
              </button>
              {updateStatus === "none" && <span className="muted small">You're up to date.</span>}
            </>
          )}
        </div>
      </header>

      {showEngine && (
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
      )}

      {showTheme && (
        <section className="model-card">
          <div className="model-card-head">
            <h3>App theme</h3>
          </div>
          <div className="theme-grid">
            {APP_THEMES.map((t) => (
              <button
                key={t.id}
                className={`theme-card ${theme === t.id ? "sel" : ""}`}
                onClick={() => setTheme(t.id)}
                title={t.blurb}
              >
                <span
                  className="theme-swatch"
                  style={{ background: `linear-gradient(135deg, ${t.a}, ${t.b})` }}
                />
                <span className="theme-card-name">{t.name}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      <main className="lib-main">
        <div className="hero-row">
          <div
            className="dropzone hero-drop"
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
            <div className="dropzone-icon"><Icon name="film" size={40} /></div>
            <h2>Drop a clip here</h2>
            <p>or click to browse — mp4 · mkv · mov · webm</p>
            {!isTauri && (
              <p className="dev-note">UI preview mode — run "npm run tauri dev" for the real app</p>
            )}
          </div>

          <button className="hero-card hero-card-primary" onClick={openBatch}>
            <span className="chip hero-card-badge">TIER-0 CORE LOOP</span>
            <strong>Batch &amp; watch folder</strong>
            <span className="muted small">
              Point at an OBS replay folder. Every clip gets captioned, styled, and exported
              hands-off.
            </span>
            <span className="hero-card-cta">Open batch &amp; live watcher →</span>
          </button>

          <button className="hero-card" onClick={openMontage}>
            <span className="chip">COMPILATION</span>
            <strong>Montage reel builder</strong>
            <span className="muted small">Stitch highlight clips into one postable reel.</span>
            <span className="hero-card-cta hero-card-cta-ghost">Create montage reel →</span>
          </button>
        </div>

        <div className="recents-header">
          <h3>Recent clips &amp; projects</h3>
          <button className="btn btn-ghost btn-small" onClick={() => void loadProject()}>
            <Icon name="folder" size={13} /> Open saved project…
          </button>
        </div>

        {recent.length > 0 ? (
          <div className="recents-grid">
            {recent.map((r) => (
              <RecentCard key={r} path={r} onOpen={() => openVideo(r)} />
            ))}
          </div>
        ) : (
          <p className="muted small">Nothing here yet — drop a clip above to get started.</p>
        )}
      </main>
    </div>
  );
}
