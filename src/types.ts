// Shared app types

export interface WordSpan {
  text: string;
  start: number; // seconds
  end: number; // seconds
}

export interface Segment {
  id: string;
  words: WordSpan[];
}

/** What a "transcribe" job resolves with — the word-level transcript plus a
 * waveform amplitude envelope (free byproduct of the audio already extracted
 * for Whisper) used to draw the word-timing editor. */
export interface TranscribeResult {
  segments: Segment[];
  /** RMS amplitude, 0..1, one value per `waveformStep` seconds. */
  waveform: number[];
  waveformStep: number;
  /** Full-video-timeline seconds that `waveform[0]` represents — add this to
   * `bucketIndex * waveformStep` to line the waveform up with word times. */
  waveformOffset: number;
}

/** A caption "page" — the chunk of words shown on screen at once. */
export interface CaptionPage {
  start: number;
  end: number;
  words: WordSpan[];
}

export interface MediaInfo {
  path: string;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  videoCodec: string;
  audioCodec: string | null;
  sizeBytes: number;
}

export interface JobProgressPayload {
  id: string;
  stage: string;
  progress: number; // 0..1, -1 = indeterminate
  message?: string;
  done: boolean;
  error?: string;
  /** JSON payload of the finished job (e.g. segments for transcription) */
  result?: string;
}

export interface ModelInfo {
  name: string;
  fileName: string;
  sizeMb: number;
  downloaded: boolean;
  recommended?: boolean;
  description: string;
}

export type AnimationKind = "pop" | "karaoke" | "bounce" | "none";

export interface CaptionStyle {
  id: string;
  name: string;
  /** Font family — must exist on Windows so libass burn-in matches preview. */
  font: string;
  uppercase: boolean;
  /** Font size as % of video height (e.g. 5.5) */
  fontSizePct: number;
  fill: string; // hex
  activeFill: string; // hex — color of the currently spoken word
  outline: string; // hex
  outlineWidthPct: number; // % of video height
  shadow: boolean;
  /** Background box behind text (CSS rgba-like hex8 or null) */
  boxColor: string | null;
  animation: AnimationKind;
  /** Vertical anchor position, % from top (e.g. 78 = lower third) */
  positionPct: number;
  maxWordsPerPage: number;
}

export interface ExportPreset {
  id: string;
  name: string;
  /** null = keep original resolution/aspect */
  targetW: number | null;
  targetH: number | null;
  targetSizeMB: number | null;
  crf: number | null; // used when no target size
  fps: number | null;
  audioKbps: number;
}

export interface ExportRequest {
  inputPath: string;
  outputPath: string;
  assContent: string;
  targetW: number | null;
  targetH: number | null;
  targetSizeMb: number | null;
  crf: number | null;
  fps: number | null;
  audioKbps: number;
  durationSec: number;
  /** Optional trim range (absolute source times, seconds) */
  trimStart: number | null;
  trimEnd: number | null;
  /** Optional multi-segment cut (absolute source times, seconds each) — several
   * ranges concatenated into one output. Used to compile multiple selected
   * highlights into a single file; takes priority over trimStart/trimEnd. */
  cutRanges: [number, number][] | null;
  /** "auto" | "x264" | "nvenc" | "amf" | "qsv" */
  encoder: string;
  /** How to reconcile source aspect ratio with a forced targetW/targetH:
   * "fill" (default, hard center-crop) or "fit" (whole frame visible,
   * letterboxed with a blurred zoomed copy of itself instead of black bars).
   * Ignored unless targetW/targetH are both set. */
  fitMode: "fill" | "fit" | null;
  /** Cap the output's height when targetW/targetH aren't set (no forced
   * crop) — never upscales past the source's own resolution. */
  maxHeight: number | null;
}

/** A detected highlight window in a long recording. */
export interface Highlight {
  start: number;
  end: number;
  peak: number;
  score: number;
  rank: number;
}

/** One clip in the multi-file batch queue. */
export interface BatchItem {
  id: string;
  path: string;
  name: string;
  status: "pending" | "transcribing" | "exporting" | "done" | "error" | "skipped";
  progress: number; // 0..1 within the current stage, -1 indeterminate
  output?: string;
  error?: string;
}

export interface BatchState {
  current: number; // 1-based clip being processed
  total: number;
  stage: string;
  outputDir: string;
}

/** Everything needed to resume editing later — written to a .ccproj file by
 * "Save Project" and restored by "Open Project". Deliberately excludes the
 * things that get regenerated from `videoPath` on load (mediaInfo, the
 * preview clip). */
export interface ProjectFile {
  version: 1;
  videoPath: string;
  selectedModel: string;
  style: CaptionStyle;
  censor: boolean;
  highlights: Highlight[];
  clipOverrides: Record<number, { start: number; end: number }>;
  clipNames: Record<number, string>;
  selectedRanks: number[];
  activeRange: { start: number; end: number } | null;
  segments: Segment[];
  transcriptSourceRank: number | null;
  waveform: number[];
  waveformStep: number;
  waveformOffset: number;
}
