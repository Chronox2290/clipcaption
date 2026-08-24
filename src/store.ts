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
  TranscribeResult,
  ProjectFile,
} from "./types";
import {
  invoke,
  fileSrc,
  listenJobProgress,
  isTauri,
  pickProjectSavePath,
  pickProjectOpenPath,
} from "./lib/tauri";
import { getPreset } from "./lib/styles";
import { applyCensor, distributeWordTimes, nextId, paginate, shiftPages } from "./lib/captions";
import { addEmojis } from "./lib/emojis";
import { getExportPreset, resolveResolution } from "./lib/exportPresets";
import { buildAss } from "./lib/ass";
import { sanitizeFilename } from "./lib/naming";

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

// The live Update handle from @tauri-apps/plugin-updater, once a check finds
// one. It carries a downloadAndInstall() method and isn't plain data, so —
// same reasoning as pendingJobs above — it lives outside the store instead of
// in state; only the plain fields the UI needs (version, body, progress) go
// into AppState.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pendingUpdate: any = null;

interface AppState {
  screen: "library" | "editor" | "batch";
  error: string | null;

  // media
  videoPath: string | null;
  previewSrc: string | null;
  mediaInfo: MediaInfo | null;
  /** Path of the .ccproj file this session was saved to/loaded from, so
   * "Save Project" can write straight back without prompting again. */
  projectPath: string | null;

  // transcript
  segments: Segment[];
  censor: boolean;
  /** Highlight rank the current `segments` were captioned for via "Caption
   * this range", so the Transcript tab can show which clip is being edited.
   * Null for a whole-clip transcript. */
  transcriptSourceRank: number | null;
  /** Waveform amplitude envelope for `segments`' time range, for the word
   * timing editor — a free byproduct of transcription, so it arrives (or
   * clears) alongside segments. */
  waveform: number[];
  waveformStep: number;
  /** Full-video-timeline seconds `waveform[0]` represents — see TranscribeResult. */
  waveformOffset: number;
  /** Word currently selected for fine-tuning — drives both the nudge panel in
   * the Transcript tab and which word is highlighted in the main waveform
   * editor beneath the video. Null when nothing is selected. */
  tuningWord: { segId: string; idx: number } | null;

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
  /** User-assigned custom name per highlight rank — used as the export filename
   * (sanitized) instead of the auto-generated "_highlight_NN" pattern when set. */
  clipNames: Record<number, string>;
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
  /** Speaker-turn detection (tinydiarize) — off by default since it forces a
   * smaller, less accurate model in exchange for speaker awareness. */
  diarizeEnabled: boolean;

  // encoding options
  encoder: string; // "auto" | "x264" | "nvenc" | "amf" | "qsv"
  availableEncoders: string[];
  fpsOverride: number | null; // null = auto (source / preset default)

  recent: string[];

  // auto-update (GitHub Releases via tauri-plugin-updater)
  appVersion: string | null;
  updateStatus: "idle" | "checking" | "available" | "none" | "downloading" | "error";
  updateInfo: { version: string; body: string | null } | null;
  updateProgress: number | null;
  updateError: string | null;

  // actions
  init: () => Promise<void>;
  /** silent=true (used for the automatic startup check) stays quiet when
   * there's nothing new or the check fails — no point nagging the user with
   * a network hiccup they didn't ask about. The manual "Check for updates"
   * button passes silent=false so it always reports something. */
  checkForUpdates: (silent?: boolean) => Promise<void>;
  installUpdate: () => Promise<void>;
  dismissUpdateBanner: () => void;
  openVideo: (path: string) => Promise<void>;
  closeVideo: () => void;
  transcribe: () => Promise<void>;
  cancelJob: (id: string) => Promise<void>;
  setStyle: (s: CaptionStyle) => void;
  setCensor: (v: boolean) => void;
  updateWord: (segId: string, wordIdx: number, text: string) => void;
  /** Inserts a new word box at `atIndex` (0 = before the first word, words.length = append). */
  insertWord: (segId: string, atIndex: number) => void;
  removeWord: (segId: string, wordIdx: number) => void;
  setWordTime: (segId: string, wordIdx: number, field: "start" | "end", time: number) => void;
  setTuningWord: (w: { segId: string; idx: number } | null) => void;
  /** Creates a brand-new caption from scratch at an absolute-timeline range
   * that whisper produced nothing for at all (not just a mistimed word) —
   * used by the main waveform editor's click-drag-on-empty-space gesture.
   * Returns the new segment's id. */
  insertSegment: (start: number, end: number, text: string) => string;
  setSelectedModel: (m: string) => void;
  setDiarizeEnabled: (v: boolean) => void;
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
  setClipName: (rank: number, name: string) => void;
  exportSelectedHighlights: (
    outputDir: string,
    presetId?: string,
    customMb?: number,
    resolutionId?: string,
    fitMode?: "fill" | "fit"
  ) => Promise<void>;
  compileSelectedHighlights: (
    outputPath: string,
    presetId: string,
    customMb: number,
    resolutionId?: string,
    fitMode?: "fill" | "fit"
  ) => Promise<void>;
  openBatch: () => void;
  addBatchPaths: (paths: string[]) => void;
  addBatchFolder: (dir: string) => Promise<void>;
  removeBatchItem: (id: string) => void;
  clearBatchItems: () => void;
  runFileBatch: (
    presetId: string,
    customMb: number,
    outputDir: string | null,
    resolutionId?: string,
    fitMode?: "fill" | "fit"
  ) => Promise<void>;
  cancelFileBatch: () => void;
  clearError: () => void;
  /** Returns true if the project was actually written (false if e.g. the save
   * dialog was cancelled or there's no open video). */
  saveProject: () => Promise<boolean>;
  saveProjectAs: () => Promise<boolean>;
  loadProject: () => Promise<void>;
  /** Internal — shared write path for saveProject/saveProjectAs. Not called from the UI. */
  _writeProject: (path: string) => Promise<boolean>;
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
  projectPath: null,
  segments: [],
  censor: false,
  transcriptSourceRank: null,
  waveform: [],
  waveformStep: 0.01,
  waveformOffset: 0,
  tuningWord: null,
  style: getPreset("beast"),
  highlights: [],
  analyzeJob: null,
  activeRange: null,
  selectedRanks: [],
  clipOverrides: {},
  clipNames: {},
  editingRank: null,
  batch: null,
  batchItems: [],
  batchRunning: false,
  transcribeJob: null,
  exportJob: null,
  exportDone: null,
  modelJob: null,
  models: [],
  selectedModel: localStorage.getItem("cc.model") ?? "large-v3-turbo",
  diarizeEnabled: localStorage.getItem("cc.diarize") === "1",
  encoder: localStorage.getItem("cc.encoder") ?? "auto",
  availableEncoders: ["x264"],
  fpsOverride: (() => {
    const v = localStorage.getItem("cc.fps");
    return v === "30" || v === "60" ? Number(v) : null;
  })(),
  recent: loadRecent(),

  appVersion: null,
  updateStatus: "idle",
  updateInfo: null,
  updateProgress: null,
  updateError: null,

  init: async () => {
    if (!isTauri) return;
    void (async () => {
      try {
        const { getVersion } = await import("@tauri-apps/api/app");
        set({ appVersion: await getVersion() });
      } catch {
        // non-essential — version just won't show in the UI
      }
    })();
    // Give the window a moment to paint before doing a network check no one
    // asked for yet; stays silent unless it actually finds something.
    setTimeout(() => void get().checkForUpdates(true), 2500);
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
              const { segments, waveform, waveformStep, waveformOffset } = JSON.parse(
                p.result
              ) as TranscribeResult;
              set({ segments, waveform, waveformStep, waveformOffset, transcribeJob: null });
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
                clipNames: {},
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
        projectPath: null,
        segments: [],
        transcriptSourceRank: null,
        waveform: [],
        waveformStep: 0.01,
        waveformOffset: 0,
        tuningWord: null,
        highlights: [],
        activeRange: null,
        selectedRanks: [],
        clipOverrides: {},
        clipNames: {},
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
      projectPath: null,
      segments: [],
      transcriptSourceRank: null,
      waveform: [],
      waveformStep: 0.01,
      waveformOffset: 0,
      tuningWord: null,
      highlights: [],
      activeRange: null,
      selectedRanks: [],
      clipOverrides: {},
      clipNames: {},
      editingRank: null,
      batch: null,
      transcribeJob: null,
      exportJob: null,
      analyzeJob: null,
      exportDone: null,
    });
  },

  transcribe: async () => {
    const { videoPath, selectedModel, activeRange, editingRank, diarizeEnabled } = get();
    if (!videoPath) return;
    try {
      // editingRank is only set while a highlight's trim controls are open,
      // so this correctly clears to null for a plain whole-clip transcribe.
      set({
        error: null,
        segments: [],
        transcriptSourceRank: editingRank,
        waveform: [],
        waveformStep: 0.01,
        waveformOffset: 0,
        tuningWord: null,
      });
      const id = await invoke<string>("transcribe", {
        path: videoPath,
        model: selectedModel,
        start: activeRange?.start ?? null,
        end: activeRange?.end ?? null,
        diarize: diarizeEnabled,
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

  insertWord: (segId, atIndex) => {
    set({
      segments: get().segments.map((s) => {
        if (s.id !== segId) return s;
        const words = s.words;
        const i = Math.max(0, Math.min(atIndex, words.length));
        // Split the gap the new word lands in: right after the previous word
        // (or just before the next one, if inserting at the very start),
        // with a short default duration so it doesn't swallow the whole gap.
        const prevEnd = i > 0 ? words[i - 1].end : Math.max(0, (words[0]?.start ?? 0.4) - 0.4);
        const nextStart = i < words.length ? words[i].start : prevEnd + 0.4;
        const dur = Math.max(0.05, Math.min(0.4, nextStart - prevEnd));
        const word = { text: "word", start: prevEnd, end: prevEnd + dur };
        return { ...s, words: [...words.slice(0, i), word, ...words.slice(i)] };
      }),
    });
  },

  /** Removes a word box outright; drops the whole segment row if it was the last one left. */
  removeWord: (segId, wordIdx) => {
    set({
      segments: get()
        .segments.map((s) =>
          s.id !== segId ? s : { ...s, words: s.words.filter((_, i) => i !== wordIdx) }
        )
        .filter((s) => s.words.length > 0),
    });
  },

  /** Manually re-times a word (nudge, or "sync to playhead") so captions can
   * be tuned to match the actual voice when whisper's own timestamp is off. */
  setWordTime: (segId, wordIdx, field, time) => {
    set({
      segments: get().segments.map((s) => {
        if (s.id !== segId) return s;
        return {
          ...s,
          words: s.words.map((w, i) => {
            if (i !== wordIdx) return w;
            const t = Math.max(0, time);
            return field === "start"
              ? { ...w, start: Math.min(t, w.end - 0.02) }
              : { ...w, end: Math.max(t, w.start + 0.02) };
          }),
        };
      }),
    });
  },

  setTuningWord: (w) => set({ tuningWord: w }),

  /** Creates a brand-new one-word segment at an absolute-timeline [start,end]
   * range and drops it into `segments` in chronological order — the words
   * list stays sorted so pagination/rendering keep working the same as any
   * whisper-produced segment. Used when whisper missed a stretch of speech
   * entirely (no segment at all covers that time), which `insertWord` can't
   * fix since it only adds a word inside an *existing* segment. */
  insertSegment: (start, end, text) => {
    const id = nextId("useg");
    const s0 = Math.max(0, Math.min(start, end - 0.02));
    const e0 = Math.max(s0 + 0.02, end);
    // Split what was typed into individual words (see distributeWordTimes) so
    // a hand-typed line gets the same per-word highlight animation and
    // drag-to-retime as anything whisper produced, instead of behaving as one
    // frozen block of text for its whole duration.
    const tokens = text.trim().split(/\s+/).filter(Boolean);
    const words = tokens.length ? distributeWordTimes(tokens, s0, e0) : [{ text: "word", start: s0, end: e0 }];
    const seg: Segment = { id, words, speaker: null };
    const segments = [...get().segments, seg].sort(
      (a, b) => (a.words[0]?.start ?? 0) - (b.words[0]?.start ?? 0)
    );
    set({ segments });
    return id;
  },

  setSelectedModel: (m) => {
    localStorage.setItem("cc.model", m);
    set({ selectedModel: m });
  },

  setDiarizeEnabled: (v) => {
    localStorage.setItem("cc.diarize", v ? "1" : "0");
    set({ diarizeEnabled: v });
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

  /** Names a highlight for display and as its export filename. An empty/whitespace
   * name clears the override, falling back to the auto-generated "_highlight_NN". */
  setClipName: (rank, name) => {
    const trimmed = name.trim();
    const next = { ...get().clipNames };
    if (trimmed) next[rank] = trimmed;
    else delete next[rank];
    set({ clipNames: next });
  },

  /**
   * For every checked highlight (using the user's extended/trimmed range if they
   * adjusted it) — transcribe just that window, build captions in the current
   * style, cut the clip, burn, save.
   */
  exportSelectedHighlights: async (
    outputDir: string,
    presetId = "original",
    customMb = 25,
    resolutionId = "source",
    fitMode: "fill" | "fit" = "fill"
  ) => {
    const {
      highlights,
      videoPath,
      mediaInfo,
      selectedModel,
      selectedRanks,
      clipOverrides,
      clipNames,
      diarizeEnabled,
    } = get();
    const clips = highlights.filter((h) => selectedRanks.includes(h.rank));
    if (!videoPath || !mediaInfo || clips.length === 0) return;

    const preset = getExportPreset(presetId);
    const { targetW, targetH, maxHeight } = resolveResolution(preset, resolutionId);
    const outW = targetW ?? mediaInfo.width;
    const outH = targetH ?? mediaInfo.height;

    const baseName =
      videoPath
        .split(/[/\\]/)
        .pop()
        ?.replace(/\.[^.]+$/, "") ?? "clip";
    const total = clips.length;
    const usedNames = new Set<string>();

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
          diarize: diarizeEnabled,
        });
        const result = await waitForJob(tid);
        const segments = result ? (JSON.parse(result) as TranscribeResult).segments : [];
        let segs = censor ? applyCensor(segments) : segments;
        if (style.emojis) segs = addEmojis(segs);
        const pages = shiftPages(paginate(segs, style.maxWordsPerPage), range.start);
        const ass =
          pages.length > 0
            ? buildAss(pages, style, { playResX: outW, playResY: outH })
            : "";

        set({
          batch: { current: i + 1, total, stage: "exporting", outputDir },
        });
        const n = String(h.rank).padStart(2, "0");
        const fallback = `${baseName}_highlight_${n}`;
        const custom = clipNames[h.rank];
        let stem = custom ? sanitizeFilename(custom, fallback) : fallback;
        // Guard against two clips landing on the same name (custom names collide,
        // or a sanitized name happens to match another) — never silently overwrite.
        if (usedNames.has(stem)) {
          let i2 = 2;
          while (usedNames.has(`${stem} (${i2})`)) i2++;
          stem = `${stem} (${i2})`;
        }
        usedNames.add(stem);
        const outputPath = `${outputDir}/${stem}.mp4`;
        const eid = await invoke<string>("export_video", {
          req: {
            inputPath: videoPath,
            outputPath,
            assContent: ass,
            targetW,
            targetH,
            targetSizeMb: presetId === "custom" ? customMb : preset.targetSizeMB,
            crf: preset.crf,
            fps: get().fpsOverride ?? preset.fps,
            audioKbps: preset.audioKbps,
            durationSec: mediaInfo.durationSec,
            trimStart: range.start,
            trimEnd: range.end,
            cutRanges: null,
            encoder: get().encoder,
            fitMode: targetW && targetH ? fitMode : null,
            maxHeight,
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
  compileSelectedHighlights: async (
    outputPath,
    presetId,
    customMb,
    resolutionId = "source",
    fitMode = "fill"
  ) => {
    const {
      highlights,
      videoPath,
      mediaInfo,
      selectedModel,
      selectedRanks,
      clipOverrides,
      diarizeEnabled,
    } = get();
    const ordered = highlights
      .filter((h) => selectedRanks.includes(h.rank))
      .map((h) => ({ h, range: clipOverrides[h.rank] ?? { start: h.start, end: h.end } }))
      .sort((a, b) => a.range.start - b.range.start);
    if (!videoPath || !mediaInfo || ordered.length === 0) return;

    const preset = getExportPreset(presetId);
    const { targetW, targetH, maxHeight } = resolveResolution(preset, resolutionId);
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
          diarize: diarizeEnabled,
        });
        const result = await waitForJob(tid);
        const segments = result ? (JSON.parse(result) as TranscribeResult).segments : [];
        let segs = censor ? applyCensor(segments) : segments;
        if (style.emojis) segs = addEmojis(segs);
        const pages = paginate(segs, style.maxWordsPerPage);
        // source time t -> (t - range.start) + cumulative on the compiled timeline
        mergedPages = mergedPages.concat(shiftPages(pages, range.start - cumulative));
        cutRanges.push([range.start, range.end]);
        cumulative += range.end - range.start;
      }

      set({ batch: { current: total, total, stage: "exporting", outputDir: outputPath } });
      const { style } = get();
      const outW = targetW ?? mediaInfo.width;
      const outH = targetH ?? mediaInfo.height;
      const ass =
        mergedPages.length > 0
          ? buildAss(mergedPages, style, { playResX: outW, playResY: outH })
          : "";

      const eid = await invoke<string>("export_video", {
        req: {
          inputPath: videoPath,
          outputPath,
          assContent: ass,
          targetW,
          targetH,
          targetSizeMb: presetId === "custom" ? customMb : preset.targetSizeMB,
          crf: preset.crf,
          fps: get().fpsOverride ?? preset.fps,
          audioKbps: preset.audioKbps,
          durationSec: cumulative,
          trimStart: null,
          trimEnd: null,
          cutRanges,
          encoder: get().encoder,
          fitMode: targetW && targetH ? fitMode : null,
          maxHeight,
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
  runFileBatch: async (presetId, customMb, outputDir, resolutionId = "source", fitMode = "fill") => {
    const { selectedModel, diarizeEnabled } = get();
    const preset = getExportPreset(presetId);
    const { targetW, targetH, maxHeight } = resolveResolution(preset, resolutionId);
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
          diarize: diarizeEnabled,
        });
        currentBatchJobId = tid;
        const result = await waitForJob(tid, (p) =>
          setItem(item.id, { progress: p.progress })
        );
        currentBatchJobId = null;

        const segments = result ? (JSON.parse(result) as TranscribeResult).segments : [];
        let segs = censor ? applyCensor(segments) : segments;
        if (style.emojis) segs = addEmojis(segs);
        const pages = paginate(segs, style.maxWordsPerPage);
        const outW = targetW ?? info.width;
        const outH = targetH ?? info.height;
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
            targetW,
            targetH,
            targetSizeMb: presetId === "custom" ? customMb : preset.targetSizeMB,
            crf: preset.crf,
            fps: get().fpsOverride ?? preset.fps,
            audioKbps: preset.audioKbps,
            durationSec: info.durationSec,
            trimStart: null,
            trimEnd: null,
            cutRanges: null,
            encoder: get().encoder,
            fitMode: targetW && targetH ? fitMode : null,
            maxHeight,
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

  checkForUpdates: async (silent = false) => {
    if (!isTauri) return;
    set({ updateStatus: "checking", updateError: null });
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (update) {
        pendingUpdate = update;
        set({
          updateStatus: "available",
          updateInfo: { version: update.version, body: update.body ?? null },
        });
      } else {
        pendingUpdate = null;
        set({ updateStatus: silent ? "idle" : "none", updateInfo: null });
      }
    } catch (e) {
      pendingUpdate = null;
      set({ updateStatus: silent ? "idle" : "error", updateError: String(e) });
    }
  },

  installUpdate: async () => {
    if (!pendingUpdate) return;
    set({ updateStatus: "downloading", updateProgress: null, updateError: null });
    try {
      let total = 0;
      let done = 0;
      await pendingUpdate.downloadAndInstall(
        (event: { event: string; data?: { contentLength?: number; chunkLength?: number } }) => {
          if (event.event === "Started") {
            total = event.data?.contentLength ?? 0;
            set({ updateProgress: total ? 0 : null });
          } else if (event.event === "Progress") {
            done += event.data?.chunkLength ?? 0;
            set({ updateProgress: total ? Math.min(99, Math.round((done / total) * 100)) : null });
          } else if (event.event === "Finished") {
            set({ updateProgress: 100 });
          }
        }
      );
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (e) {
      set({ updateStatus: "error", updateError: String(e) });
    }
  },

  dismissUpdateBanner: () => set({ updateStatus: "idle" }),

  saveProject: async () => {
    const existing = get().projectPath;
    if (existing) return get()._writeProject(existing);
    return get().saveProjectAs();
  },

  saveProjectAs: async () => {
    const { videoPath } = get();
    if (!videoPath) return false;
    const base =
      videoPath
        .split(/[/\\]/)
        .pop()
        ?.replace(/\.[^.]+$/, "") ?? "project";
    const path = await pickProjectSavePath(`${base}.ccproj`);
    if (!path) return false;
    return get()._writeProject(path);
  },

  // Not part of AppState's public surface (no UI calls it directly) — shared
  // write path for saveProject/saveProjectAs once a target path is known.
  _writeProject: async (path: string) => {
    const {
      videoPath,
      selectedModel,
      style,
      censor,
      highlights,
      clipOverrides,
      clipNames,
      selectedRanks,
      activeRange,
      segments,
      transcriptSourceRank,
      waveform,
      waveformStep,
      waveformOffset,
    } = get();
    if (!videoPath) return false;
    const project: ProjectFile = {
      version: 1,
      videoPath,
      selectedModel,
      style,
      censor,
      highlights,
      clipOverrides,
      clipNames,
      selectedRanks,
      activeRange,
      segments,
      transcriptSourceRank,
      waveform,
      waveformStep,
      waveformOffset,
    };
    try {
      await invoke("write_text_file", { path, content: JSON.stringify(project, null, 2) });
      set({ projectPath: path });
      return true;
    } catch (e) {
      set({ error: String(e) });
      return false;
    }
  },

  loadProject: async () => {
    const path = await pickProjectOpenPath();
    if (!path) return;
    try {
      const raw = await invoke<string>("read_text_file", { path });
      const project = JSON.parse(raw) as ProjectFile;
      await get().openVideo(project.videoPath); // resets to a clean slate for that video
      set({
        selectedModel: project.selectedModel ?? get().selectedModel,
        style: project.style ?? get().style,
        censor: project.censor ?? get().censor,
        highlights: project.highlights ?? [],
        clipOverrides: project.clipOverrides ?? {},
        clipNames: project.clipNames ?? {},
        selectedRanks: project.selectedRanks ?? [],
        activeRange: project.activeRange ?? null,
        segments: project.segments ?? [],
        transcriptSourceRank: project.transcriptSourceRank ?? null,
        waveform: project.waveform ?? [],
        waveformStep: project.waveformStep ?? 0.01,
        waveformOffset: project.waveformOffset ?? 0,
        projectPath: path,
      });
    } catch (e) {
      set({ error: String(e) });
    }
  },
}));
