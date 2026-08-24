import { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../store";
import { fmtTime, isUnsure, resolveSpeakerNames } from "../lib/captions";
import { speakerColor, speakerLabel, speakerLanes } from "../lib/speakers";
import type { WordSpan } from "../types";

interface Props {
  videoRef: React.RefObject<HTMLVideoElement | null>;
}

// Vertical layout. The waveform keeps its own band across the top; below it
// every speaker gets a lane of their own, like video-editor tracks, so people
// talking over each other (proximity chat, constantly) stop overlapping into
// one illegible pile of blocks.
const TICKS_H = 14;
const WAVE_H = 52;
const LANE_H = 26;
const LANE_GAP = 3;
const LANES_TOP = TICKS_H + WAVE_H;
const laneTop = (lane: number) => LANES_TOP + lane * (LANE_H + LANE_GAP);
const heightFor = (laneCount: number) => laneTop(laneCount) + 2;

const MIN_WORD_DUR = 0.05;
const MIN_CREATE_DUR = 0.1; // shorter than this on pointerup is treated as a plain click/seek
const HANDLE_VISUAL_PX = 6;
const HANDLE_HIT_PX = 9;
const MIN_PXSEC = 10;
// Deliberately far past what the "+" button reaches in a few taps: a run of
// hurried words ("go, go, go, go") can be 60ms each, which is under a pixel
// at fit-to-clip zoom and physically impossible to grab. Zoom to word (below)
// jumps straight here when you need it.
const MAX_PXSEC = 4000;
const AUTO_PXSEC_CAP = 160; // don't auto-zoom in more than this just because a clip is short
const MAX_CANVAS_W = 30000; // stay well under browser canvas dimension limits
const NICE_INTERVALS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200];

type WordHit = { flatIdx: number; segId: string; idx: number; mode: "move" | "start" | "end" };
type Drag =
  | {
      kind: "word";
      flatIdx: number;
      segId: string;
      idx: number;
      mode: "move" | "start" | "end";
      /** Lane the pointer is currently over, for dragging into another
       * speaker's track. */
      dropLane: number | null;
      /** Shift at drag start means "move the whole line", not just this word. */
      wholeLine: boolean;
      startPointerTime: number;
      origStart: number;
      origEnd: number;
      moved: boolean;
    }
  | {
      kind: "create";
      /** Lane the drag started in - the new line is filed under that lane's
       * speaker instead of becoming a nameless extra track. */
      lane: number | null;
      startPointerTime: number;
      gapStart: number;
      gapEnd: number;
      moved: boolean;
      curStart: number;
      curEnd: number;
    };

interface Draft {
  start: number;
  end: number;
  text: string;
  confirming: boolean;
  lane: number | null;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** The primary caption-timing editor: a wide, zoomable waveform strip under
 * the video showing whichever part of the clip is currently in scope — the
 * selected highlight range if one is active, else the full transcript, else
 * the whole video. Dragging an existing word's edges/middle retimes it
 * (same gesture as before, just with real room to work with instead of a
 * narrow sidebar). Dragging on an EMPTY stretch of waveform — silence
 * whisper produced no caption for at all — draws a new region and prompts
 * for its text, so speech whisper missed entirely can be added by hand. */
export default function MainWaveform({ videoRef }: Props) {
  const segments = useApp((s) => s.segments);
  const waveform = useApp((s) => s.waveform);
  const waveformStep = useApp((s) => s.waveformStep);
  const waveformOffset = useApp((s) => s.waveformOffset);
  const mediaInfo = useApp((s) => s.mediaInfo);
  const activeRange = useApp((s) => s.activeRange);
  const tuningWord = useApp((s) => s.tuningWord);
  const setTuningWord = useApp((s) => s.setTuningWord);
  const setWordTime = useApp((s) => s.setWordTime);
  const insertSegment = useApp((s) => s.insertSegment);
  const removeWord = useApp((s) => s.removeWord);
  const setSegmentSpeaker = useApp((s) => s.setSegmentSpeaker);
  const moveWordToSpeaker = useApp((s) => s.moveWordToSpeaker);
  const style = useApp((s) => s.style);
  const speakerEmbeddings = useApp((s) => s.speakerEmbeddings);
  const speakerProfiles = useApp((s) => s.speakerProfiles);

  // Same resolution the captions and transcript use, so a named voice reads
  // as that name everywhere rather than "Speaker B" in this one panel.
  const speakerNames = useMemo(
    () => resolveSpeakerNames(speakerEmbeddings, speakerProfiles),
    [speakerEmbeddings, speakerProfiles]
  );

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const insertInputRef = useRef<HTMLInputElement>(null);

  const [viewW, setViewW] = useState(600);
  const [zoomOverride, setZoomOverride] = useState<number | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dropLane, setDropLane] = useState<number | null>(null);

  // The time range this instance is currently scoped to: the selected
  // highlight if one is active (the literal "whichever part of the clip is
  // selected at the time"), else the span of the current transcript, else
  // the whole video.
  const range = useMemo(() => {
    if (activeRange) return { start: activeRange.start, end: activeRange.end };
    if (segments.length) {
      let lo = Infinity;
      let hi = 0;
      for (const s of segments) {
        for (const w of s.words) {
          if (w.start < lo) lo = w.start;
          if (w.end > hi) hi = w.end;
        }
      }
      if (lo !== Infinity) return { start: Math.max(0, lo - 1), end: hi + 1 };
    }
    return { start: 0, end: mediaInfo?.durationSec ?? 1 };
  }, [activeRange, segments, mediaInfo]);

  const totalDur = Math.max(0.5, range.end - range.start);

  const speakerCount = useApp((s) => s.speakerCount);
  const lanes = useMemo(
    () => speakerLanes(segments.map((s) => s.speaker), speakerCount ?? 0),
    [segments, speakerCount]
  );

  const flat = useMemo(() => {
    const laneOf = new Map(lanes.map((sp, i) => [sp ?? "?", i] as const));
    const arr: { segId: string; idx: number; w: WordSpan; speaker: number | null; lane: number }[] = [];
    for (const s of segments) {
      const lane = laneOf.get(s.speaker ?? "?") ?? 0;
      s.words.forEach((w, idx) => arr.push({ segId: s.id, idx, w, speaker: s.speaker, lane }));
    }
    arr.sort((a, b) => a.w.start - b.w.start);
    return arr;
  }, [segments, lanes]);

  const HEIGHT = heightFor(lanes.length);
  const unsureCount = useMemo(() => flat.filter((e) => isUnsure(e.w)).length, [flat]);

  // With a single lane there's nothing to disambiguate, so the whole strip
  // stays grabbable exactly as it was before lanes existed. With several,
  // pointer Y picks the lane - dragging in the waveform band above them means
  // "draw a new caption", not "grab whichever word happens to be at this time".
  const laneAtY = (y: number): number | null => {
    if (lanes.length <= 1) return 0;
    if (y < LANES_TOP) return null;
    const lane = Math.floor((y - LANES_TOP) / (LANE_H + LANE_GAP));
    return lane >= 0 && lane < lanes.length ? lane : null;
  };

  // Measure the visible (non-scrolling) width of the strip.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setViewW(el.clientWidth || 600);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Reset any manual zoom when switching to a different range (new highlight,
  // new video, transcript replaced) so it doesn't stay absurdly zoomed in/out.
  useEffect(() => {
    setZoomOverride(null);
  }, [range.start, range.end]);

  let pxPerSec = clamp(zoomOverride ?? clamp(viewW / totalDur, MIN_PXSEC, AUTO_PXSEC_CAP), MIN_PXSEC, MAX_PXSEC);
  if (pxPerSec * totalDur > MAX_CANVAS_W) pxPerSec = MAX_CANVAS_W / totalDur;
  const width = Math.max(viewW, Math.round(pxPerSec * totalDur));

  const timeAtX = (x: number) => range.start + x / pxPerSec;
  const xAtTime = (t: number) => (t - range.start) * pxPerSec;

  const zoom = (factor: number) =>
    setZoomOverride(clamp((zoomOverride ?? pxPerSec) * factor, MIN_PXSEC, MAX_PXSEC));

  /** Selects the next word whisper wasn't sure about, after whatever is
   * selected now (or after the playhead), and brings it into view.
   *
   * This is the whole point of carrying confidence: instead of scrubbing a
   * two-hour clip looking for mistakes, you tap through the short list of
   * words the model itself flagged as shaky. */
  const nextUnsure = () => {
    const from = tuningWord
      ? flat.findIndex((e) => e.segId === tuningWord.segId && e.idx === tuningWord.idx)
      : flat.findIndex((e) => e.w.start >= playhead) - 1;
    // Wraps, so tapping it repeatedly cycles the clip rather than dead-ending.
    for (let n = 1; n <= flat.length; n++) {
      const e = flat[(Math.max(from, -1) + n + flat.length) % flat.length];
      if (!isUnsure(e.w)) continue;
      setTuningWord({ segId: e.segId, idx: e.idx });
      const v = videoRef.current;
      if (v) v.currentTime = Math.max(0, e.w.start + 0.001);
      const wrap = wrapRef.current;
      if (wrap) {
        wrap.scrollLeft = Math.max(0, xAtTime(e.w.start) - wrap.clientWidth / 2);
      }
      return;
    }
  };

  /** Zooms and scrolls until the selected word is comfortably draggable.
   * Aims for it to fill about a quarter of the visible strip, which leaves
   * its neighbours (and its handles) in view to drag against. */
  const zoomToWord = () => {
    const w = tuningWord && segments.find((sg) => sg.id === tuningWord.segId)?.words[tuningWord.idx];
    if (!w) return;
    const dur = Math.max(0.02, w.end - w.start);
    const target = clamp((viewW * 0.25) / dur, MIN_PXSEC, MAX_PXSEC);
    setZoomOverride(target);
    // Centre it once the new width has been laid out.
    requestAnimationFrame(() => {
      const wrap = wrapRef.current;
      if (!wrap) return;
      const mid = (w.start + w.end) / 2 - range.start;
      wrap.scrollLeft = Math.max(0, mid * target - wrap.clientWidth / 2);
    });
  };

  // Live playhead, synced while the video plays.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const v = videoRef.current;
      if (v) setPlayhead(v.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [videoRef]);

  // Auto-scroll to keep the playhead in view while it's within this range.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || playhead < range.start - 0.05 || playhead > range.end + 0.05) return;
    const x = xAtTime(playhead);
    if (x < wrap.scrollLeft + 30 || x > wrap.scrollLeft + wrap.clientWidth - 30) {
      wrap.scrollLeft = Math.max(0, x - wrap.clientWidth / 2);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playhead]);

  useEffect(() => {
    if (draft?.confirming) insertInputRef.current?.focus();
  }, [draft?.confirming]);

  // Delete/Backspace removes the selected word. The timeline is a canvas and
  // never takes keyboard focus, so this listens at the window and bails out
  // whenever a text field has focus - otherwise it would eat every Backspace
  // typed into the transcript or a clip name.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace" && e.key !== "z" && e.key !== "Z") return;
      if (!tuningWord) return;
      if (e.ctrlKey || e.metaKey) return; // leave Ctrl+Z to undo
      const el = document.activeElement;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (el as HTMLElement)?.isContentEditable) {
        return;
      }
      e.preventDefault();
      if (e.key === "z" || e.key === "Z") {
        zoomToWord();
        return;
      }
      removeWord(tuningWord.segId, tuningWord.idx);
      setTuningWord(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tuningWord, removeWord, setTuningWord]);

  // Draw.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = HEIGHT * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${HEIGHT}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, HEIGHT);

    // time ticks
    const rawInterval = 90 / pxPerSec;
    const interval = NICE_INTERVALS.find((n) => n >= rawInterval) ?? 1200;
    ctx.font = "10px -apple-system, Segoe UI, sans-serif";
    ctx.textBaseline = "top";
    for (let t = Math.ceil(range.start / interval) * interval; t < range.end; t += interval) {
      const x = xAtTime(t);
      ctx.strokeStyle = "rgba(255,255,255,0.06)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, HEIGHT);
      ctx.stroke();
      ctx.fillStyle = "rgba(232, 235, 242, 0.35)";
      ctx.fillText(fmtTime(t), x + 3, 2);
    }

    // waveform bars, confined to their own band above the speaker lanes
    const mid = TICKS_H + WAVE_H / 2;
    ctx.fillStyle = "rgba(232, 235, 242, 0.28)";
    if (waveform.length > 0 && waveformStep > 0) {
      for (let x = 0; x < width; x++) {
        const t = timeAtX(x);
        const bucket = Math.floor((t - waveformOffset) / waveformStep);
        if (bucket < 0 || bucket >= waveform.length) continue;
        const amp = Math.min(1, waveform[bucket]);
        const h = Math.max(1, amp * (WAVE_H - 6));
        ctx.fillRect(x, mid - h / 2, 1, h);
      }
    }

    // lane beds, so an empty lane still reads as a track rather than a void
    for (let i = 0; i < lanes.length; i++) {
      const isDrop = i === dropLane;
      ctx.fillStyle = isDrop
        ? "rgba(124, 92, 255, 0.20)"
        : i % 2 === 0
        ? "rgba(255,255,255,0.028)"
        : "rgba(255,255,255,0.014)";
      ctx.fillRect(0, laneTop(i), width, LANE_H);
      if (isDrop) {
        ctx.strokeStyle = "rgba(124, 92, 255, 0.9)";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(0.5, laneTop(i) + 0.5, width - 1, LANE_H - 1);
      }
    }

    const drawHandle = (x: number, top: number, color: string) => {
      const hx = x - HANDLE_VISUAL_PX / 2;
      ctx.fillStyle = color;
      if (ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(hx, top + 2, HANDLE_VISUAL_PX, LANE_H - 4, 2.5);
        ctx.fill();
      } else {
        ctx.fillRect(hx, top + 2, HANDLE_VISUAL_PX, LANE_H - 4);
      }
      ctx.fillStyle = "rgba(11, 13, 18, 0.6)";
      const cy = top + LANE_H / 2;
      for (const dy of [-4, 0, 4]) {
        ctx.fillRect(hx + 1.5, cy + dy - 0.7, HANDLE_VISUAL_PX - 3, 1.4);
      }
    };

    // word regions, one lane per speaker
    for (const { segId, idx, w, speaker, lane } of flat) {
      const x1 = xAtTime(w.start);
      const x2 = xAtTime(w.end);
      if (x2 < 0 || x1 > width) continue; // off-screen, skip drawing (still hit-testable via time math)
      const active = tuningWord?.segId === segId && tuningWord.idx === idx;
      const col = speakerColor(speaker, style.speakerColors);
      const top = laneTop(lane);
      const bw = Math.max(1, x2 - x1);

      ctx.fillStyle = active ? "rgba(255, 255, 255, 0.26)" : col.soft;
      ctx.fillRect(x1, top, bw, LANE_H);
      ctx.strokeStyle = active ? "#ffffff" : col.line;
      ctx.lineWidth = active ? 2 : 1;
      ctx.strokeRect(x1 + 0.5, top + 0.5, Math.max(1, bw - 1), LANE_H - 1);

      const handleColor = active ? "#ffffff" : col.solid;
      drawHandle(x1, top, handleColor);
      drawHandle(x2, top, handleColor);

      // Amber underline for a word whisper doubted - same meaning as the
      // wavy underline in the transcript, drawn where it survives being one
      // pixel wide.
      if (isUnsure(w)) {
        ctx.fillStyle = "rgba(255, 196, 84, 0.95)";
        ctx.fillRect(x1, top + LANE_H - 3, bw, 2);
      }

      const label = w.text.length > 18 ? w.text.slice(0, 17) + "…" : w.text;
      ctx.fillStyle = "rgba(232, 235, 242, 0.95)";
      ctx.font = "11px -apple-system, Segoe UI, sans-serif";
      const tw = ctx.measureText(label).width;
      if (tw < bw - 4) {
        ctx.fillText(label, x1 + bw / 2 - tw / 2, top + 7);
      }
    }

    // in-progress / pending "new caption" draft
    if (draft) {
      const x1 = xAtTime(draft.start);
      const x2 = xAtTime(draft.end);
      ctx.fillStyle = "rgba(255, 196, 84, 0.22)";
      ctx.fillRect(x1, LANES_TOP, Math.max(1, x2 - x1), HEIGHT - LANES_TOP - 2);
      ctx.strokeStyle = "rgba(255, 196, 84, 0.9)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(x1 + 0.5, LANES_TOP + 0.5, Math.max(1, x2 - x1 - 1), HEIGHT - LANES_TOP - 3);
      ctx.setLineDash([]);
    }

    // playhead
    if (playhead >= range.start && playhead <= range.end) {
      const px = xAtTime(playhead);
      ctx.strokeStyle = "#ff5c7a";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, HEIGHT);
      ctx.stroke();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flat, lanes, HEIGHT, dropLane, style.speakerColors, tuningWord, waveform, waveformStep, waveformOffset, playhead, width, pxPerSec, range.start, range.end, draft]);

  /** Nearest words in the SAME lane, which is what may actually constrain a
   * drag. Using flat[i-1]/flat[i+1] instead meant a line in one speaker's
   * lane was blocked by an unrelated word in another's, purely because it
   * happened to sit next to it in time. Lanes are independent tracks; they
   * only collide with themselves. */
  const laneNeighbours = (flatIdx: number): { prevEnd: number; nextStart: number } => {
    const lane = flat[flatIdx]?.lane;
    let prevEnd = 0;
    for (let i = flatIdx - 1; i >= 0; i--) {
      if (flat[i].lane === lane) {
        prevEnd = flat[i].w.end;
        break;
      }
    }
    let nextStart = Infinity;
    for (let i = flatIdx + 1; i < flat.length; i++) {
      if (flat[i].lane === lane) {
        nextStart = flat[i].w.start;
        break;
      }
    }
    return { prevEnd, nextStart };
  };

  const hitTest = (x: number, y: number): WordHit | null => {
    const lane = laneAtY(y);
    if (lane == null) return null;
    for (let i = 0; i < flat.length; i++) {
      const { w } = flat[i];
      if (flat[i].lane !== lane) continue;
      const x1 = xAtTime(w.start);
      const x2 = xAtTime(w.end);
      if (x < x1 - HANDLE_HIT_PX || x > x2 + HANDLE_HIT_PX) continue;
      if (x <= x1 + HANDLE_HIT_PX) return { flatIdx: i, segId: flat[i].segId, idx: flat[i].idx, mode: "start" };
      if (x >= x2 - HANDLE_HIT_PX) return { flatIdx: i, segId: flat[i].segId, idx: flat[i].idx, mode: "end" };
      return { flatIdx: i, segId: flat[i].segId, idx: flat[i].idx, mode: "move" };
    }
    return null;
  };

  /** The empty span around `t` in one lane - where a new line may be drawn.
   * Scoped to the lane for the same reason as laneNeighbours: another
   * speaker talking over this moment doesn't occupy this track. */
  const gapAt = (t: number, lane: number | null): [number, number] => {
    let lo = 0;
    let hi = mediaInfo?.durationSec ?? t + 30;
    for (const entry of flat) {
      if (lane != null && entry.lane !== lane) continue;
      const { w } = entry;
      if (w.end <= t && w.end > lo) lo = w.end;
      if (w.start >= t && w.start < hi) hi = w.start;
    }
    return [lo, hi];
  };

  const cursorFor = (mode: "move" | "start" | "end" | null) =>
    mode === "start" || mode === "end" ? "ew-resize" : mode === "move" ? "grab" : "text";

  const clampX = (x: number) => clamp(x, 0, width);

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (draft?.confirming) {
      // A pending "add this caption?" prompt is open — dismiss it first
      // rather than starting a second drag underneath it.
      setDraft(null);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const x = clampX(e.clientX - rect.left);
    const t = timeAtX(x);
    const hit = hitTest(x, e.clientY - rect.top);

    if (hit) {
      setTuningWord({ segId: hit.segId, idx: hit.idx });
      const v = videoRef.current;
      if (v) v.currentTime = Math.max(0, flat[hit.flatIdx].w.start + 0.001);
      dragRef.current = {
        kind: "word",
        flatIdx: hit.flatIdx,
        segId: hit.segId,
        idx: hit.idx,
        mode: hit.mode,
        dropLane: null,
        wholeLine: e.shiftKey,
        startPointerTime: t,
        origStart: flat[hit.flatIdx].w.start,
        origEnd: flat[hit.flatIdx].w.end,
        moved: false,
      };
      e.currentTarget.style.cursor = hit.mode === "move" ? "grabbing" : "ew-resize";
    } else {
      const lane = laneAtY(e.clientY - rect.top);
      const [gapStart, gapEnd] = gapAt(t, lane);
      dragRef.current = {
        kind: "create",
        lane,
        startPointerTime: t,
        gapStart,
        gapEnd,
        moved: false,
        curStart: t,
        curEnd: t,
      };
      setDraft({ start: t, end: t, text: "", confirming: false, lane });
    }
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = clampX(e.clientX - rect.left);

    if (!drag) {
      e.currentTarget.style.cursor = draft?.confirming
        ? "default"
        : cursorFor(hitTest(x, e.clientY - rect.top)?.mode ?? null);
      return;
    }

    const t = timeAtX(x);
    if (drag.kind === "word") {
      if (drag.mode === "move") {
        const over = laneAtY(e.clientY - rect.top);
        const from = flat[drag.flatIdx]?.lane;
        const next = over != null && over !== from ? over : null;
        if (next !== drag.dropLane) {
          drag.dropLane = next;
          setDropLane(next); // redraw so the target track highlights
        }
      }
      const delta = t - drag.startPointerTime;
      if (Math.abs(delta) > 0.005) drag.moved = true;
      const { prevEnd, nextStart } = laneNeighbours(drag.flatIdx);

      if (drag.mode === "start") {
        const newStart = Math.max(prevEnd, Math.min(t, drag.origEnd - MIN_WORD_DUR));
        setWordTime(drag.segId, drag.idx, "start", newStart);
      } else if (drag.mode === "end") {
        const newEnd = Math.min(nextStart, Math.max(t, drag.origStart + MIN_WORD_DUR));
        setWordTime(drag.segId, drag.idx, "end", newEnd);
      } else {
        const dur = drag.origEnd - drag.origStart;
        let newStart = drag.origStart + delta;
        newStart = Math.max(prevEnd, Math.min(newStart, nextStart - dur));
        const newEnd = newStart + dur;
        setWordTime(drag.segId, drag.idx, "start", newStart);
        setWordTime(drag.segId, drag.idx, "end", newEnd);
      }
    } else {
      if (Math.abs(t - drag.startPointerTime) > 0.01) drag.moved = true;
      const a = Math.max(drag.gapStart, Math.min(drag.startPointerTime, t));
      const b = Math.min(drag.gapEnd, Math.max(drag.startPointerTime, t));
      drag.curStart = a;
      drag.curEnd = b;
      setDraft({ start: a, end: b, text: "", confirming: false, lane: drag.lane });
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* not captured — fine */
    }

    if (drag?.kind === "word") {
      if (!drag.moved) {
        const v = videoRef.current;
        if (v) v.currentTime = Math.max(0, flat[drag.flatIdx]?.w.start ?? drag.startPointerTime);
      }
      if (drag.dropLane != null) {
        const speaker = lanes[drag.dropLane] ?? null;
        // Just this word by default. Diarization gets a word or two wrong at
        // a turn boundary far more often than it misattributes a whole line,
        // and taking the entire line along made it impossible to peel one
        // word onto a third speaker's track. Shift takes the whole line.
        if (drag.wholeLine) setSegmentSpeaker(drag.segId, speaker);
        else moveWordToSpeaker(drag.segId, drag.idx, speaker);
      }
      setDropLane(null);
    } else if (drag?.kind === "create") {
      if (drag.moved && drag.curEnd - drag.curStart >= MIN_CREATE_DUR) {
        setDraft({ start: drag.curStart, end: drag.curEnd, text: "", confirming: true, lane: drag.lane });
      } else {
        setDraft(null);
        const v = videoRef.current;
        if (v) v.currentTime = Math.max(0, drag.startPointerTime);
      }
    }

    const rect = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.cursor = cursorFor(
      hitTest(clampX(e.clientX - rect.left), e.clientY - rect.top)?.mode ?? null
    );
  };

  const commitInsert = () => {
    if (!draft || !draft.confirming) return;
    const text = draft.text.trim();
    if (!text) return;
    const speaker = draft.lane != null ? lanes[draft.lane] ?? null : null;
    const segId = insertSegment(draft.start, draft.end, text, speaker);
    setTuningWord({ segId, idx: 0 });
    const v = videoRef.current;
    if (v) v.currentTime = Math.max(0, draft.start + 0.001);
    setDraft(null);
  };

  if (!mediaInfo) return null;

  return (
    <div className="main-waveform">
      <div className="mw-toolbar">
        <span className="muted small">
          {activeRange
            ? "Editing the selected clip range — drag a word to retime it, or drag empty space to add a missed line."
            : segments.length
            ? "Editing the full transcript — drag a word to retime it, or drag empty space to add a missed line."
            : "No captions yet — drag on the waveform below to add one by hand."}
        </span>
        <span className="mw-zoom">
          <button className="btn btn-ghost btn-small" onClick={() => zoom(1 / 1.4)} title="Zoom out">
            −
          </button>
          <span className="muted small mw-zoom-val">{Math.round(pxPerSec)}px/s</span>
          <button className="btn btn-ghost btn-small" onClick={() => zoom(1.4)} title="Zoom in">
            +
          </button>
          <button className="btn btn-ghost btn-small" onClick={() => setZoomOverride(null)}>
            Fit
          </button>
          <button
            className="btn btn-ghost btn-small"
            onClick={zoomToWord}
            disabled={!tuningWord}
            title="Zoom in on the selected word until it's big enough to drag (Z)"
          >
            ⤢ Word
          </button>
          <button
            className="btn btn-ghost btn-small"
            onClick={nextUnsure}
            disabled={unsureCount === 0}
            title={
              unsureCount === 0
                ? "Nothing flagged - whisper was confident about every word here"
                : `Jump to the next word whisper wasn't sure about (${unsureCount} in this transcript)`
            }
          >
            ⚠ {unsureCount}
          </button>
        </span>
      </div>
      <div className="mw-tracks">
        <div className="mw-gutter" style={{ paddingTop: LANES_TOP }}>
          {lanes.map((sp, i) => (
            <div
              key={sp ?? "unknown"}
              className="mw-lane-head"
              style={{ height: LANE_H, marginBottom: LANE_GAP }}
              title={
                sp == null
                  ? "Speech that voice-fingerprint diarization couldn't attribute to a speaker"
                  : speakerLabel(sp, speakerNames)
              }
            >
              <span className="mw-lane-chip" style={{ background: speakerColor(sp, style.speakerColors).solid }} />
              <span className="mw-lane-name">{speakerLabel(sp, speakerNames)}</span>
            </div>
          ))}
        </div>
      <div className="waveform-wrap mw-wrap" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          className="waveform-canvas"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        />
      </div>
      </div>
      {draft?.confirming && (
        <div className="mw-insert-bar">
          <span className="muted small">
            New caption {fmtTime(draft.start)}–{fmtTime(draft.end)}:
          </span>
          <input
            ref={insertInputRef}
            className="mw-insert-input"
            placeholder="what was said…"
            value={draft.text}
            onChange={(e) => setDraft({ ...draft, text: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitInsert();
              if (e.key === "Escape") setDraft(null);
            }}
          />
          <button className="btn btn-primary btn-small" onClick={commitInsert} disabled={!draft.text.trim()}>
            Add
          </button>
          <button className="btn btn-ghost btn-small" onClick={() => setDraft(null)}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
