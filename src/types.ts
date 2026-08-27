// Shared app types

export interface WordSpan {
  text: string;
  start: number; // seconds
  end: number; // seconds
  /** How sure whisper was about this word, 0..1 (the lowest probability among
   * its tokens — see WordSpan.confidence in transcribe.rs). Absent on words
   * you typed yourself and on transcripts made before this existed, both of
   * which are treated as certain. */
  confidence?: number;
}

/** One proposed fix from the local-LLM cleanup pass (see
 * src-tauri/src/polish.rs). Advisory only - nothing is applied until the
 * user accepts it in the review list. */
export interface PolishSuggestion {
  segId: string;
  wordIdx: number;
  original: string;
  suggested: string;
  /** The model's own confidence in `suggested`, 0..1 - see
   * AUTO_APPLY_CONFIDENCE in store.ts for how this gets used. */
  confidence: number;
}

/** Title/hook/hashtags generated from a clip's transcript by the same local
 * LLM cleanup uses (see src-tauri/src/polish.rs's suggest_metadata) -
 * shown for the user to copy, never applied automatically anywhere. */
export interface ClipMetadata {
  title: string;
  hook: string;
  hashtags: string[];
}

export interface Segment {
  id: string;
  words: WordSpan[];
  /** Where this line sits in the stereo field, -1 (hard left) to +1 (hard
   * right), measured from the source audio (see src-tauri/src/spatial.rs).
   * Null for mono sources or transcripts made before this existed. */
  pan?: number | null;
  /** How loud this line is relative to the rest of the clip, 0 (quietest
   * speech present) to 1 (loudest). In a proximity-chat game that reads
   * directly as how close the speaker is. */
  intensity?: number | null;
  /** A real speaker index from voice-fingerprint clustering (sherpa-onnx
   * diarization, run automatically — see src-tauri/src/diarize.rs), or null
   * if diarization wasn't available or this segment's audio didn't overlap
   * any detected speaker. Unlike the old tinydiarize turn-alternation this
   * replaced, the same person keeps the same index if they speak again
   * later in the clip, and there can be more than two speakers. */
  speaker: number | null;
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
  /** One voice-fingerprint embedding per distinct speaker id diarization
   * found *in this run* (keyed by Segment.speaker as a string, since that's
   * only ever a small local index — JS object keys are strings regardless).
   * Match these against SpeakerProfile.embedding (see resolveSpeakerNames in
   * lib/captions.ts) to recover a user-assigned name: sherpa-onnx's own
   * numbering is reassigned by clustering on every run and carries no
   * identity across them on its own, so a name can never be pinned to a raw
   * speaker index — only to a voice. */
  speakerEmbeddings: Record<string, number[]>;
}

/** A user-named voice, identified by a fingerprint rather than by any
 * particular transcription run's speaker index (which isn't stable across
 * runs — see TranscribeResult.speakerEmbeddings). `embedding` is whichever
 * voice sample the user was looking at when they typed the name; matching a
 * fresh transcription's speakers against every stored profile (cosine
 * similarity) is how a name follows a real person across the live preview
 * and every separately re-diarized export. */
export interface SpeakerProfile {
  id: string;
  name: string;
  embedding: number[];
}

/** A caption "page" — the chunk of words shown on screen at once. A page
 * never spans more than one transcript segment, so it inherits that
 * segment's speaker (see Segment.speaker) directly. */
export interface CaptionPage {
  start: number;
  end: number;
  words: WordSpan[];
  speaker: number | null;
  /** Carried through from the segment — see Segment.pan / Segment.intensity. */
  pan?: number | null;
  intensity?: number | null;
  /** Which stacked row this caption occupies when several are on screen at
   * once (0 = the style's own position, higher rows stack upward). Assigned
   * by layoutRows over the whole set, so it stays put while on screen. */
  row?: number;
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
  /** True for a model that unlocks a capability (currently: speaker-turn
   * detection) rather than being a normal transcription accuracy choice —
   * kept out of the main "Speech model" picker. */
  capabilityOnly?: boolean;
}

export type AnimationKind = "pop" | "karaoke" | "bounce" | "glow" | "shake" | "none";

export interface CaptionStyle {
  id: string;
  name: string;
  /** Font family — must exist on Windows so libass burn-in matches preview. */
  font: string;
  uppercase: boolean;
  /** Font size as % of video height (e.g. 5.5) */
  fontSizePct: number;
  fill: string; // hex
  activeFill: string; // hex — color of the currently spoken word (used when there's no known speaker)
  outline: string; // hex
  outlineWidthPct: number; // % of video height
  /** Font weight for the caption text. Presets built around a true black-weight
   * display font (Arial Black) want 900; most other fonts don't have a real
   * black cut and look synthetically over-bolded (blurry/mushy) at 900, so
   * this is per-preset rather than one hardcoded value. */
  fontWeight: number;
  shadow: boolean;
  /** Background box behind text (CSS rgba-like hex8 or null) */
  boxColor: string | null;
  animation: AnimationKind;
  /** Vertical anchor position, % from top (e.g. 78 = lower third) */
  positionPct: number;
  maxWordsPerPage: number;
  /** Base (non-active-word) fill color per speaker, used instead of `fill`
   * when a caption page came from a diarized transcript — indexed by speaker
   * number, wrapping via modulo (see wordCss/buildAss) if there are more
   * detected speakers than colors defined here. Real diarization can surface
   * more than 2 speakers, so presets give this at least 4 colors. */
  speakerColors: string[];
  /** Auto-insert a relevant emoji after the key trigger word in each caption
   * line (one per line, see lib/emojis.ts). Off by default. */
  emojis: boolean;
  /** Captions react to the voice instead of sitting still in the middle: they
   * slide toward wherever the speaker is in the stereo field, shrink when
   * someone is far away and quiet, grow when they're close and loud, and
   * shake when someone screams. Needs the timing data from a transcribe run
   * on this version or later; older transcripts just render centred. */
  dynamic: boolean;
  /** How far the reaction goes, 0-100. 100 is the full range; lower values
   * keep the same behaviour but more subtly. */
  dynamicAmountPct: number;
  /** Show a resolved speaker name (e.g. "Alex") above/beside each caption
   * page whose speaker matched a saved SpeakerProfile — in both the live
   * preview (CaptionOverlay.tsx) and burned-in export (lib/ass.ts). A page
   * whose speaker didn't match any saved profile falls back to no label at
   * all, same as when this is off. Off by default. */
  showSpeakerNames: boolean;
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
  /** Set on clips the user marked by hand rather than ones the loudness scan
   * found. They survive a re-scan (which replaces the detected ones) and are
   * badged in the list. */
  manual?: boolean;
  /** Set on clips found by scanning the transcript for death-related phrases
   * ("I died", "got killed", ...) rather than the audio loudness scan - see
   * findDeathMoments in lib/deathDetector.ts. Unlike the loudness scan, this
   * has NOT been validated against real labeled death moments (no reference
   * footage was available to check false-positive/negative rates against),
   * so it's offered as a distinctly-badged, opt-in experimental pass rather
   * than folded into the main scan silently. */
  death?: boolean;
  /** Plain-language "why this clip" tag from the loudness scan (see
   * analyze::describe_region in src-tauri/src/analyze.rs) - e.g. "Sudden
   * burst · loud". Absent on manually-marked and death-detected clips,
   * which already carry their own reason via `manual`/`death`. */
  reason?: string;
  /** The loudness scan's raw excitement z-score for this clip's peak
   * moment - kept alongside `reason` so a thumbs up/down vote (see
   * rateHighlight in store.ts) can tell the backend exactly which
   * detection bucket to nudge, without re-deriving it from score. */
  peakZ?: number;
}

/** One clip in the multi-file batch queue. */
export interface BatchItem {
  id: string;
  path: string;
  name: string;
  /** "needs_review": the AI cleanup pass found at least one word it wasn't
   * confident enough to fix on its own - this clip is deliberately held
   * back from auto-export rather than shipping an unreviewed guess (see
   * reviewBatchItem in store.ts). Every other clip in the batch that
   * cleared cleanup automatically still exports without waiting on it. */
  status: "pending" | "transcribing" | "exporting" | "done" | "error" | "skipped" | "needs_review";
  progress: number; // 0..1 within the current stage, -1 indeterminate
  output?: string;
  error?: string;
  /** A non-fatal caveat on an otherwise-successful item (e.g. the cleanup
   * pass itself failed, so this exported without an AI review pass) -
   * shown alongside a "done" item rather than only ever having a hard
   * error state or silence. */
  note?: string;
  /** Set only when status is "needs_review" - carries this item's own
   * transcribe result forward so reviewBatchItem can load it straight into
   * the editor without re-transcribing. */
  segments?: Segment[];
  speakerEmbeddings?: Record<string, number[]>;
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
  /** Named voices for this project — persists across re-transcribes and
   * exports since it's keyed by voice fingerprint, not by any one
   * transcription run's speaker index. See SpeakerProfile. */
  speakerProfiles: SpeakerProfile[];
  selectedRanks: number[];
  activeRange: { start: number; end: number } | null;
  segments: Segment[];
  transcriptSourceRank: number | null;
  waveform: number[];
  waveformStep: number;
  waveformOffset: number;
  /** The embeddings behind `segments`' own speaker indices — without these,
   * a reloaded project's captions couldn't be matched back against
   * `speakerProfiles` at all (see TranscribeResult.speakerEmbeddings). */
  speakerEmbeddings: Record<string, number[]>;
}

/** One highlight pulled in from a .ccproj for the montage builder (see
 * src/screens/Montage.tsx) - unlike Auto Reel (store.ts's buildReel), which
 * only ever picks from the currently-open video's own highlights, a
 * montage's clips can come from several different saved projects at once.
 * Carries just enough of that project's own state to render this one clip's
 * captions independently at build time (see buildMontage in store.ts). */
export interface MontageClip {
  /** `${projectPath}:${rank}` - unique across every project added, even if
   * two projects happen to reuse the same highlight rank number. */
  id: string;
  projectPath: string;
  videoPath: string;
  /** e.g. the project's own filename, for telling clips from different
   * source videos apart in the list. */
  sourceLabel: string;
  rank: number;
  start: number;
  end: number;
  segments: Segment[];
  style: CaptionStyle;
  censor: boolean;
}
