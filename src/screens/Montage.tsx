import { useState } from "react";
import { useApp } from "../store";
import { invoke, pickProjectOpenPaths, pickSavePath } from "../lib/tauri";
import { fmtTime, resolveSpeakerNames } from "../lib/captions";
import type { MontageClip, ProjectFile } from "../types";
import DestinationControl from "../components/DestinationControl";
import { Icon } from "../components/Icon";

/** Stitches highlight clips from SEVERAL different saved projects into one
 * shareable reel — the piece Auto Reel (Highlights tab) doesn't cover,
 * since that only ever picks from the one video currently open. Point this
 * at a folder's worth of already-captioned .ccproj files and come out with
 * one file worth posting, instead of a folder of separate clips. */
export default function Montage() {
  const buildMontage = useApp((s) => s.buildMontage);
  const montageJob = useApp((s) => s.montageJob);
  const exportDone = useApp((s) => s.exportDone);
  const setScreen = () => useApp.setState({ screen: "library" });

  const [clips, setClips] = useState<MontageClip[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [presetId, setPresetId] = useState("original");
  const [resolutionId, setResolutionId] = useState("1080");
  const [fitMode, setFitMode] = useState<"fill" | "fit" | "track">("fill");
  const [dragId, setDragId] = useState<string | null>(null);
  const [sizeLimitEnabled, setSizeLimitEnabled] = useState(false);
  const [sizeLimitMb, setSizeLimitMb] = useState(25);
  const selectedClips = clips.filter((c) => selected.has(c.id));
  const totalDurationSec = selectedClips.reduce((n, c) => n + (c.end - c.start), 0);

  const addProjects = async () => {
    const paths = await pickProjectOpenPaths();
    if (paths.length === 0) return;
    setLoading(true);
    try {
      const added: MontageClip[] = [];
      for (const path of paths) {
        try {
          const raw = await invoke<string>("read_text_file", { path });
          const project = JSON.parse(raw) as ProjectFile;
          const sourceLabel = path.split(/[\\/]/).pop() ?? path;
          // Resolved once per source project - each project's speaker
          // indices only mean anything within that one project, so this has
          // to happen before clips from different projects sit in one list.
          const speakerNames = resolveSpeakerNames(
            project.speakerEmbeddings ?? {},
            project.speakerProfiles ?? []
          );
          for (const h of project.highlights) {
            const range = project.clipOverrides[h.rank] ?? { start: h.start, end: h.end };
            added.push({
              id: `${path}:${h.rank}`,
              projectPath: path,
              videoPath: project.videoPath,
              sourceLabel,
              rank: h.rank,
              start: range.start,
              end: range.end,
              segments: project.segments,
              style: project.style,
              censor: project.censor,
              stickers: project.stickers,
              speakerNames,
            });
          }
        } catch {
          // One bad/unreadable project shouldn't block the others the user
          // also picked in the same dialog.
        }
      }
      setClips((prev) => {
        const existingIds = new Set(prev.map((c) => c.id));
        const fresh = added.filter((c) => !existingIds.has(c.id));
        return [...prev, ...fresh];
      });
      // New clips default to included - picking a project usually means
      // "I want its highlights in this reel", not "browse and decide later".
      setSelected((prev) => {
        const next = new Set(prev);
        for (const c of added) next.add(c.id);
        return next;
      });
    } finally {
      setLoading(false);
    }
  };

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const removeClip = (id: string) => {
    setClips((prev) => prev.filter((c) => c.id !== id));
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  const moveClip = (id: string, overId: string) => {
    if (id === overId) return;
    setClips((prev) => {
      const from = prev.findIndex((c) => c.id === id);
      const to = prev.findIndex((c) => c.id === overId);
      if (from === -1 || to === -1) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };

  const build = async () => {
    if (selectedClips.length === 0) return;
    const out = await pickSavePath("montage.mp4");
    if (!out) return;
    void buildMontage(
      selectedClips,
      out,
      presetId,
      resolutionId,
      fitMode,
      sizeLimitEnabled ? sizeLimitMb : null
    );
  };

  return (
    <div className="batch-screen">
      <header className="ed-header">
        <button className="btn btn-ghost" onClick={setScreen} disabled={!!montageJob}>
          ← Library
        </button>
        <span className="ed-file">Build a montage</span>
        <span className="ed-meta muted">
          stitch highlights from several already-captioned projects into one reel
        </span>
      </header>

      <div className="batch-body">
        <div className="batch-queue">
          <div className="batch-toolbar">
            <button className="btn" onClick={() => void addProjects()} disabled={loading || !!montageJob}>
              {loading ? "Reading projects…" : "+ Add clips from project(s)…"}
            </button>
            {clips.length > 0 && !montageJob && (
              <button
                className="btn btn-ghost btn-danger-outline"
                onClick={() => {
                  setClips([]);
                  setSelected(new Set());
                }}
              >
                Clear
              </button>
            )}
            {selectedClips.length > 0 && (
              <span className="muted small batch-count">{fmtTime(totalDurationSec)} total</span>
            )}
          </div>

          <div className="filmstrip">
            <div className="filmstrip-header">
              <span className="filmstrip-label">Playback sequence</span>
              <span className="muted small">
                {selectedClips.length} clip{selectedClips.length === 1 ? "" : "s"} ·{" "}
                {fmtTime(totalDurationSec)} total
              </span>
            </div>
            <div className="filmstrip-track">
              <button
                type="button"
                className="filmstrip-slot filmstrip-add"
                onClick={() => void addProjects()}
                disabled={loading || !!montageJob}
              >
                <Icon name="plus" size={20} />
                <span>Add highlight clips</span>
                <span className="muted small">Pick saved projects</span>
              </button>
              {selectedClips.length === 0
                ? [2, 3, 4, 5].map((n) => (
                    <div key={n} className="filmstrip-slot filmstrip-ghost" style={{ opacity: 1 - n * 0.13 }}>
                      <span className="filmstrip-ghost-num">{String(n).padStart(2, "0")}</span>
                    </div>
                  ))
                : selectedClips.map((c, i) => (
                    <div
                      key={c.id}
                      className={`filmstrip-slot filmstrip-card ${dragId === c.id ? "dragging" : ""}`}
                      draggable={!montageJob}
                      onDragStart={() => setDragId(c.id)}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={() => {
                        if (dragId) moveClip(dragId, c.id);
                        setDragId(null);
                      }}
                    >
                      <span className="filmstrip-seq">{String(i + 1).padStart(2, "0")}</span>
                      <span className="filmstrip-duration">{fmtTime(c.end - c.start)}</span>
                      <div className="filmstrip-card-body">
                        <span className="filmstrip-card-title" title={c.projectPath}>
                          {c.sourceLabel}
                        </span>
                        <span className="muted small">Clip #{c.rank}</span>
                      </div>
                      <div className="filmstrip-card-actions">
                        <span className="filmstrip-grip" title="Drag to reorder">
                          <Icon name="grip" size={14} />
                        </span>
                        <button
                          type="button"
                          className="btn btn-ghost btn-small"
                          onClick={() => toggle(c.id)}
                          disabled={!!montageJob}
                          title="Remove from this montage"
                        >
                          <Icon name="close" size={13} />
                        </button>
                      </div>
                    </div>
                  ))}
            </div>
            <p className="muted small filmstrip-hint">
              Highlights play in order from left to right. Drag any card to reorder. Output
              resolution is unified automatically.
            </p>
          </div>

          {clips.length > selectedClips.length && (
            <div className="filmstrip-available">
              <h4>Available highlights not in this reel</h4>
              <div className="batch-list">
                {clips
                  .filter((c) => !selected.has(c.id))
                  .map((c) => (
                    <label key={c.id} className="batch-row montage-row">
                      <input type="checkbox" checked={false} onChange={() => toggle(c.id)} />
                      <span className="montage-source" title={c.projectPath}>
                        {c.sourceLabel}
                      </span>
                      <span className="montage-clip-name">Clip #{c.rank}</span>
                      <span className="muted small">
                        {fmtTime(c.start)}–{fmtTime(c.end)} · {fmtTime(c.end - c.start)}
                      </span>
                      <button
                        type="button"
                        className="btn btn-ghost btn-small"
                        onClick={() => removeClip(c.id)}
                        disabled={!!montageJob}
                        title="Remove entirely"
                      >
                        <Icon name="close" size={13} />
                      </button>
                    </label>
                  ))}
              </div>
            </div>
          )}
        </div>

        <div className="batch-side">
          <DestinationControl
            presetId={presetId}
            customMb={sizeLimitMb}
            resolutionId={resolutionId}
            fitMode={fitMode}
            resolutionMode="uniform"
            allowCustom={false}
            onPresetChange={setPresetId}
            onCustomMbChange={setSizeLimitMb}
            onResolutionChange={setResolutionId}
            onFitModeChange={setFitMode}
          >
            <div className="field">
              <label title="Each clip still renders at quality (CRF) individually - this caps the FINAL joined file with one extra compression pass, same as a single export's own size limit.">
                Limit file size
              </label>
              <input
                type="checkbox"
                checked={sizeLimitEnabled}
                onChange={(e) => setSizeLimitEnabled(e.target.checked)}
              />
              {sizeLimitEnabled && (
                <input
                  type="number"
                  min={1}
                  max={2000}
                  value={sizeLimitMb}
                  onChange={(e) => setSizeLimitMb(Number(e.target.value))}
                />
              )}
              {sizeLimitEnabled && <span className="field-val">MB</span>}
            </div>
          </DestinationControl>

          <p className="muted small">
            Every clip is rendered at this same resolution regardless of its own source video's
            size, so they join into one file cleanly. If you've turned on "Post to Discord
            automatically" in the Export tab, the finished montage posts there too.
          </p>

          {montageJob ? (
            <div className="progress-wrap">
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${Math.max(0, montageJob.progress * 100)}%` }} />
              </div>
              <span className="muted small">
                {montageJob.message ?? "Working…"}
              </span>
            </div>
          ) : (
            <button
              className="btn btn-primary btn-big"
              onClick={() => (selectedClips.length === 0 ? void addProjects() : void build())}
            >
              {selectedClips.length === 0
                ? "+ Add clips from project(s)…"
                : `Stitch & export reel (${selectedClips.length} clip${selectedClips.length === 1 ? "" : "s"} · ${fmtTime(totalDurationSec)}) →`}
            </button>
          )}

          {exportDone && !montageJob && (
            <p className="muted small">
              Saved to <code>{exportDone}</code>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
