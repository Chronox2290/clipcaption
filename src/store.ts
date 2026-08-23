import { create } from "zustand";
import type {
  CaptionStyle,
  ExportRequest,
  JobProgressPayload,
  MediaInfo,
  ModelInfo,
  Segment,
} from "./types";
import { invoke, fileSrc, listenJobProgress, isTauri } from "./lib/tauri";
import { getPreset } from "./lib/styles";

interface JobState {
  id: string;
  stage: string;
  progress: number;
  message?: string;
}

interface AppState {
  screen: "library" | "editor";
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

  // jobs
  transcribeJob: JobState | null;
  exportJob: JobState | null;
  exportDone: string | null; // finished output path
  modelJob: JobState | null;

  // models
  models: ModelInfo[];
  selectedModel: string;

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
  downloadModel: (name: string) => Promise<void>;
  refreshModels: () => Promise<void>;
  startExport: (req: ExportRequest) => Promise<void>;
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
  transcribeJob: null,
  exportJob: null,
  exportDone: null,
  modelJob: null,
  models: [],
  selectedModel: localStorage.getItem("cc.model") ?? "small.en",
  recent: loadRecent(),

  init: async () => {
    if (!isTauri) return;
    await listenJobProgress((p: JobProgressPayload) => {
      const { transcribeJob, exportJob, modelJob } = get();
      const patch = (job: JobState | null, key: "transcribeJob" | "exportJob" | "modelJob") => {
        if (!job || job.id !== p.id) return false;
        if (p.error) {
          set({ [key]: null, error: p.error } as Partial<AppState>);
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
        patch(modelJob, "modelJob");
    });
    await get().refreshModels();
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
      transcribeJob: null,
      exportJob: null,
      exportDone: null,
    });
  },

  transcribe: async () => {
    const { videoPath, selectedModel } = get();
    if (!videoPath) return;
    try {
      set({ error: null, segments: [] });
      const id = await invoke<string>("transcribe", {
        path: videoPath,
        model: selectedModel,
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

  clearError: () => set({ error: null }),
}));
