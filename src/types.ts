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
}

/** A detected highlight window in a long recording. */
export interface Highlight {
  start: number;
  end: number;
  peak: number;
  score: number;
  rank: number;
}

export interface BatchState {
  current: number; // 1-based clip being processed
  total: number;
  stage: string;
  outputDir: string;
}
