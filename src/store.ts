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
  SpeakerProfile,
  TranscribeResult,
  ProjectFile,
  PolishSuggestion,
  MontageClip,
  ClipMetadata,
} from "./types";
import {
  invoke,
  fileSrc,
  listenJobProgress,
  isTauri,
  pickProjectSavePath,
  pickProjectOpenPath,
  pickStyleSavePath,
  pickStyleOpenPath,
} from "./lib/tauri";
import { getPreset, isValidCaptionStyle } from "./lib/styles";
import {
  applyCensor,
  distributeWordTimes,
  matchSpeakerProfiles,
  nextId,
  paginate,
  resolveSpeakerNames,
  speakerLabel,
  layoutRows,
  shiftPages,
  UNSURE_BELOW,
} from "./lib/captions";
import { addEmojis } from "./lib/emojis";
import { extendHighlightBounds } from "./lib/clipBoundaries";
import { getExportPreset, resolveResolution } from "./lib/exportPresets";
import { buildAss } from "./lib/ass";
import { sanitizeFilename } from "./lib/naming";
import { pickReelHighlights } from "./lib/highlights";
import { findDeathMoments } from "./lib/deathDetector";

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

/** The app's own chrome theme - buttons, panels, the editor shell. Distinct
 * from CaptionStyle, which is how captions look in the exported VIDEO;
 * mixing the two into one setting would be confusing since they answer
 * different questions ("how does the app look" vs "how do my captions
 * look"). See src/styles.css's [data-theme] blocks for what each actually
 * changes. */
export type AppTheme = "precision" | "warm" | "gamer";

/** Matches src-tauri/src/analyze.rs's Genre enum (serde rename_all =
 * "lowercase") exactly - passed straight through to the analyze_highlights
 * command with no translation layer. */
export type HighlightGenre = "general" | "fps" | "battleroyale" | "moba";

interface AppState {
  theme: AppTheme;
  setTheme: (t: AppTheme) => void;
  screen: "library" | "editor" | "batch" | "montage";
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
  /** One voice embedding per distinct speaker id in the *current* `segments`
   * (keyed as a string — see TranscribeResult.speakerEmbeddings) — cleared
   * and replaced every time segments are, since it's only ever valid for
   * this specific transcription run. setSpeakerName reads from this to
   * capture/update a durable SpeakerProfile. */
  speakerEmbeddings: Record<string, number[]>;
  /** Named voices for this project — see SpeakerProfile. Persists across
   * re-transcribes of the same video (that's the point), reset on
   * openVideo/closeVideo like the rest of this video's metadata. */
  speakerProfiles: SpeakerProfile[];
  /** Word currently selected for fine-tuning — drives both the nudge panel in
   * the Transcript tab and which word is highlighted in the main waveform
   * editor beneath the video. Null when nothing is selected. */
  tuningWord: { segId: string; idx: number } | null;

  // style
  style: CaptionStyle;
  /** User-imported or user-saved presets, persisted to localStorage and
   * shown alongside the built-in STYLE_PRESETS - see saveCustomStylePreset
   * /importStylePreset/exportStylePreset. Plain files, not a marketplace:
   * exporting one just writes JSON to a .ccstyle the user picks where to
   * put, and anyone can hand you one back the same way. */
  customStylePresets: CaptionStyle[];
  saveCustomStylePreset: (name: string) => void;
  removeCustomStylePreset: (id: string) => void;
  exportStylePreset: (style: CaptionStyle) => Promise<void>;
  importStylePreset: () => Promise<void>;

  // highlights
  highlights: Highlight[];
  /** How the user rated a highlight this session (by rank), so the vote
   * buttons show which way you already voted and can't double-count -
   * cleared whenever a fresh scan replaces the highlight list. */
  highlightVotes: Record<number, 1 | -1>;
  rateHighlight: (rank: number, vote: 1 | -1) => Promise<void>;
  analyzeJob: JobState | null;
  polishJob: JobState | null;
  /** Downloading the (large, optional) cleanup model - a separate slot from
   * polishJob so it cannot collide with a review pass, and separate from
   * modelJob so it cannot collide with a whisper model download either. */
  polishModelJob: JobState | null;
  /** Whether the local cleanup model is installed - checked once at
   * startup so the UI can hide the action entirely rather than let someone
   * press it and hit an error about a 2GB download they did not expect. */
  polishAvailable: boolean;
  /** Proposed fixes awaiting review. Nothing here has been applied - see
   * acceptPolishSuggestion / rejectPolishSuggestion. */
  polishSuggestions: PolishSuggestion[];
  /** Summary of the most recent review pass, for the "N applied
   * automatically, M need your review" line - cleared on the next run, not
   * persisted. */
  polishLastRun: { autoApplied: number; forReview: number } | null;
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
  alignJob: JobState | null;
  montageJob: JobState | null;
  discordJob: JobState | null;
  metadataJob: JobState | null;
  /** Last title/hook/hashtags generated for the open clip - cleared when a
   * new generation starts, never applied anywhere, just displayed for the
   * user to copy. */
  clipMetadata: ClipMetadata | null;
  generateMetadata: () => Promise<void>;
  demoJob: JobState | null;
  /** One-click shareable before/after (raw vs. captioned+compressed) clip,
   * side by side - see src-tauri/src/demo.rs. Caller resolves the save path
   * (same division of labor as buildMontage/compileSelectedHighlights). */
  buildDemo: (outputPath: string) => Promise<void>;
  /** Persisted webhook URL for "post finished export to Discord" - a
   * channel's own Integrations settings gives you one, no bot setup. Empty
   * means the feature is simply unused (Export never shows the checkbox). */
  discordWebhook: string;
  setDiscordWebhook: (url: string) => void;
  /** Whether a successful export should immediately POST itself to
   * discordWebhook with no further action - "no approval process" is the
   * whole point, so this is a deliberate opt-in per the user's own request,
   * not itself a confirmation step. */
  autoPostToDiscord: boolean;
  setAutoPostToDiscord: (v: boolean) => void;
  postToDiscord: (filePath: string, message?: string) => Promise<void>;

  // models
  models: ModelInfo[];
  selectedModel: string;
  /** Names, jargon and spellings fed to whisper as its initial prompt, to
   * bias transcription of proper nouns and strongly-accented speech. */
  vocabulary: string;
  /** How many people are talking in this recording, or null to let
   * diarization work it out. Pinning it is markedly more reliable - see
   * diarize::run - and you usually know: it's your own squad. */
  speakerCount: number | null;

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
  /** Re-times several words in one atomic update — used for dragging a
   * multi-selected group of caption boxes together on the timeline, so the
   * whole group's move is a single undo step (Ctrl+Z) rather than one step
   * per word, and so the intermediate frames of one drag gesture never
   * apply to only some of the selected words. */
  setWordTimesBatch: (updates: { segId: string; idx: number; start: number; end: number }[]) => void;
  setTuningWord: (w: { segId: string; idx: number } | null) => void;
  /** Creates a brand-new caption from scratch at an absolute-timeline range
   * that whisper produced nothing for at all (not just a mistimed word) —
   * used by the main waveform editor's click-drag-on-empty-space gesture.
   * Returns the new segment's id. */
  insertSegment: (
    start: number,
    end: number,
    text: string,
    /** Which speaker the new line belongs to. Defaults to unattributed, but
     * the timeline passes the lane it was drawn in - a line you add by hand
     * inside someone's track is theirs, and filing it under a separate
     * "Unknown" speaker was both wrong and confusing. */
    speaker?: number | null
  ) => string;
  setSelectedModel: (m: string) => void;
  setVocabulary: (v: string) => void;
  setSpeakerCount: (n: number | null) => void;
  setEncoder: (e: string) => void;
  setFpsOverride: (fps: number | null) => void;
  downloadModel: (name: string) => Promise<void>;
  refreshModels: () => Promise<void>;
  startExport: (req: ExportRequest) => Promise<void>;
  analyzeHighlights: () => Promise<void>;
  setActiveRange: (r: { start: number; end: number } | null) => void;
  toggleHighlightSelected: (rank: number) => void;
  /** Drops a highlight from the list entirely (not just deselecting it) -
   * for a detected clip that isn't actually suitable, so it stops cluttering
   * the sidebar. Undoable like any other transcript/highlight edit. */
  removeHighlight: (rank: number) => void;
  selectAllHighlights: () => void;
  selectNoneHighlights: () => void;
  startEditingHighlight: (h: Highlight) => void;
  stopEditingHighlight: () => void;
  adjustHighlightRange: (rank: number, start: number, end: number) => void;
  setClipName: (rank: number, name: string) => void;
  /** Names (or renames, or clears with an empty/whitespace name) the voice
   * currently showing as speaker `speakerIndex` in `segments` — see
   * SpeakerProfile and lib/captions.ts's matching functions for how that
   * name then follows the same real voice into other transcriptions. A
   * no-op if that speaker has no embedding to match against (diarization
   * ran but embedding extraction failed for it — rare). */
  setSpeakerName: (speakerIndex: number, name: string) => void;
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
    fitMode?: "fill" | "fit",
    /** Explicit ranks to compile instead of the ticked checkboxes -
     * buildReel uses this so picking a hands-off reel never mutates what
     * the user has manually selected in the Highlights list. */
    ranksOverride?: number[]
  ) => Promise<void>;
  /** Hands-off reel: auto-picks highlights (every manual bookmark plus the
   * highest-scoring detected clips up to targetDurationSec - see
   * pickReelHighlights) and compiles them, without requiring anything to be
   * ticked first. */
  buildReel: (
    outputPath: string,
    presetId: string,
    customMb: number,
    targetDurationSec: number,
    resolutionId?: string,
    fitMode?: "fill" | "fit"
  ) => Promise<{ ranks: number[]; totalDurationSec: number } | null>;
  openBatch: () => void;
  openMontage: () => void;
  /** Renders and joins clips pulled from one or more saved .ccproj files
   * (src/screens/Montage.tsx) into one file, in the given order. Every clip
   * is rendered at the same resolution/fps/encoder so the final join is a
   * fast, lossless `-c copy` concat - only quality (CRF) encoding is
   * supported per clip today, not a file-size target (see montage.rs). */
  buildMontage: (
    clips: MontageClip[],
    outputPath: string,
    presetId: string,
    resolutionId: string,
    fitMode: "fill" | "fit"
  ) => Promise<void>;
  addBatchPaths: (paths: string[]) => void;
  addBatchFolder: (dir: string) => Promise<void>;
  removeBatchItem: (id: string) => void;
  clearBatchItems: () => void;
  /** Loads a "needs_review" batch item's own transcript into the main
   * editor (no re-transcribing - carries the batch run's own segments
   * forward) and re-runs the cleanup pass fresh there so the exact same
   * accept/reject review UI already built for a single open clip handles
   * it, rather than a second bespoke review surface. */
  reviewBatchItem: (id: string) => Promise<void>;
  runFileBatch: (
    presetId: string,
    customMb: number,
    outputDir: string | null,
    resolutionId?: string,
    fitMode?: "fill" | "fit"
  ) => Promise<void>;
  cancelFileBatch: () => void;
  clearError: () => void;
  /** True when reopening this video restored autosaved work, until dismissed.
   * Purely so the UI can say so — the restore itself is unconditional. */
  restoredSession: boolean;
  /** Which side-panel tab is showing. In the store rather than Editor-local
   * state so a panel can send you to another one - the Export tab needs to
   * point at Highlights, where clip export actually lives. */
  editorTab: "transcript" | "highlights" | "style" | "export";
  setEditorTab: (t: AppState["editorTab"]) => void;
  /** Adds a hand-marked clip centred on `center` seconds; returns its rank. */
  addBookmark: (center: number) => number;
  /** EXPERIMENTAL, unvalidated keyword scan of the transcript for phrases
   * people say right after dying (see lib/deathDetector.ts) - a distinctly-
   * badged addition to `highlights`, never mixed silently into the
   * loudness-based scan's own results. Re-running replaces only its own
   * previous results, same as a loudness re-scan. Returns how many it
   * found. */
  scanForDeaths: () => number;
  /** Starts a review pass: sends every word below the confidence threshold
   * to the local model and populates polishSuggestions with what it
   * proposes. A no-op (clears any stale suggestions) if the model is not
   * installed - callers should check polishAvailable first. */
  downloadPolishModel: () => Promise<void>;
  reviewTranscript: () => Promise<void>;
  /** Re-times every word against the audio via forced alignment (align.rs),
   * using the transcript's own text as ground truth rather than re-guessing
   * content - snaps every word to where it actually is, including ones
   * whisper mistimed or never confidently placed. Needs the alignment model
   * downloaded first (see `models`, name "wav2vec2-base-960h") and a saved
   * video path; undoable like any other transcript edit. */
  alignTranscript: () => Promise<void>;
  /** Applies one suggestion (through updateWord, so it is a normal,
   * undoable edit) and removes it from the pending list. */
  acceptPolishSuggestion: (index: number) => void;
  rejectPolishSuggestion: (index: number) => void;
  acceptAllPolishSuggestions: () => void;
  dismissAllPolishSuggestions: () => void;
  /** Reassigns a whole segment to a speaker (or null for unattributed) - the
   * timeline's drag-a-line-into-another-lane gesture, and the fastest way to
   * correct diarization when it puts someone in the wrong lane. */
  setSegmentSpeaker: (segId: string, speaker: number | null) => void;
  /** Moves a single word to another speaker, splitting its line if needed.
   * Correcting diarization is usually a word or two at a boundary, not a
   * whole line, so this is what dragging one word vertically does. */
  moveWordToSpeaker: (segId: string, wordIdx: number, speaker: number | null) => void;
  /** Same idea as moveWordToSpeaker, batched for a multi-selected group drag
   * (MainWaveform's Ctrl/Cmd+click group) so reassigning several words to a
   * different speaker's lane is one undo step, not one per word - and so
   * several selected words from the very same segment extract together as
   * one new segment instead of each other's index shifting mid-loop. */
  moveWordsToSpeaker: (updates: { segId: string; idx: number }[], speaker: number | null) => void;
  canUndo: boolean;
  canRedo: boolean;
  /** Snapshots the current edit state so the next mutation can be undone.
   * `coalesceKey` groups a burst of related changes (a drag firing dozens of
   * setWordTime calls) into one undo step. */
  pushHistory: (coalesceKey?: string) => void;
  undo: () => void;
  redo: () => void;
  /** How many clips a scan may return, or null to scale it to the video's
   * length. */
  highlightCount: number | null;
  setHighlightCount: (n: number | null) => void;
  /** Retunes what counts as one highlight and how wide its window is - see
   * Genre::tuning in src-tauri/src/analyze.rs. There's no game detection
   * here; the user picks. Persisted since it's a per-user habit ("I always
   * caption FPS clips"), not a per-project setting. */
  highlightGenre: HighlightGenre;
  setHighlightGenre: (g: HighlightGenre) => void;
  dismissRestoredNotice: () => void;
  /** Throws away the autosaved working state for the current video and resets
   * the editor to a clean slate for it. */
  discardSession: () => Promise<void>;
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

/** Fire-and-forget: teaches the self-growing phrase dictionary (see
 * src-tauri/src/polish.rs) whenever a correction actually lands in the
 * transcript, whether auto-applied at high confidence or approved by hand -
 * called from every place a PolishSuggestion gets accepted, so the same
 * misheard name or game term doesn't need re-explaining clip after clip.
 * Best-effort: a write failure here shouldn't interrupt the edit that
 * already happened. */
function recordPhraseCorrection(original: string, suggested: string): Promise<void> {
  return invoke<void>("record_phrase_correction", { original, corrected: suggested }).catch(() => {
    /* the dictionary just won't grow from this one - not worth surfacing */
  });
}

function loadCustomStylePresets(): CaptionStyle[] {
  try {
    const raw = JSON.parse(localStorage.getItem("cc.customStylePresets") ?? "[]");
    return Array.isArray(raw) ? raw.filter(isValidCaptionStyle) : [];
  } catch {
    return [];
  }
}


// ---------------- undo / redo ----------------
//
// Snapshots rather than inverse operations: the edit surface here is a handful
// of plain arrays and records, so copying the references is cheap (structural
// sharing does the work - an unchanged segment is the same object in every
// snapshot) and it can't drift out of sync with the actions the way
// hand-written inverses do.

interface EditSnapshot {
  segments: Segment[];
  highlights: Highlight[];
  clipOverrides: Record<number, { start: number; end: number }>;
  clipNames: Record<number, string>;
  selectedRanks: number[];
}

/** Deep enough to be correct, shallow enough to be free: every mutating action
 * replaces these containers rather than mutating them in place. */
function snapshot(s: AppState): EditSnapshot {
  return {
    segments: s.segments,
    highlights: s.highlights,
    clipOverrides: s.clipOverrides,
    clipNames: s.clipNames,
    selectedRanks: s.selectedRanks,
  };
}

/** Far more than anyone reaches for, still bounded so an all-day session
 * can't grow the stack without limit. */
const MAX_HISTORY = 100;
/** A burst of changes sharing a coalesce key within this window collapses to
 * one undo step - otherwise dragging a word across the timeline would take
 * fifty Ctrl+Z presses to walk back. */
const COALESCE_MS = 900;

let undoPast: EditSnapshot[] = [];
let undoFuture: EditSnapshot[] = [];
let lastPushKey: string | null = null;
let lastPushAt = 0;

function resetHistory() {
  undoPast = [];
  undoFuture = [];
  lastPushKey = null;
  lastPushAt = 0;
}

/** Clips a scan may return when the count is left on auto.
 *
 * This used to be hardcoded at 12 regardless of length, so a two-hour session
 * and a two-minute clip both came back with at most a dozen — the single
 * biggest reason long VODs felt like they were missing most of their good
 * moments. Roughly one candidate per four minutes matches how often something
 * worth clipping actually happens, with a floor so short clips still get a
 * usable spread and a ceiling so an all-nighter doesn't return hundreds.
 */
export function autoHighlightCount(configured: number | null, durationSec?: number): number {
  if (configured != null) return configured;
  if (!durationSec) return 12;
  return Math.max(12, Math.min(60, Math.round(durationSec / 240)));
}

/** How much of a hand-marked clip sits before and after the playhead. Biased
 * backwards because you press the button *after* the thing happens. */
const BOOKMARK_BEFORE = 12;
const BOOKMARK_AFTER = 4;

/** A cleanup-pass suggestion at or above this confidence applies itself
 * automatically; below it, the suggestion goes to the review list instead.
 * Mirrors AUTO_APPLY_CONFIDENCE in src-tauri/src/polish.rs, where the value
 * is chosen and the reasoning/measurements are recorded - kept here too
 * since Rust reports the number but this is where the tiering DECISION and
 * the actual edit both happen (polish.rs never touches segments directly).
 * If you change one, change both. */
const AUTO_APPLY_CONFIDENCE = 0.8;

// ---------------- autosaved working state ----------------
//
// Opening a video resets the editor, and going back to the library used to
// throw away everything not explicitly saved to a .ccproj. These keep a
// working copy per video in app data (see the session_file command) so the
// round trip is lossless. It's deliberately separate from .ccproj files:
// those are documents the user names and manages, this is just "don't lose my
// work".

/** The slices worth persisting. Compared by identity, which is reliable
 * because every store update replaces these objects rather than mutating
 * them — and cheap, unlike hashing a two-hour transcript on every keystroke. */
function sessionSlice(s: AppState) {
  return {
    segments: s.segments,
    transcriptSourceRank: s.transcriptSourceRank,
    waveform: s.waveform,
    waveformStep: s.waveformStep,
    waveformOffset: s.waveformOffset,
    highlights: s.highlights,
    clipOverrides: s.clipOverrides,
    clipNames: s.clipNames,
    selectedRanks: s.selectedRanks,
    activeRange: s.activeRange,
    style: s.style,
    censor: s.censor,
    // Without this, restoring a session (as opposed to a fresh transcribe or
    // loading a .ccproj, both of which already carry it) silently drops
    // every speaker's voice-fingerprint embedding even though their
    // `speaker` indices on segments are still there - every speaker then
    // reads as "too short to identify" in the Speakers panel regardless of
    // whether diarization actually found enough audio to name them.
    speakerEmbeddings: s.speakerEmbeddings,
  };
}

type SessionSlice = ReturnType<typeof sessionSlice>;

let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
let autosaveArmed = false;
let lastSlice: SessionSlice | null = null;

function armAutosave() {
  autosaveArmed = true;
}

function disarmAutosave() {
  autosaveArmed = false;
  lastSlice = null;
  if (autosaveTimer) {
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
  }
}

async function writeSession(state: AppState) {
  const { videoPath } = state;
  if (!videoPath) return;
  try {
    const path = await invoke<string>("session_file", { videoPath });
    await invoke("write_text_file", {
      path,
      content: JSON.stringify({ version: 1, videoPath, ...sessionSlice(state) }),
    });
  } catch {
    // An autosave failure must never interrupt editing with an error banner —
    // the explicit Save Project path still reports failures loudly.
  }
}

async function flushAutosave(state: AppState) {
  if (!autosaveArmed) return;
  if (autosaveTimer) {
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
  }
  await writeSession(state);
}

async function restoreSession(
  videoPath: string,
  set: (partial: Partial<AppState>) => void,
  get: () => AppState
) {
  try {
    const path = await invoke<string>("session_file", { videoPath });
    const raw = await invoke<string>("read_text_file", { path });
    const saved = JSON.parse(raw) as Partial<SessionSlice> & { videoPath?: string };
    // A session with no transcript and no highlights is nothing worth
    // announcing (or restoring) — e.g. one just cleared by discardSession.
    if (!saved.segments?.length && !saved.highlights?.length) return;
    set({
      segments: saved.segments ?? [],
      transcriptSourceRank: saved.transcriptSourceRank ?? null,
      waveform: saved.waveform ?? [],
      waveformStep: saved.waveformStep ?? 0.01,
      waveformOffset: saved.waveformOffset ?? 0,
      highlights: saved.highlights ?? [],
      clipOverrides: saved.clipOverrides ?? {},
      clipNames: saved.clipNames ?? {},
      selectedRanks: saved.selectedRanks ?? [],
      activeRange: saved.activeRange ?? null,
      style: saved.style ?? get().style,
      censor: saved.censor ?? get().censor,
      speakerEmbeddings: saved.speakerEmbeddings ?? {},
      restoredSession: true,
    });
  } catch {
    // No session yet (the common case on a first open), or an unreadable one.
  }
}

export const useApp = create<AppState>((set, get) => ({
  theme: (() => {
    const v = localStorage.getItem("cc.theme");
    return v === "warm" || v === "precision" ? v : "gamer";
  })(),
  setTheme: (t) => {
    localStorage.setItem("cc.theme", t);
    set({ theme: t });
  },
  screen: "library",
  error: null,
  videoPath: null,
  previewSrc: null,
  mediaInfo: null,
  projectPath: null,
  restoredSession: false,
  editorTab: "transcript",
  canUndo: false,
  canRedo: false,
  highlightCount: (() => {
    const v = localStorage.getItem("cc.highlightCount");
    return v == null || v === "auto" ? null : Number(v);
  })(),
  highlightGenre: (localStorage.getItem("cc.highlightGenre") as HighlightGenre | null) ?? "general",
  segments: [],
  censor: false,
  transcriptSourceRank: null,
  waveform: [],
  waveformStep: 0.01,
  waveformOffset: 0,
  speakerEmbeddings: {},
  speakerProfiles: [],
  tuningWord: null,
  style: getPreset("beast"),
  customStylePresets: loadCustomStylePresets(),
  highlights: [],
  highlightVotes: {},
  analyzeJob: null,
  polishJob: null,
  polishModelJob: null,
  polishAvailable: false,
  polishSuggestions: [],
  polishLastRun: null,
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
  alignJob: null,
  montageJob: null,
  discordJob: null,
  metadataJob: null,
  clipMetadata: null,
  demoJob: null,
  discordWebhook: localStorage.getItem("cc.discordWebhook") ?? "",
  autoPostToDiscord: localStorage.getItem("cc.autoPostDiscord") === "1",
  models: [],
  selectedModel: localStorage.getItem("cc.model") ?? "large-v3-turbo",
  vocabulary: localStorage.getItem("cc.vocabulary") ?? "",
  speakerCount: (() => {
    const v = localStorage.getItem("cc.speakerCount");
    return v == null || v === "auto" ? null : Number(v);
  })(),
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
        const version = await getVersion();
        set({ appVersion: version });
        // The Library header also shows "vX.Y.Z", but that's easy to miss if
        // you mostly live in the Editor screen — the title bar is visible no
        // matter what's on screen (and shows up in the taskbar/alt-tab too),
        // so it's the one place that answers "which version am I running?"
        // without having to go looking for it.
        try {
          const { getCurrentWindow } = await import("@tauri-apps/api/window");
          await getCurrentWindow().setTitle(`ClipCaption v${version}`);
        } catch (titleErr) {
          console.error("Could not set window title:", titleErr);
        }
      } catch (err) {
        // non-essential — version just won't show in the UI
        console.error("Could not read app version:", err);
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
      const { transcribeJob, exportJob, modelJob, analyzeJob, polishJob, polishModelJob, alignJob, montageJob, discordJob, metadataJob, demoJob } = get();
      const patch = (
        job: JobState | null,
        key:
          | "transcribeJob"
          | "exportJob"
          | "modelJob"
          | "analyzeJob"
          | "polishJob"
          | "polishModelJob"
          | "alignJob"
          | "montageJob"
          | "discordJob"
          | "metadataJob"
          | "demoJob"
      ) => {
        if (!job || job.id !== p.id) return false;
        if (p.error) {
          const quiet = p.error === "Cancelled";
          set({ [key]: null, error: quiet ? null : p.error } as Partial<AppState>);
        } else if (p.done) {
          if (key === "transcribeJob" && p.result) {
            try {
              const { segments, waveform, waveformStep, waveformOffset, speakerEmbeddings } =
                JSON.parse(p.result) as TranscribeResult;
              set({
                segments,
                waveform,
                waveformStep,
                waveformOffset,
                speakerEmbeddings: speakerEmbeddings ?? {},
                transcribeJob: null,
              });
              // This transcribe was for one highlight's own range (see
              // captionThisRange in HighlightsPanel.tsx) - now that its
              // words exist, check for a setup/reaction line just outside
              // the current window and widen it to include one. Only ever
              // widens (see extendHighlightBounds), so this can't clip
              // anything the loudness scan already found.
              const rank = get().transcriptSourceRank;
              const duration = get().mediaInfo?.durationSec;
              if (rank != null && duration != null) {
                const h = get().highlights.find((x) => x.rank === rank);
                if (h) {
                  const current = get().clipOverrides[rank] ?? { start: h.start, end: h.end };
                  const extended = extendHighlightBounds(current, segments, duration);
                  if (extended.extendedBefore || extended.extendedAfter) {
                    get().adjustHighlightRange(rank, extended.start, extended.end);
                  }
                }
              }
            } catch {
              set({ transcribeJob: null, error: "Failed to parse transcript" });
            }
          } else if (key === "exportJob") {
            set({ exportJob: null, exportDone: p.result ?? null });
            const { autoPostToDiscord, discordWebhook } = get();
            if (autoPostToDiscord && discordWebhook && p.result) {
              void get().postToDiscord(p.result);
            }
          } else if (key === "montageJob") {
            set({ montageJob: null, exportDone: p.result ?? null });
            const { autoPostToDiscord, discordWebhook } = get();
            if (autoPostToDiscord && discordWebhook && p.result) {
              void get().postToDiscord(p.result);
            }
          } else if (key === "discordJob") {
            set({ discordJob: null });
          } else if (key === "demoJob") {
            set({ demoJob: null, exportDone: p.result ?? null });
          } else if (key === "metadataJob" && p.result) {
            try {
              const clipMetadata = JSON.parse(p.result) as ClipMetadata;
              set({ metadataJob: null, clipMetadata });
            } catch {
              set({ metadataJob: null, error: "Failed to parse generated metadata" });
            }
          } else if (key === "polishModelJob") {
            set({ polishModelJob: null, polishAvailable: true });
          } else if (key === "alignJob" && p.result) {
            try {
              const { segments, totalTurns, failedTurns, failedWords } = JSON.parse(p.result) as {
                segments: Segment[];
                totalTurns: number;
                failedTurns: number;
                failedWords: number;
              };
              set({
                segments,
                alignJob: null,
                // A partial run says so plainly rather than looking
                // identical to a clean one - error is the only toast
                // channel that exists, worded as a heads-up, not a failure.
                error:
                  failedTurns > 0 || failedWords > 0
                    ? `Aligned most of the transcript, but ${failedTurns} of ${totalTurns} turns and ${failedWords} individual words couldn't be placed and were left at their existing timing.`
                    : null,
              });
            } catch {
              set({ alignJob: null, error: "Failed to parse aligned transcript" });
            }
          } else if (key === "polishJob" && p.result) {
            try {
              const suggestions = JSON.parse(p.result) as PolishSuggestion[];
              // Tiered: the model reports its own confidence, but the
              // DECISION and the actual edit both happen here, not in Rust -
              // polish.rs never touches segments directly, same as every
              // other transcript mutation in this app.
              const autoApplied: PolishSuggestion[] = [];
              const forReview: PolishSuggestion[] = [];
              for (const s of suggestions) {
                (s.confidence >= AUTO_APPLY_CONFIDENCE ? autoApplied : forReview).push(s);
              }
              for (const s of autoApplied) {
                get().updateWord(s.segId, s.wordIdx, s.suggested);
                void recordPhraseCorrection(s.original, s.suggested);
              }
              set({
                polishJob: null,
                polishSuggestions: forReview,
                polishLastRun: { autoApplied: autoApplied.length, forReview: forReview.length },
              });
            } catch {
              set({ polishJob: null, error: "Failed to parse cleanup suggestions" });
            }
          } else if (key === "analyzeJob" && p.result) {
            try {
              const found = JSON.parse(p.result) as Highlight[];
              // Hand-marked clips outlive a re-scan — the user put them there
              // deliberately, and a scan they asked for shouldn't delete them.
              // Their ranks are renumbered above the detected ones so the two
              // sets can't collide (rank keys clipOverrides and clipNames).
              const kept = get().highlights.filter((h) => h.manual);
              const base = found.reduce((m, h) => Math.max(m, h.rank), -1) + 1;
              const renumbered = kept.map((h, i) => ({ ...h, rank: base + i }));
              const oldOverrides = get().clipOverrides;
              const oldNames = get().clipNames;
              const clipOverrides: Record<number, { start: number; end: number }> = {};
              const clipNames: Record<number, string> = {};
              kept.forEach((h, i) => {
                if (oldOverrides[h.rank]) clipOverrides[base + i] = oldOverrides[h.rank];
                if (oldNames[h.rank]) clipNames[base + i] = oldNames[h.rank];
              });
              const highlights = [...found, ...renumbered];
              set({
                highlights,
                analyzeJob: null,
                selectedRanks: highlights.map((h) => h.rank),
                clipOverrides,
                clipNames,
                editingRank: null,
                // Old votes referenced ranks from the replaced list - keeping
                // them risks a stale vote silently landing on an unrelated
                // clip that happens to reuse the same rank number.
                highlightVotes: {},
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
        patch(polishJob, "polishJob") ||
        patch(polishModelJob, "polishModelJob") ||
        patch(alignJob, "alignJob") ||
        patch(montageJob, "montageJob") ||
        patch(discordJob, "discordJob") ||
        patch(metadataJob, "metadataJob") ||
        patch(demoJob, "demoJob") ||
        patch(modelJob, "modelJob");
    });
    await get().refreshModels();
    try {
      const polishAvailable = await invoke<boolean>("polish_available");
      set({ polishAvailable });
    } catch {
      /* stays false - the cleanup action just won't offer itself */
    }
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
      // Before anything else: a debounced autosave from the previous video may
      // still be pending, and it writes whatever the state is when it fires —
      // which would be this new video's blank slate, landing in the new
      // video's session file and wiping the work we're about to restore.
      void flushAutosave(get());
      disarmAutosave();
      resetHistory();
      set({ error: null, canUndo: false, canRedo: false });
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
        speakerEmbeddings: {},
        speakerProfiles: [],
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
        restoredSession: false,
        recent,
      });
      await restoreSession(path, set, get);
      armAutosave();
    } catch (e) {
      set({ error: String(e) });
    }
  },

  closeVideo: () => {
    // Flush before tearing the state down, not after: the debounce may still
    // be pending, and everything it would save is about to be set to null.
    void flushAutosave(get());
    disarmAutosave();
    resetHistory();
    set({
      screen: "library",
      canUndo: false,
      canRedo: false,
      restoredSession: false,
      videoPath: null,
      previewSrc: null,
      mediaInfo: null,
      projectPath: null,
      segments: [],
      transcriptSourceRank: null,
      waveform: [],
      waveformStep: 0.01,
      waveformOffset: 0,
      speakerEmbeddings: {},
      speakerProfiles: [],
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
      polishJob: null,
      polishSuggestions: [],
      polishLastRun: null,
      exportDone: null,
    });
  },

  transcribe: async () => {
    const { videoPath, selectedModel, activeRange, editingRank } = get();
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
        speakerEmbeddings: {},
        tuningWord: null,
      });
      const id = await invoke<string>("transcribe", {
        req: {
          path: videoPath,
          model: selectedModel,
          prompt: get().vocabulary || null,
          speakerCount: get().speakerCount,
          start: activeRange?.start ?? null,
          end: activeRange?.end ?? null,
        },
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

  saveCustomStylePreset: (name) => {
    const { style, customStylePresets } = get();
    const saved: CaptionStyle = { ...style, id: nextId("style"), name: name.trim() || "Untitled" };
    const next = [...customStylePresets, saved];
    localStorage.setItem("cc.customStylePresets", JSON.stringify(next));
    set({ customStylePresets: next, style: saved });
  },

  removeCustomStylePreset: (id) => {
    const next = get().customStylePresets.filter((p) => p.id !== id);
    localStorage.setItem("cc.customStylePresets", JSON.stringify(next));
    set({ customStylePresets: next });
  },

  exportStylePreset: async (style) => {
    const safeName = style.name.replace(/[\\/:*?"<>|]+/g, "_").trim() || "style";
    const path = await pickStyleSavePath(`${safeName}.ccstyle`);
    if (!path) return;
    try {
      await invoke("write_text_file", { path, content: JSON.stringify(style, null, 2) });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  importStylePreset: async () => {
    const path = await pickStyleOpenPath();
    if (!path) return;
    try {
      const raw = await invoke<string>("read_text_file", { path });
      const parsed: unknown = JSON.parse(raw);
      if (!isValidCaptionStyle(parsed)) {
        set({ error: "That file doesn't look like a ClipCaption style preset." });
        return;
      }
      // A fresh id/name pair so importing the same file twice (or a file
      // that happens to reuse a built-in preset's id) can't collide with
      // an existing preset in the list.
      const imported: CaptionStyle = { ...parsed, id: nextId("style") };
      const next = [...get().customStylePresets, imported];
      localStorage.setItem("cc.customStylePresets", JSON.stringify(next));
      set({ customStylePresets: next, style: imported });
    } catch (e) {
      set({ error: `Could not read that style file: ${String(e)}` });
    }
  },
  setCensor: (censor) => set({ censor }),

  updateWord: (segId, wordIdx, text) => {
    get().pushHistory(`text:${segId}:${wordIdx}`);
    set({
      segments: get().segments.map((s) =>
        s.id !== segId
          ? s
          : { ...s, words: s.words.map((w, i) => (i === wordIdx ? { ...w, text } : w)) }
      ),
    });
  },

  insertWord: (segId, atIndex) => {
    get().pushHistory();
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
    get().pushHistory();
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
    get().pushHistory(`time:${segId}:${wordIdx}`);
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

  setWordTimesBatch: (updates) => {
    if (updates.length === 0) return;
    get().pushHistory("group-move");
    const bySeg = new Map<string, Map<number, { start: number; end: number }>>();
    for (const u of updates) {
      if (!bySeg.has(u.segId)) bySeg.set(u.segId, new Map());
      bySeg.get(u.segId)!.set(u.idx, { start: u.start, end: u.end });
    }
    set({
      segments: get().segments.map((s) => {
        const m = bySeg.get(s.id);
        if (!m) return s;
        return {
          ...s,
          words: s.words.map((w, i) => {
            const u = m.get(i);
            if (!u) return w;
            const start = Math.max(0, u.start);
            return { ...w, start, end: Math.max(start + 0.02, u.end) };
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
  insertSegment: (start, end, text, speaker = null) => {
    get().pushHistory();
    const id = nextId("useg");
    const s0 = Math.max(0, Math.min(start, end - 0.02));
    const e0 = Math.max(s0 + 0.02, end);
    // Split what was typed into individual words (see distributeWordTimes) so
    // a hand-typed line gets the same per-word highlight animation and
    // drag-to-retime as anything whisper produced, instead of behaving as one
    // frozen block of text for its whole duration.
    const tokens = text.trim().split(/\s+/).filter(Boolean);
    const words = tokens.length ? distributeWordTimes(tokens, s0, e0) : [{ text: "word", start: s0, end: e0 }];
    const seg: Segment = { id, words, speaker };
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

  setVocabulary: (v) => {
    localStorage.setItem("cc.vocabulary", v);
    set({ vocabulary: v });
  },

  setSpeakerCount: (n) => {
    localStorage.setItem("cc.speakerCount", n == null ? "auto" : String(n));
    set({ speakerCount: n });
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
      set({ error: null, highlights: get().highlights.filter((h) => h.manual) });
      const id = await invoke<string>("analyze_highlights", {
        path: videoPath,
        maxCount: autoHighlightCount(get().highlightCount, get().mediaInfo?.durationSec),
        genre: get().highlightGenre,
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

  removeHighlight: (rank) => {
    get().pushHistory();
    const { highlights, selectedRanks, clipOverrides, clipNames, editingRank, activeRange } = get();
    const nextOverrides = { ...clipOverrides };
    delete nextOverrides[rank];
    const nextNames = { ...clipNames };
    delete nextNames[rank];
    const wasEditing = editingRank === rank;
    set({
      highlights: highlights.filter((h) => h.rank !== rank),
      selectedRanks: selectedRanks.filter((r) => r !== rank),
      clipOverrides: nextOverrides,
      clipNames: nextNames,
      editingRank: wasEditing ? null : editingRank,
      activeRange: wasEditing ? null : activeRange,
    });
  },

  /** One vote per highlight per session (see highlightVotes) - feeds the
   * bucket the clip's own peak_z/duration falls into (see
   * analyze::record_feedback), nudging that bucket's score for every
   * future scan. Fire-and-forget: a clip that was already voted on, or
   * that has no peakZ (hand-marked/death-detected, not from the loudness
   * scan), is a no-op rather than an error - there's nothing to attribute
   * the vote to. */
  rateHighlight: async (rank, vote) => {
    const { highlights, highlightVotes } = get();
    if (highlightVotes[rank]) return;
    const h = highlights.find((x) => x.rank === rank);
    if (!h || h.peakZ == null) return;
    set({ highlightVotes: { ...highlightVotes, [rank]: vote } });
    try {
      await invoke("record_highlight_feedback", {
        peakZ: h.peakZ,
        durationSec: h.end - h.start,
        vote,
      });
    } catch (e) {
      set({ error: String(e) });
    }
  },

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
    get().pushHistory(`range:${rank}`);
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
    get().pushHistory(`name:${rank}`);
    const next = { ...get().clipNames };
    // Stored verbatim. Trimming here ran on every keystroke of a controlled
    // input, so typing a space deleted it before the next letter arrived and
    // "You have to go" came out "Youhavetogo". Whitespace only decides
    // whether the name counts as set; making it safe for the filesystem is
    // sanitizeFilename's job at export, which is the only place it matters.
    if (name.trim()) next[rank] = name;
    else delete next[rank];
    set({ clipNames: next });
  },

  /** Names, renames, or clears (empty/whitespace name) the voice currently
   * showing as speaker `speakerIndex`. Matches against existing profiles
   * first — renaming a voice that's already recognized updates that same
   * profile (and refreshes its embedding to this latest sample) instead of
   * creating a duplicate. A no-op if this speaker has no embedding to
   * identify it by at all. */
  setSpeakerName: (speakerIndex, name) => {
    const trimmed = name.trim();
    const { speakerEmbeddings, speakerProfiles } = get();
    const embedding = speakerEmbeddings[String(speakerIndex)];
    if (!embedding) return;

    const matched = matchSpeakerProfiles(speakerEmbeddings, speakerProfiles)[speakerIndex];

    if (!trimmed) {
      // Clearing the name: drop the matched profile entirely so this voice
      // goes back to unnamed everywhere it's used, not just this row.
      if (matched) {
        set({ speakerProfiles: speakerProfiles.filter((p) => p.id !== matched.id) });
      }
      return;
    }

    if (matched) {
      set({
        speakerProfiles: speakerProfiles.map((p) =>
          p.id === matched.id ? { ...p, name: trimmed, embedding } : p
        ),
      });
    } else {
      set({
        speakerProfiles: [...speakerProfiles, { id: nextId("spk"), name: trimmed, embedding }],
      });
    }
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
      speakerProfiles,
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
          req: {
            path: videoPath,
            model: selectedModel,
            prompt: get().vocabulary || null,
            speakerCount: get().speakerCount,
            start: range.start,
            end: range.end,
          },
        });
        const result = await waitForJob(tid);
        const { segments, speakerEmbeddings } = result
          ? (JSON.parse(result) as TranscribeResult)
          : { segments: [], speakerEmbeddings: {} };
        // This highlight got its own independent transcribe+diarize pass, so
        // its speaker indices only mean anything within this one export —
        // resolve names via voice-fingerprint matching against the user's
        // saved profiles rather than assuming index 0 here is the same
        // person as index 0 anywhere else (see lib/captions.ts).
        const speakerNames = resolveSpeakerNames(speakerEmbeddings, speakerProfiles);
        let segs = censor ? applyCensor(segments) : segments;
        if (style.emojis) segs = addEmojis(segs);
        const pages = layoutRows(shiftPages(paginate(segs, style.maxWordsPerPage), range.start));
        const ass =
          pages.length > 0
            ? buildAss(pages, style, { playResX: outW, playResY: outH, speakerNames })
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
    fitMode = "fill",
    ranksOverride
  ) => {
    const {
      highlights,
      videoPath,
      mediaInfo,
      selectedModel,
      selectedRanks,
      clipOverrides,
      speakerProfiles,
    } = get();
    const ranks = ranksOverride ?? selectedRanks;
    const ordered = highlights
      .filter((h) => ranks.includes(h.rank))
      .map((h) => ({ h, range: clipOverrides[h.rank] ?? { start: h.start, end: h.end } }))
      .sort((a, b) => a.range.start - b.range.start);
    if (!videoPath || !mediaInfo || ordered.length === 0) return;

    const preset = getExportPreset(presetId);
    const { targetW, targetH, maxHeight } = resolveResolution(preset, resolutionId);
    const total = ordered.length;
    let cumulative = 0;
    let mergedPages: CaptionPage[] = [];
    const cutRanges: [number, number][] = [];

    // Each highlight below gets its own independent transcribe+diarize pass,
    // so "speaker 0" in one highlight's segments has no relation to "speaker
    // 0" in another's — merging their pages onto one timeline needs a
    // shared index space, not each highlight's raw local one. A voice that
    // matches a saved profile always gets that profile's slot (so it reads
    // as the same person, with the same color, across every highlight it
    // appears in); an unmatched voice gets its own slot per highlight so it
    // never accidentally shares a color/identity with an unrelated
    // unmatched voice from a different highlight.
    const profileSlot = new Map<string, number>(); // profile id -> global speaker index
    const unnamedSlot = new Map<string, number>(); // "<highlightIdx>:<localIdx>" -> global index
    let nextSlot = 0;
    const globalSpeakerNames: Record<number, string> = {};

    try {
      set({ error: null, exportDone: null });
      for (let i = 0; i < ordered.length; i++) {
        const { range } = ordered[i];
        const { style, censor } = get(); // re-read so mid-run tweaks apply to later clips
        set({ batch: { current: i + 1, total, stage: "transcribing", outputDir: outputPath } });

        const tid = await invoke<string>("transcribe", {
          req: {
            path: videoPath,
            model: selectedModel,
            prompt: get().vocabulary || null,
            speakerCount: get().speakerCount,
            start: range.start,
            end: range.end,
          },
        });
        const result = await waitForJob(tid);
        const { segments: rawSegments, speakerEmbeddings } = result
          ? (JSON.parse(result) as TranscribeResult)
          : { segments: [], speakerEmbeddings: {} };

        const matched = matchSpeakerProfiles(speakerEmbeddings, speakerProfiles);
        const remap = new Map<number, number>();
        for (const seg of rawSegments) {
          if (seg.speaker == null || remap.has(seg.speaker)) continue;
          const profile = matched[seg.speaker];
          let slot: number;
          if (profile) {
            slot = profileSlot.get(profile.id) ?? nextSlot++;
            profileSlot.set(profile.id, slot);
            globalSpeakerNames[slot] = profile.name;
          } else {
            const key = `${i}:${seg.speaker}`;
            slot = unnamedSlot.get(key) ?? nextSlot++;
            unnamedSlot.set(key, slot);
          }
          remap.set(seg.speaker, slot);
        }
        const segments = rawSegments.map((seg) => ({
          ...seg,
          speaker: seg.speaker == null ? null : remap.get(seg.speaker) ?? null,
        }));

        let segs = censor ? applyCensor(segments) : segments;
        if (style.emojis) segs = addEmojis(segs);
        const pages = layoutRows(paginate(segs, style.maxWordsPerPage));
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
          ? buildAss(layoutRows(mergedPages), style, {
              playResX: outW,
              playResY: outH,
              speakerNames: globalSpeakerNames,
            })
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

  buildReel: async (outputPath, presetId, customMb, targetDurationSec, resolutionId, fitMode) => {
    const { highlights, clipOverrides } = get();
    const pick = pickReelHighlights(highlights, clipOverrides, targetDurationSec);
    if (pick.ranks.length === 0) {
      set({ error: "No highlights to build a reel from - scan for highlights or mark a bookmark first." });
      return null;
    }
    await get().compileSelectedHighlights(
      outputPath,
      presetId,
      customMb,
      resolutionId,
      fitMode,
      pick.ranks
    );
    return pick;
  },

  openBatch: () => set({ screen: "batch", exportDone: null }),
  openMontage: () => set({ screen: "montage", exportDone: null }),

  setDiscordWebhook: (url) => {
    localStorage.setItem("cc.discordWebhook", url);
    set({ discordWebhook: url });
  },

  setAutoPostToDiscord: (v) => {
    localStorage.setItem("cc.autoPostDiscord", v ? "1" : "0");
    set({ autoPostToDiscord: v });
  },

  generateMetadata: async () => {
    const { segments, speakerEmbeddings, speakerProfiles } = get();
    if (!segments.length) {
      set({ error: "No transcript to work from - caption this clip first." });
      return;
    }
    const names = resolveSpeakerNames(speakerEmbeddings, speakerProfiles);
    const transcript = segments
      .map((s) => {
        const text = s.words.map((w) => w.text).join(" ");
        const label = speakerLabel(s.speaker, names);
        return label ? `${label}: ${text}` : text;
      })
      .join("\n");
    try {
      set({ error: null, clipMetadata: null });
      const id = await invoke<string>("generate_metadata", { req: { transcript } });
      set({ metadataJob: { id, stage: "metadata", progress: 0 } });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  buildDemo: async (outputPath) => {
    const { videoPath, mediaInfo, segments, style, censor, activeRange, encoder } = get();
    if (!videoPath || !mediaInfo) return;

    // Each half keeps the source's own aspect ratio (no crop needed, since
    // fit_mode is irrelevant when the target already matches source AR),
    // capped to a sane size - this is a shareable teaser, not a full-res
    // deliverable.
    const aspect = mediaInfo.width / mediaInfo.height;
    let halfWidth = Math.min(640, mediaInfo.width);
    halfWidth -= halfWidth % 2;
    let height = Math.round(halfWidth / aspect);
    height -= height % 2;

    let segs = censor ? applyCensor(segments) : segments;
    if (style.emojis) segs = addEmojis(segs);
    let pages = paginate(segs, style.maxWordsPerPage);
    const start = activeRange?.start ?? 0;
    const end = activeRange?.end ?? mediaInfo.durationSec;
    pages = shiftPages(
      pages.filter((p) => p.end > start && p.start < end),
      start
    );
    pages = layoutRows(pages);
    const ass = pages.length ? buildAss(pages, style, { playResX: halfWidth, playResY: height }) : "";

    try {
      set({ error: null, exportDone: null });
      const id = await invoke<string>("build_demo", {
        req: {
          inputPath: videoPath,
          outputPath,
          assContent: ass,
          trimStart: activeRange?.start ?? null,
          trimEnd: activeRange?.end ?? null,
          durationSec: mediaInfo.durationSec,
          halfWidth,
          height,
          crf: null,
          fps: null,
          audioKbps: 128,
          encoder,
          fitMode: null,
        },
      });
      set({ demoJob: { id, stage: "demo", progress: 0 } });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  postToDiscord: async (filePath, message) => {
    const { discordWebhook } = get();
    if (!discordWebhook) return;
    try {
      set({ error: null });
      const id = await invoke<string>("post_to_discord", {
        webhookUrl: discordWebhook,
        filePath,
        message: message ?? null,
      });
      set({ discordJob: { id, stage: "posting", progress: 0 } });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  buildMontage: async (clips, outputPath, presetId, resolutionId, fitMode) => {
    if (clips.length === 0) return;
    const preset = getExportPreset(presetId);
    // Resolved once and applied identically to every clip - the whole point
    // is that every rendered segment shares the same codec parameters, so
    // the final join can be a fast, lossless stream copy.
    const { targetW, targetH, maxHeight } = resolveResolution(preset, resolutionId);
    const isCropped = !!(targetW && targetH);
    const outW = targetW ?? 1920;
    const outH = targetH ?? 1080;
    const { encoder } = get();

    const items = clips.map((c) => {
      let segs = c.censor ? applyCensor(c.segments) : c.segments;
      if (c.style.emojis) segs = addEmojis(segs);
      let pages = paginate(segs, c.style.maxWordsPerPage);
      pages = shiftPages(
        pages.filter((p) => p.end > c.start && p.start < c.end),
        c.start
      );
      pages = layoutRows(pages);
      const ass = pages.length ? buildAss(pages, c.style, { playResX: outW, playResY: outH }) : "";
      return {
        inputPath: c.videoPath,
        assContent: ass,
        targetW,
        targetH,
        crf: preset.crf,
        fps: preset.fps,
        audioKbps: preset.audioKbps,
        durationSec: c.end - c.start,
        trimStart: c.start,
        trimEnd: c.end,
        encoder,
        fitMode: isCropped ? fitMode : null,
        maxHeight,
      };
    });

    try {
      set({ error: null, exportDone: null });
      const id = await invoke<string>("build_montage", { req: { items, outputPath } });
      set({ montageJob: { id, stage: "montage", progress: 0 } });
    } catch (e) {
      set({ error: String(e) });
    }
  },

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

  reviewBatchItem: async (id) => {
    const item = get().batchItems.find((i) => i.id === id);
    if (!item || !item.segments) return;
    await get().openVideo(item.path);
    set({
      segments: item.segments,
      speakerEmbeddings: item.speakerEmbeddings ?? {},
      editorTab: "transcript",
    });
    await get().reviewTranscript();
  },

  /**
   * Process every queued clip: transcribe whole clip -> style captions ->
   * export with the chosen preset. Continues past per-file failures.
   */
  runFileBatch: async (presetId, customMb, outputDir, resolutionId = "source", fitMode = "fill") => {
    const { selectedModel } = get();
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
          req: {
            path: item.path,
            model: selectedModel,
            prompt: get().vocabulary || null,
            speakerCount: get().speakerCount,
            start: null,
            end: null,
          },
        });
        currentBatchJobId = tid;
        const result = await waitForJob(tid, (p) =>
          setItem(item.id, { progress: p.progress })
        );
        currentBatchJobId = null;

        const parsed: TranscribeResult = result
          ? JSON.parse(result)
          : { segments: [], waveform: [], waveformStep: 0.01, waveformOffset: 0, speakerEmbeddings: {} };
        let segments: Segment[] = parsed.segments;
        const speakerEmbeddings = parsed.speakerEmbeddings ?? {};

        // Confidence-gated cleanup: a clip where every flagged word clears
        // automatically skips straight to export like before this existed.
        // One that still has genuinely ambiguous words is held back rather
        // than exporting an unreviewed guess - status "needs_review", picked
        // up later via reviewBatchItem instead of blocking the rest of the
        // batch behind it.
        let cleanupFailed = false;
        if (get().polishAvailable) {
          setItem(item.id, { status: "transcribing", progress: -1 });
          try {
            const pid = await invoke<string>("polish_transcript", {
              req: {
                segments: segments.map((s) => ({
                  id: s.id,
                  words: s.words.map((w) => ({ text: w.text, confidence: w.confidence ?? 1 })),
                })),
                players: get().speakerProfiles.map((p) => p.name),
                threshold: UNSURE_BELOW,
              },
            });
            currentBatchJobId = pid;
            const presult = await waitForJob(pid);
            currentBatchJobId = null;
            const suggestions = presult ? (JSON.parse(presult) as PolishSuggestion[]) : [];
            const forReview = suggestions.filter((s) => s.confidence < AUTO_APPLY_CONFIDENCE);
            const autoApplied = suggestions.filter((s) => s.confidence >= AUTO_APPLY_CONFIDENCE);
            if (autoApplied.length > 0) {
              const bySeg = new Map<string, Map<number, string>>();
              for (const s of autoApplied) {
                if (!bySeg.has(s.segId)) bySeg.set(s.segId, new Map());
                bySeg.get(s.segId)!.set(s.wordIdx, s.suggested);
                void recordPhraseCorrection(s.original, s.suggested);
              }
              segments = segments.map((sg) => {
                const fixes = bySeg.get(sg.id);
                if (!fixes) return sg;
                return {
                  ...sg,
                  words: sg.words.map((w, i) => (fixes.has(i) ? { ...w, text: fixes.get(i)! } : w)),
                };
              });
            }
            if (forReview.length > 0) {
              setItem(item.id, { status: "needs_review", progress: 1, segments, speakerEmbeddings });
              continue;
            }
          } catch {
            // Cleanup pass failing shouldn't block export - carry on with
            // the unreviewed transcript exactly like before this existed,
            // but say so rather than exporting silently as if cleanup had
            // simply found nothing to fix.
            currentBatchJobId = null;
            cleanupFailed = true;
          }
        }

        // Each batch clip is its own file with its own independent
        // diarization pass (and often a different source video entirely),
        // so — same as exportSelectedHighlights — names are resolved by
        // voice match against the project's saved profiles, not by raw
        // index.
        const speakerNames = resolveSpeakerNames(speakerEmbeddings, get().speakerProfiles);
        let segs = censor ? applyCensor(segments) : segments;
        if (style.emojis) segs = addEmojis(segs);
        const pages = layoutRows(paginate(segs, style.maxWordsPerPage));
        const outW = targetW ?? info.width;
        const outH = targetH ?? info.height;
        const ass =
          pages.length > 0
            ? buildAss(pages, style, { playResX: outW, playResY: outH, speakerNames })
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

        setItem(item.id, {
          status: "done",
          progress: 1,
          output: outputPath,
          note: cleanupFailed ? "AI cleanup pass failed for this clip - exported without review" : undefined,
        });
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

  /** Marks a clip by hand around `center`, for the moments the loudness scan
   * won't find — a quiet line that lands, or something visual with no audio
   * spike at all. */
  addBookmark: (center) => {
    get().pushHistory();
    const { highlights, mediaInfo } = get();
    const duration = mediaInfo?.durationSec ?? center + BOOKMARK_AFTER;
    const start = Math.max(0, center - BOOKMARK_BEFORE);
    const end = Math.min(duration, Math.max(start + 1, center + BOOKMARK_AFTER));
    const rank = highlights.reduce((m, h) => Math.max(m, h.rank), -1) + 1;
    const mark: Highlight = { start, end, peak: 0, score: 0, rank, manual: true };
    set({
      highlights: [...highlights, mark],
      selectedRanks: [...get().selectedRanks, rank],
      activeRange: { start, end },
      editingRank: rank,
    });
    return rank;
  },

  setHighlightCount: (n) => {
    localStorage.setItem("cc.highlightCount", n == null ? "auto" : String(n));
    set({ highlightCount: n });
  },

  setHighlightGenre: (g) => {
    localStorage.setItem("cc.highlightGenre", g);
    set({ highlightGenre: g });
  },

  scanForDeaths: () => {
    get().pushHistory();
    const { highlights, segments, selectedRanks } = get();
    const found = findDeathMoments(segments);
    const kept = highlights.filter((h) => !h.death);
    const base = kept.reduce((m, h) => Math.max(m, h.rank), -1) + 1;
    const renumbered = found.map((h, i) => ({ ...h, rank: base + i }));
    set({
      highlights: [...kept, ...renumbered],
      selectedRanks: [...selectedRanks.filter((r) => !highlights.find((h) => h.rank === r)?.death), ...renumbered.map((h) => h.rank)],
    });
    return renumbered.length;
  },

  downloadPolishModel: async () => {
    try {
      set({ error: null });
      const id = await invoke<string>("download_polish_model");
      set({ polishModelJob: { id, stage: "downloading", progress: 0 } });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  reviewTranscript: async () => {
    const { segments, speakerProfiles } = get();
    try {
      set({ error: null, polishSuggestions: [] });
      const id = await invoke<string>("polish_transcript", {
        req: {
          segments: segments.map((s) => ({
            id: s.id,
            words: s.words.map((w) => ({ text: w.text, confidence: w.confidence ?? 1 })),
          })),
          players: speakerProfiles.map((p) => p.name),
          threshold: UNSURE_BELOW,
        },
      });
      set({ polishJob: { id, stage: "polishing", progress: 0 } });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  alignTranscript: async () => {
    const { segments, videoPath } = get();
    if (!videoPath) return;
    get().pushHistory();
    try {
      set({ error: null });
      const id = await invoke<string>("align_transcript", {
        req: {
          videoPath,
          segments: segments.map((s) => ({
            id: s.id,
            speaker: s.speaker ?? undefined,
            pan: s.pan ?? undefined,
            intensity: s.intensity ?? undefined,
            words: s.words.map((w) => ({
              text: w.text,
              start: w.start,
              end: w.end,
              confidence: w.confidence,
            })),
          })),
        },
      });
      set({ alignJob: { id, stage: "aligning", progress: 0 } });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  acceptPolishSuggestion: (index) => {
    const s = get().polishSuggestions[index];
    if (!s) return;
    get().updateWord(s.segId, s.wordIdx, s.suggested);
    void recordPhraseCorrection(s.original, s.suggested);
    set({ polishSuggestions: get().polishSuggestions.filter((_, i) => i !== index) });
  },

  rejectPolishSuggestion: (index) => {
    set({ polishSuggestions: get().polishSuggestions.filter((_, i) => i !== index) });
  },

  acceptAllPolishSuggestions: () => {
    // Applied oldest-first so an earlier word's index in its segment can't
    // shift under a later suggestion for the same segment mid-loop -
    // updateWord replaces text in place rather than the word count, so this
    // is precautionary rather than a known bug, but cheap to get right.
    for (const s of get().polishSuggestions) {
      get().updateWord(s.segId, s.wordIdx, s.suggested);
      void recordPhraseCorrection(s.original, s.suggested);
    }
    set({ polishSuggestions: [] });
  },

  dismissAllPolishSuggestions: () => set({ polishSuggestions: [] }),

  pushHistory: (coalesceKey) => {
    const now = Date.now();
    if (coalesceKey && coalesceKey === lastPushKey && now - lastPushAt < COALESCE_MS) {
      lastPushAt = now; // same gesture still in progress - the snapshot we already have is the one to return to
      return;
    }
    lastPushKey = coalesceKey ?? null;
    lastPushAt = now;
    undoPast.push(snapshot(get()));
    if (undoPast.length > MAX_HISTORY) undoPast.shift();
    undoFuture = [];
    set({ canUndo: true, canRedo: false });
  },

  undo: () => {
    const prev = undoPast.pop();
    if (!prev) return;
    undoFuture.push(snapshot(get()));
    lastPushKey = null; // don't coalesce across an undo
    set({
      ...prev,
      tuningWord: null, // the selected index may not exist in the restored state
      canUndo: undoPast.length > 0,
      canRedo: true,
    });
  },

  redo: () => {
    const next = undoFuture.pop();
    if (!next) return;
    undoPast.push(snapshot(get()));
    lastPushKey = null;
    set({
      ...next,
      tuningWord: null,
      canUndo: true,
      canRedo: undoFuture.length > 0,
    });
  },

  moveWordToSpeaker: (segId, wordIdx, speaker) => {
    const source = get().segments.find((sg) => sg.id === segId);
    const word = source?.words[wordIdx];
    if (!source || !word) return;
    // Whole line already belongs to one word - nothing to split.
    if (source.words.length === 1) {
      get().setSegmentSpeaker(segId, speaker);
      return;
    }
    get().pushHistory();
    const remaining = source.words.filter((_, i) => i !== wordIdx);
    const moved: Segment = {
      id: nextId("useg"),
      words: [word],
      speaker,
      pan: source.pan,
      intensity: source.intensity,
    };
    const segments = get()
      .segments.map((sg) => (sg.id === segId ? { ...sg, words: remaining } : sg))
      .filter((sg) => sg.words.length > 0)
      .concat(moved)
      .sort((a, b) => (a.words[0]?.start ?? 0) - (b.words[0]?.start ?? 0));
    set({ segments, tuningWord: null });
  },

  moveWordsToSpeaker: (updates, speaker) => {
    if (updates.length === 0) return;
    get().pushHistory();
    const bySeg = new Map<string, Set<number>>();
    for (const u of updates) {
      if (!bySeg.has(u.segId)) bySeg.set(u.segId, new Set());
      bySeg.get(u.segId)!.add(u.idx);
    }

    const newSegments: Segment[] = [];
    let segments = get().segments.flatMap((sg) => {
      const idxSet = bySeg.get(sg.id);
      if (!idxSet) return [sg];
      // Every word in this segment is part of the move - no split needed.
      if (idxSet.size === sg.words.length) {
        return [{ ...sg, speaker }];
      }
      const remaining = sg.words.filter((_, i) => !idxSet.has(i));
      const moved = sg.words.filter((_, i) => idxSet.has(i));
      newSegments.push({
        id: nextId("useg"),
        words: moved,
        speaker,
        pan: sg.pan,
        intensity: sg.intensity,
      });
      return remaining.length > 0 ? [{ ...sg, words: remaining }] : [];
    });
    segments = [...segments, ...newSegments].sort(
      (a, b) => (a.words[0]?.start ?? 0) - (b.words[0]?.start ?? 0)
    );
    set({ segments, tuningWord: null });
  },

  setSegmentSpeaker: (segId, speaker) => {
    get().pushHistory();
    set({
      segments: get().segments.map((sg) => (sg.id === segId ? { ...sg, speaker } : sg)),
    });
  },

  setEditorTab: (t) => set({ editorTab: t }),

  dismissRestoredNotice: () => set({ restoredSession: false }),

  discardSession: async () => {
    const { videoPath } = get();
    if (!videoPath) return;
    disarmAutosave();
    set({
      segments: [],
      transcriptSourceRank: null,
      tuningWord: null,
      highlights: [],
      activeRange: null,
      selectedRanks: [],
      clipOverrides: {},
      clipNames: {},
      editingRank: null,
      projectPath: null,
      restoredSession: false,
    });
    // Overwrite rather than delete: the next autosave would recreate it
    // anyway, and there's no delete-file command to add for one caller.
    try {
      const path = await invoke<string>("session_file", { videoPath });
      await invoke("write_text_file", { path, content: "{}" });
    } catch {
      /* an autosave we couldn't clear isn't worth an error banner */
    }
    armAutosave();
  },

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
      speakerProfiles,
      selectedRanks,
      activeRange,
      segments,
      transcriptSourceRank,
      waveform,
      waveformStep,
      waveformOffset,
      speakerEmbeddings,
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
      speakerProfiles,
      selectedRanks,
      activeRange,
      segments,
      transcriptSourceRank,
      waveform,
      waveformStep,
      waveformOffset,
      speakerEmbeddings,
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
      // openVideo catches its own errors internally (so a failed drag-drop
      // open doesn't crash) rather than throwing - which means a video that
      // no longer exists at its saved path (moved, renamed, drive letter
      // changed) fails silently there, and this call would otherwise carry
      // straight on applying the project's transcript/highlights against
      // nothing. Bail here instead, with openVideo's own error still on
      // screen from when it set it.
      if (get().videoPath !== project.videoPath) return;
      set({
        selectedModel: project.selectedModel ?? get().selectedModel,
        style: project.style ?? get().style,
        censor: project.censor ?? get().censor,
        highlights: project.highlights ?? [],
        clipOverrides: project.clipOverrides ?? {},
        clipNames: project.clipNames ?? {},
        speakerProfiles: project.speakerProfiles ?? [],
        selectedRanks: project.selectedRanks ?? [],
        activeRange: project.activeRange ?? null,
        segments: project.segments ?? [],
        transcriptSourceRank: project.transcriptSourceRank ?? null,
        waveform: project.waveform ?? [],
        waveformStep: project.waveformStep ?? 0.01,
        waveformOffset: project.waveformOffset ?? 0,
        speakerEmbeddings: project.speakerEmbeddings ?? {},
        projectPath: path,
      });
    } catch (e) {
      set({ error: String(e) });
    }
  },
}));

// Debounced autosave. Subscribing here rather than calling a save from each
// mutation means a new action can't forget to persist itself.
useApp.subscribe((state) => {
  if (!autosaveArmed || !state.videoPath) return;
  const slice = sessionSlice(state);
  const changed =
    !lastSlice || (Object.keys(slice) as (keyof SessionSlice)[]).some((k) => slice[k] !== lastSlice![k]);
  lastSlice = slice;
  if (!changed) return;
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    autosaveTimer = null;
    void writeSession(useApp.getState());
  }, 1200);
});
