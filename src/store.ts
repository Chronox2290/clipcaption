import { create } from "zustand";
import type {
  BatchItem,
  BatchState,
  CaptionPage,
  CaptionStyle,
  ExportRequest,
  Highlight,
  JobProgressPayload,
  MediaInfo,
  ModelInfo,
  Segment,
} from "./types";
import { invoke, fileSrc, listenJobProgress, isTauri } from "./lib/tauri";
import { getPreset } from "./lib/styles";
import { applyCensor, nextId, paginate, shiftPages } from "./lib/captions";
import { getExportPreset } from "./lib/exportPresets";
import { buildAss } from "./lib/ass";

interface JobState {
  id: string;
  stage: string;
  progress: number;
  message?: string;
}

// Promise adapters for jobs we want to await (used by the batch pipeline)
const pendingJobs = new Map<
  string,
  {
    resolve: (result: string | undefined) => void;
    reject: (err: Error) => void;
    onProgress?: (p: JobProgressPayload) => void;
  }
>();

function waitForJob(
  id: string,
  onProgress?: (p: JobProgressPayload) => void
): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    pendingJobs.set(id, { resolve, reject, onProgress });
  });
}

// id of the job the file-batch loop is currently awaiting (for cancellation)
let currentBatchJobId: string | null = null;
let batchCancelRequested = false;

interface AppState {
  screen: "library" | "editor" | "batch";
  error: string | null;

  // media
  videoPath: string | null;
  previewSrc: string | null;
  mediaInfo: MediaInfo | null;

  // transcript
  segments: Segment[];
  censor: boolean;

  // style
  style: CaptionStyle;

  // highlights
  highlights: Highlight[];
  analyzeJob: JobState | null;
  /** Active working range (a highlight the user selected) — transcribe/export apply to it */
  activeRange: { start: number; end: number } | null;
  /** Ranks of highlights checked for "export selected" */
  selectedRanks: number[];
  /** User-adjusted start/end per highlight rank, overriding the AI-detected window */
  clipOverrides: Record<number, { start: number; end: number }>;
  /** Which highlight (by rank) currently has its trim nudge controls open */
  editingRank: number | null;
  batch: BatchState | null;

  // multi-clip batch queue
  batchItems: BatchItem[];
  batchRunning: boolean;

  // jobs
  transcribeJob: JobState | null;
  exportJob: JobState | null;
  exportDone: string | null;
  modelJob: JobState | null;

  // models
  models: ModelInfo[];
  selectedModel: string;

  // encoding options
  encoder: string; // "auto" | "x264" | "nvenc" | "amf" | "qsv"
  availableEncoders: string[];
  fpsOverride: number | null; // null = auto (source / preset default)

  recent: string[];

  // actions
  init: () => Promise<void>;
  openVideo: (path: string) => Promise<void>;
  closeVideo: () => void;
  transcribe: () => Promise<void>;
  cancelJob: (id: string) => Promise<void>;
  setStyle: (s: CaptionStyle) => void;
  setCensor: (v: boolean) => void;
  updateWord: (segId: string, wordIdx: number, text: string) => void;
  setSelectedModel: (m: string) => void;
  setEncoder: (e: string) => void;
  setFpsOverride: (fps: number | null) => void;
  downloadModel: (name: string) => Promise<void>;
  refreshModels: () => Promise<void>;
  startExport: (req: ExportRequest) => Promise<void>;
  analyzeHighlights: () => Promise<void>;
  setActiveRange: (r: { start: number; end: number } | null) => void;
  toggleHighlightSelected: (rank: number) => void;
  selectAllHighlights: () => void;
  selectNoneHighlights: () => void;
  startEditingHighlight: (h: Highlight) => void;
  stopEditingHighlight: () => void;
  adjustHighlightRange: (rank: number, start: number, end: number) => void;
  exportSelectedHighlights: (outputDir: string) => Promise<void>;
  compileSelectedHighlights: (
    outputPath: string,
    presetId: string,
    customMb: number
  ) => Promise<void>;
  openBatch: () => void;
  addBatchPaths: (paths: string[]) => void;
  addBatchFolder: (dir: string) => Promise<void>;
  removeBatchItem: (id: string) => void;
  clearBatchItems: () => void;
  runFileBatch: (presetId: string, customMb: number, outputDir: string | null) => Promise<void>;
  cancelFileBatch: () => void;
  clearError: () => void;
}

function loadRecent(): string[] {
  try {
    return JSON.parse(localStorage.getItem("cc.recent") ?? "[]");
  } catch {
    return [];
  }
}

export const useApp = create<AppState>((set, get) => ({
  screen: "library",
  error: null,
  videoPath: null,
  previewSrc: null,
  mediaInfo: null,
  segments: [],
  censor: false,
  style: getPreset("beast"),
  highlights: [],
  analyzeJob: null,
  activeRange: null,
  selectedRanks: [],
  clipOverrides: {},
  editingRank: null,
  batch: null,
  batchItems: [],
  batchRunning: false,
  transcribeJob: null,
  exportJob: null,
  exportDone: null,
  modelJob: null,
  models: [],
  selectedModel: localStorage.getItem("cc.model") ?? "small.en",
  encoder: localStorage.getItem("cc.encoder") ?? "auto",
  availableEncoders: ["x264"],
  fpsOverride: (() => {
    const v = localStorage.getItem("cc.fps");
    return v === "30" || v === "60" ? Number(v) : null;
  })(),
  recent: loadRecent(),

  init: async () => {
    if (!isTauri) return;
    await listenJobProgress((p: JobProgressPayload) => {
      // 1) jobs awaited as promises (batch pipeline)
      const pending = pendingJobs.get(p.id);
      if (pending) {
        if (p.error) {
          pendingJobs.delete(p.id);
          pending.reject(new Error(p.error));
        } else if (p.done) {
          pendingJobs.delete(p.id);
          pending.resolve(p.result);
        } else {
          pending.onProgress?.(p);
        }
        return;
      }

      // 2) jobs tracked in UI state
      const { transcribeJob, exportJob, modelJob, analyzeJob } = get();
      const patch = (
        job: JobState | null,
        key: "transcribeJob" | "exportJob" | "modelJob" | "analyzeJob"
      ) => {
        if (!job || job.id !== p.id) return false;
        if (p.error) {
          const quiet = p.error === "Cancelled";
          set({ [key]: null, error: quiet ? null : p.error } as Partial<AppState>);
        } else if (p.done) {
          if (key === "transcribeJob" && p.result) {
            try {
              const segments = JSON.parse(p.result) as Segment[];
              set({ segments, transcribeJob: null });
            } catch {
              set({ transcribeJob: null, error: "Failed to parse transcript" });
            }
          } else if (key === "exportJob") {
            set({ exportJob: null, exportDone: p.result ?? null });
          } else if (key === "analyzeJob" && p.result) {
            try {
              const highlights = JSON.parse(p.result) as Highlight[];
              set({
                highlights,
                analyzeJob: null,
                selectedRanks: highlights.map((h) => h.rank),
                clipOverrides: {},
                editingRank: null,
              });
            } catch {
              set({ analyzeJob: null, error: "Failed to parse highlights" });
            }
          } else {
            set({ [key]: null } as Partial<AppState>);
            void get().refreshModels();
          }
        } else {
          set({
            [key]: { id: p.id, stage: p.stage, progress: p.progress, message: p.message },
          } as Partial<AppState>);
        }
        return true;
      };
      patch(transcribeJob, "transcribeJob") ||
        patch(exportJob, "exportJob") ||
        patch(analyzeJob, "analyzeJob") ||
        patch(modelJob, "modelJob");
    });
    await get().refreshModels();
    try {
      const availableEncoders = await invoke<string[]>("detect_encoders");
      set({ availableEncoders });
    } catch {
      /* keep x264 default */
    }
  },

  refreshModels: async () => {
    if (!isTauri) return;
    try {
      const models = await invoke<ModelInfo[]>("list_models");
      set({ models });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  openVideo: async (path: string) => {
    try {
      set({ error: null });
      const mediaInfo = await invoke<MediaInfo>("probe_video", { path });
      const previewPath = await invoke<string>("prepare_preview", { path });
      const previewSrc = await fileSrc(previewPath);
      const recent = [path, ...get().recent.filter((r) => r !== path)].slice(0, 8);
      localStorage.setItem("cc.recent", JSON.stringify(recent));
      set({
        videoPath: path,
        previewSrc,
        mediaInfo,
        segments: [],
        highlights: [],
        activeRange: null,
        selectedRanks: [],
        clipOverrides: {},
        editingRank: null,
        batch: null,
        exportDone: null,
        screen: "editor",
        recent,
      });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  closeVideo: () => {
    set({
      screen: "library",
      videoPath: null,
      previewSrc: null,
      mediaInfo: null,
      segments: [],
      highlights: [],
      activeRange: null,
      selectedRanks: [],
      clipOverrides: {},
      editingRank: null,
      batch: null,
      transcribeJob: null,
      exportJob: null,
      analyzeJob: null,
      exportDone: null,
    });
  },

  transcribe: async () => {
    const { videoPath, selectedModel, activeRange } = get();
    if (!videoPath) return;
    try {
      set({ error: null, segments: [] });
      const id = await invoke<string>("transcribe", {
        path: videoPath,
        model: selectedModel,
        start: activeRange?.start ?? null,
        end: activeRange?.end ?? null,
      });
      set({ transcribeJob: { id, stage: "starting", progress: -1 } });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  cancelJob: async (id: string) => {
    try {
      await invoke("cancel_job", { id });
    } catch {
      /* ignore */
    }
  },

  setStyle: (style) => set({ style }),
  setCensor: (censor) => set({ censor }),

  updateWord: (segId, wordIdx, text) => {
    set({
      segments: get().segments.map((s) =>
        s.id !== segId
          ? s
          : { ...s, words: s.words.map((w, i) => (i === wordIdx ? { ...w, text } : w)) }
      ),
    });
  },

  setSelectedModel: (m) => {
    localStorage.setItem("cc.model", m);
    set({ selectedModel: m });
  },

  setEncoder: (encoder) => {
    localStorage.setItem("cc.encoder", encoder);
    set({ encoder });
  },

  setFpsOverride: (fpsOverride) => {
    localStorage.setItem("cc.fps", fpsOverride == null ? "auto" : String(fpsOverride));
    set({ fpsOverride });
  },

  downloadModel: async (name) => {
    try {
      const id = await invoke<string>("ensure_model", { name });
      set({ modelJob: { id, stage: "downloading", progress: 0 } });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  startExport: async (req) => {
    try {
      set({ error: null, exportDone: null });
      const id = await invoke<string>("export_video", { req });
      set({ exportJob: { id, stage: "starting", progress: 0 } });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  analyzeHighlights: async () => {
    const { videoPath } = get();
    if (!videoPath) return;
    try {
      set({ error: null, highlights: [] });
      const id = await invoke<string>("analyze_highlights", {
        path: videoPath,
        maxCount: 12,
      });
      set({ analyzeJob: { id, stage: "analyzing", progress: 0 } });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  setActiveRange: (activeRange) => set({ activeRange }),

  toggleHighlightSelected: (rank) => {
    const { selectedRanks } = get();
    set({
      selectedRanks: selectedRanks.includes(rank)
        ? selectedRanks.filter((r) => r !== rank)
        : [...selectedRanks, rank],
    });
  },

  selectAllHighlights: () => set({ selectedRanks: get().highlights.map((h) => h.rank) }),
  selectNoneHighlights: () => set({ selectedRanks: [] }),

  /** Open a highlight's range for manual extend/trim; auto-includes it in the export selection. */
  startEditingHighlight: (h) => {
    const { clipOverrides, selectedRanks } = get();
    const range = clipOverrides[h.rank] ?? { start: h.start, end: h.end };
    set({
      activeRange: range,
      editingRank: h.rank,
      selectedRanks: selectedRanks.includes(h.rank) ? selectedRanks : [...selectedRanks, h.rank],
    });
  },

  stopEditingHighlight: () => set({ editingRank: null }),

  adjustHighlightRange: (rank, start, end) => {
    const dur = get().mediaInfo?.durationSec ?? Infinity;
    const s = Math.max(0, Math.min(start, end - 0.5));
    const e = Math.max(s + 0.5, Math.min(end, dur));
    set({
      clipOverrides: { ...get().clipOverrides, [rank]: { start: s, end: e } },
      activeRange: get().editingRank === rank ? { start: s, end: e } : get().activeRange,
    });
  },

  /**
   * For every checked highlight (using the user's extended/trimmed range if they
   * adjusted it) — transcribe just that window, build captions in the current
   * style, cut the clip, burn, save.
   */
  exportSelectedHighlights: async (outputDir: string) => {
    const { highlights, videoPath, mediaInfo, selectedModel, selectedRanks, clipOverrides } =
      get();
    const clips = highlights.filter((h) => selectedRanks.includes(h.rank));
    if (!videoPath || !mediaInfo || clips.length === 0) return;

    const baseName =
      videoPath
        .split(/[/\\]/)
        .pop()
        ?.replace(/\.[^.]+$/, "") ?? "clip";
    const total = clips.length;

    try {
      for (let i = 0; i < clips.length; i++) {
        const h = clips[i];
        const range = clipOverrides[h.rank] ?? { start: h.start, end: h.end };
        const { style, censor } = get(); // re-read so mid-batch tweaks apply

        set({
          batch: { current: i + 1, total, stage: "transcribing", outputDir },
        });
        const tid = await invoke<string>("transcribe", {
          path: videoPath,
          model: selectedModel,
          start: range.start,
          end: range.end,
        });
        const result = await waitForJob(tid);
        const segments = result ? (JSON.parse(result) as Segment[]) : [];
        const segs = censor ? applyCensor(segments) : segments;
        const pages = shiftPages(paginate(segs, style.maxWordsPerPage), range.start);
        const ass =
          pages.length > 0
            ? buildAss(pages, style, {
                playResX: mediaInfo.width,
                playResY: mediaInfo.height,
              })
            : "";

        set({
          batch: { current: i + 1, total, stage: "exporting", outputDir },
        });
        const n = String(h.rank).padStart(2, "0");
        const outputPath = `${outputDir}/${baseName}_highlight_${n}.mp4`;
        const eid = await invoke<string>("export_video", {
          req: {
            inputPath: videoPath,
            outputPath,
            assContent: ass,
            targetW: null,
            targetH: null,
            targetSizeMb: null,
            crf: 20,
            fps: get().fpsOverride,
            audioKbps: 160,
            durationSec: mediaInfo.durationSec,
            trimStart: range.start,
            trimEnd: range.end,
            cutRanges: null,
            encoder: get().encoder,
          } satisfies ExportRequest,
        });
        await waitForJob(eid);
      }
      set({ batch: null, exportDone: outputDir });
    } catch (e) {
      set({ batch: null, error: String(e) });
    }
  },

  /**
   * Compile every checked highlight into a single output file, in the order
   * they occur in the source video (not detection rank) — transcribe each
   * clip, merge their captions onto one continuous timeline, then cut +
   * concatenate + burn + compress in one ffmpeg pass at the chosen preset.
   */
  compileSelectedHighlights: async (outputPath, presetId, customMb) => {
    const { highlights, videoPath, mediaInfo, selectedModel, selectedRanks, clipOverrides } =
      get();
    const ordered = highlights
      .filter((h) => selectedRanks.includes(h.rank))
      .map((h) => ({ h, range: clipOverrides[h.rank] ?? { start: h.start, end: h.end } }))
      .sort((a, b) => a.range.start - b.range.start);
    if (!videoPath || !mediaInfo || ordered.length === 0) return;

    const preset = getExportPreset(presetId);
    const total = ordered.length;
    let cumulative = 0;
    let mergedPages: CaptionPage[] = [];
    const cutRanges: [number, number][] = [];

    try {
      set({ error: null, exportDone: null });
      for (let i = 0; i < ordered.length; i++) {
        const { range } = ordered[i];
        const { style, censor } = get(); // re-read so mid-run tweaks apply to later clips
        set({ batch: { current: i + 1, total, stage: "transcribing", outputDir: outputPath } });

        const tid = await invoke<string>("transcribe", {
          path: videoPath,
          model: selectedModel,
          start: range.start,
          end: range.end,
        });
        const result = await waitForJob(tid);
        const segments = result ? (JSON.parse(result) as Segment[]) : [];
        const segs = censor ? applyCensor(segments) : segments;
        const pages = paginate(segs, style.maxWordsPerPage);
        // source time t -> (t - range.start) + cumulative on the compiled timeline
        mergedPages = mergedPages.concat(shiftPages(pages, range.start - cumulative));
        cutRanges.push([range.start, range.end]);
        cumulative += range.end - range.start;
      }

      set({ batch: { current: total, total, stage: "exporting", outputDir: outputPath } });
      const { style } = get();
      const outW = preset.targetW ?? mediaInfo.width;
      const outH = preset.targetH ?? mediaInfo.height;
      const ass =
        mergedPages.length > 0
          ? buildAss(mergedPages, style, { playResX: outW, playResY: outH })
          : "";

      const eid = await invoke<string>("export_video", {
        req: {
          inputPath: videoPath,
          outputPath,
          assContent: ass,
          targetW: preset.targetW,
          targetH: preset.targetH,
          targetSizeMb: presetId === "custom" ? customMb : preset.targetSizeMB,
          crf: preset.crf,
          fps: get().fpsOverride ?? preset.fps,
          audioKbps: preset.audioKbps,
          durationSec: cumulative,
          trimStart: null,
          trimEnd: null,
          cutRanges,
          encoder: get().encoder,
        } satisfies ExportRequest,
      });
      await waitForJob(eid);
      set({ batch: null, exportDone: outputPath });
    } catch (e) {
      set({ batch: null, error: String(e) });
    }
  },

  openBatch: () => set({ screen: "batch", exportDone: null }),

  addBatchPaths: (paths) => {
    const existing = new Set(get().batchItems.map((i) => i.path));
    const items: BatchItem[] = paths
      .filter((p) => !existing.has(p))
      .map((p) => ({
        id: nextId("bi"),
        path: p,
        name: p.split(/[/\\]/).pop() ?? p,
        status: "pending",
        progress: -1,
      }));
    if (items.length) set({ batchItems: [...get().batchItems, ...items] });
  },

  addBatchFolder: async (dir) => {
    try {
      const paths = await invoke<string[]>("list_videos", { dir });
      if (paths.length === 0) {
        set({ error: "No video files found in that folder" });
        return;
      }
      get().addBatchPaths(paths);
    } catch (e) {
      set({ error: String(e) });
    }
  },

  removeBatchItem: (id) =>
    set({ batchItems: get().batchItems.filter((i) => i.id !== id) }),

  clearBatchItems: () => set({ batchItems: [] }),

  /**
   * Process every queued clip: transcribe whole clip -> style captions ->
   * export with the chosen preset. Continues past per-file failures.
   */
  runFileBatch: async (presetId, customMb, outputDir) => {
    const { selectedModel } = get();
    const preset = getExportPreset(presetId);
    batchCancelRequested = false;
    set({ batchRunning: true, error: null });

    const setItem = (id: string, patch: Partial<BatchItem>) =>
      set({
        batchItems: get().batchItems.map((i) => (i.id === id ? { ...i, ...patch } : i)),
      });

    for (const item of get().batchItems) {
      if (batchCancelRequested) {
        if (item.status === "pending") setItem(item.id, { status: "skipped" });
        continue;
      }
      if (item.status !== "pending") continue;

      const { style, censor } = get(); // mid-batch tweaks apply to later clips
      try {
        setItem(item.id, { status: "transcribing", progress: -1 });
        const info = await invoke<MediaInfo>("probe_video", { path: item.path });

        const tid = await invoke<string>("transcribe", {
          path: item.path,
          model: selectedModel,
          start: null,
          end: null,
        });
        currentBatchJobId = tid;
        const result = await waitForJob(tid, (p) =>
          setItem(item.id, { progress: p.progress })
        );
        currentBatchJobId = null;

        const segments = result ? (JSON.parse(result) as Segment[]) : [];
        const segs = censor ? applyCensor(segments) : segments;
        const pages = paginate(segs, style.maxWordsPerPage);
        const outW = preset.targetW ?? info.width;
        const outH = preset.targetH ?? info.height;
        const ass =
          pages.length > 0
            ? buildAss(pages, style, { playResX: outW, playResY: outH })
            : "";

        const dir =
          outputDir ?? item.path.slice(0, Math.max(item.path.lastIndexOf("/"), item.path.lastIndexOf("\\")));
        const stem = item.name.replace(/\.[^.]+$/, "");
        const outputPath = `${dir}/${stem}.captioned.mp4`;

        setItem(item.id, { status: "exporting", progress: 0 });
        const eid = await invoke<string>("export_video", {
          req: {
            inputPath: item.path,
            outputPath,
            assContent: ass,
            targetW: preset.targetW,
            targetH: preset.targetH,
            targetSizeMb: presetId === "custom" ? customMb : preset.targetSizeMB,
            crf: preset.crf,
            fps: get().fpsOverride ?? preset.fps,
            audioKbps: preset.audioKbps,
            durationSec: info.durationSec,
            trimStart: null,
            trimEnd: null,
            cutRanges: null,
            encoder: get().encoder,
          } satisfies ExportRequest,
        });
        currentBatchJobId = eid;
        await waitForJob(eid, (p) => setItem(item.id, { progress: p.progress }));
        currentBatchJobId = null;

        setItem(item.id, { status: "done", progress: 1, output: outputPath });
      } catch (e) {
        currentBatchJobId = null;
        const msg = e instanceof Error ? e.message : String(e);
        setItem(item.id, {
          status: batchCancelRequested && msg === "Cancelled" ? "skipped" : "error",
          error: msg,
        });
      }
    }

    set({ batchRunning: false });
  },

  cancelFileBatch: () => {
    batchCancelRequested = true;
    if (currentBatchJobId) {
      void get().cancelJob(currentBatchJobId);
    }
  },

  clearError: () => set({ error: null }),
}));
