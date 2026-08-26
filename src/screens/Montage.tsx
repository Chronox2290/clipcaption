import { useState } from "react";
import { useApp } from "../store";
import { invoke, pickProjectOpenPaths, pickSavePath } from "../lib/tauri";
import { fmtTime } from "../lib/captions";
import { EXPORT_PRESETS, RESOLUTION_OPTIONS } from "../lib/exportPresets";
import type { MontageClip, ProjectFile } from "../types";

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
  const [fitMode, setFitMode] = useState<"fill" | "fit">("fill");
  const [dragId, setDragId] = useState<string | null>(null);

  const preset = EXPORT_PRESETS.find((p) => p.id === presetId) ?? EXPORT_PRESETS[0];
  const isCropped = !!(preset.targetW && preset.targetH);
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
    void buildMontage(selectedClips, out, presetId, resolutionId, fitMode);
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
                className="btn btn-ghost"
                onClick={() => {
                  setClips([]);
                  setSelected(new Set());
                }}
              >
                Clear
              </button>
            )}
            <span className="muted small batch-count">
              {selectedClips.length}/{clips.length} clip{clips.length === 1 ? "" : "s"} selected
              {selectedClips.length > 0 ? ` · ${fmtTime(totalDurationSec)} total` : ""}
            </span>
          </div>

          {clips.length === 0 ? (
            <div className="panel-empty">
              <p className="muted">
                Pick one or more saved .ccproj files — every highlight in each one shows up here,
                ready to tick, reorder, and stitch into a single output. Drag a row to reorder;
                playback order follows the list top to bottom.
              </p>
            </div>
          ) : (
            <div className="batch-list">
              {clips.map((c) => (
                <div
                  key={c.id}
                  className={`batch-row montage-row ${selected.has(c.id) ? "sel" : ""}`}
                  draggable={!montageJob}
                  onDragStart={() => setDragId(c.id)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => {
                    if (dragId) moveClip(dragId, c.id);
                    setDragId(null);
                  }}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(c.id)}
                    onChange={() => toggle(c.id)}
                  />
                  <span className="montage-drag-handle" title="Drag to reorder">
                    ⋮⋮
                  </span>
                  <span className="montage-source" title={c.projectPath}>
                    {c.sourceLabel}
                  </span>
                  <span className="montage-clip-name">Clip #{c.rank}</span>
                  <span className="muted small">
                    {fmtTime(c.start)}–{fmtTime(c.end)} · {fmtTime(c.end - c.start)}
                  </span>
                  <button
                    className="btn btn-ghost btn-small"
                    onClick={() => removeClip(c.id)}
                    disabled={!!montageJob}
                    title="Remove from this montage"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="batch-side">
          <h4>Destination preset</h4>
          <div className="preset-list">
            {EXPORT_PRESETS.filter((p) => p.id !== "custom").map((p) => (
              <label key={p.id} className={`preset-row ${presetId === p.id ? "sel" : ""}`}>
                <input
                  type="radio"
                  name="mpreset"
                  checked={presetId === p.id}
                  onChange={() => setPresetId(p.id)}
                />
                <span>{p.name}</span>
              </label>
            ))}
          </div>

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

          <p className="muted small">
            Every clip is rendered at this same resolution regardless of its own source video's
            size, so they join into one file cleanly. A file-size limit isn't supported for
            montages yet — pick a resolution that keeps the whole thing a sane size. If you've
            turned on "Post to Discord automatically" in the Export tab, the finished montage
            posts there too.
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
              disabled={selectedClips.length === 0}
              onClick={() => void build()}
            >
              Build montage ({selectedClips.length} clip{selectedClips.length === 1 ? "" : "s"})
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
