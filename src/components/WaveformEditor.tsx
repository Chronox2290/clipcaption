import { useEffect, useRef, useState } from "react";
import { useApp } from "../store";
import type { WordSpan } from "../types";

interface Props {
  segId: string;
  words: WordSpan[];
  activeIndex: number | null;
  onSelectWord: (idx: number) => void;
  videoRef: React.RefObject<HTMLVideoElement | null>;
}

const PX_PER_SEC = 170;
const PAD_SEC = 0.6; // context shown before/after the segment's own words
const HEIGHT = 64;
const MIN_WORD_DUR = 0.05;
const HANDLE_VISUAL_PX = 6; // drawn width of each drag bar
const HANDLE_HIT_PX = 9; // grabbable radius around a drag bar — wider than the visual for forgiving hit-testing

/** Drag-to-retime waveform strip for one transcript segment. Renders the
 * segment's own slice of the shared amplitude envelope with each word drawn
 * as a draggable region on top: drag an edge to change just that boundary,
 * drag the middle to shift the whole word. This is the direct replacement
 * for "nudge the start/end with buttons" — seeing the actual audio makes it
 * obvious where a word really starts, instead of guessing by ear alone. */
export default function WaveformEditor({ segId, words, activeIndex, onSelectWord, videoRef }: Props) {
  const waveform = useApp((s) => s.waveform);
  const waveformStep = useApp((s) => s.waveformStep);
  const waveformOffset = useApp((s) => s.waveformOffset);
  const setWordTime = useApp((s) => s.setWordTime);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [playhead, setPlayhead] = useState(0);
  const dragRef = useRef<{
    mode: "move" | "start" | "end";
    idx: number;
    startPointerTime: number;
    origStart: number;
    origEnd: number;
    moved: boolean;
  } | null>(null);

  const hasWords = words.length > 0;
  const segStart = hasWords ? Math.max(0, words[0].start - PAD_SEC) : 0;
  const segEnd = hasWords ? words[words.length - 1].end + PAD_SEC : 1;
  const duration = Math.max(0.5, segEnd - segStart);
  const width = Math.max(120, Math.round(duration * PX_PER_SEC));

  const timeAtX = (x: number) => segStart + x / PX_PER_SEC;
  const xAtTime = (t: number) => (t - segStart) * PX_PER_SEC;

  // Live playhead, synced while the video plays (and once on mount/seek).
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

  // Auto-scroll the strip to keep the playhead in view.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const x = xAtTime(playhead);
    if (x < wrap.scrollLeft + 20 || x > wrap.scrollLeft + wrap.clientWidth - 20) {
      if (playhead >= segStart - 0.05 && playhead <= segEnd + 0.05) {
        wrap.scrollLeft = Math.max(0, x - wrap.clientWidth / 2);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playhead]);

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

    // waveform bars
    const mid = HEIGHT / 2;
    ctx.fillStyle = "rgba(232, 235, 242, 0.28)";
    if (waveform.length > 0 && waveformStep > 0) {
      for (let x = 0; x < width; x++) {
        const t = timeAtX(x);
        const bucket = Math.floor((t - waveformOffset) / waveformStep);
        if (bucket < 0 || bucket >= waveform.length) continue;
        const amp = Math.min(1, waveform[bucket]);
        const h = Math.max(1, amp * (HEIGHT - 6));
        ctx.fillRect(x, mid - h / 2, 1, h);
      }
    }

    // A visible, grabbable "drag bar" at each word boundary — wider than a
    // plain outline and marked with grip notches so it reads as draggable at
    // a glance, not just as the edge of a highlighted region.
    const drawHandle = (x: number, color: string) => {
      const hx = x - HANDLE_VISUAL_PX / 2;
      ctx.fillStyle = color;
      if (ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(hx, 3, HANDLE_VISUAL_PX, HEIGHT - 6, 2.5);
        ctx.fill();
      } else {
        ctx.fillRect(hx, 3, HANDLE_VISUAL_PX, HEIGHT - 6);
      }
      ctx.fillStyle = "rgba(11, 13, 18, 0.6)";
      const cy = HEIGHT / 2;
      for (const dy of [-6, 0, 6]) {
        ctx.fillRect(hx + 1.5, cy + dy - 0.7, HANDLE_VISUAL_PX - 3, 1.4);
      }
    };

    // word regions
    words.forEach((w, i) => {
      const x1 = Math.max(0, xAtTime(w.start));
      const x2 = Math.min(width, xAtTime(w.end));
      const active = i === activeIndex;
      ctx.fillStyle = active ? "rgba(46, 230, 255, 0.22)" : "rgba(124, 92, 255, 0.14)";
      ctx.fillRect(x1, 2, Math.max(1, x2 - x1), HEIGHT - 4);
      ctx.strokeStyle = active ? "rgba(46, 230, 255, 0.85)" : "rgba(124, 92, 255, 0.5)";
      ctx.lineWidth = active ? 2 : 1;
      ctx.strokeRect(x1 + 0.5, 2.5, Math.max(1, x2 - x1 - 1), HEIGHT - 5);

      const handleColor = active ? "rgba(46, 230, 255, 0.95)" : "rgba(124, 92, 255, 0.7)";
      drawHandle(x1, handleColor);
      drawHandle(x2, handleColor);

      // label
      const label = w.text.length > 14 ? w.text.slice(0, 13) + "…" : w.text;
      ctx.fillStyle = "rgba(232, 235, 242, 0.92)";
      ctx.font = "11px -apple-system, Segoe UI, sans-serif";
      ctx.textBaseline = "top";
      const tw = ctx.measureText(label).width;
      if (tw < x2 - x1 - 4) {
        ctx.fillText(label, x1 + (x2 - x1) / 2 - tw / 2, 5);
      }
    });

    // playhead
    if (playhead >= segStart && playhead <= segEnd) {
      const px = xAtTime(playhead);
      ctx.strokeStyle = "#ff5c7a";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, HEIGHT);
      ctx.stroke();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [words, activeIndex, waveform, waveformStep, waveformOffset, playhead, width]);

  const hitTest = (x: number): { idx: number; mode: "move" | "start" | "end" } | null => {
    for (let i = 0; i < words.length; i++) {
      const x1 = xAtTime(words[i].start);
      const x2 = xAtTime(words[i].end);
      if (x < x1 - HANDLE_HIT_PX || x > x2 + HANDLE_HIT_PX) continue;
      if (x <= x1 + HANDLE_HIT_PX) return { idx: i, mode: "start" };
      if (x >= x2 - HANDLE_HIT_PX) return { idx: i, mode: "end" };
      return { idx: i, mode: "move" };
    }
    return null;
  };

  const cursorFor = (mode: "move" | "start" | "end" | null) =>
    mode === "start" || mode === "end" ? "ew-resize" : mode === "move" ? "grab" : "pointer";

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const t = timeAtX(x);
    const hit = hitTest(x);

    if (hit) {
      onSelectWord(hit.idx);
      const v = videoRef.current;
      if (v) v.currentTime = Math.max(0, words[hit.idx].start + 0.001);
      dragRef.current = {
        mode: hit.mode,
        idx: hit.idx,
        startPointerTime: t,
        origStart: words[hit.idx].start,
        origEnd: words[hit.idx].end,
        moved: false,
      };
      e.currentTarget.style.cursor = hit.mode === "move" ? "grabbing" : "ew-resize";
      e.currentTarget.setPointerCapture(e.pointerId);
    } else {
      // click on empty waveform: just seek
      const v = videoRef.current;
      if (v) v.currentTime = Math.max(0, t);
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;

    if (!drag) {
      // Not dragging — just update the cursor so a resize/grab affordance
      // shows up before the user commits to clicking.
      e.currentTarget.style.cursor = cursorFor(hitTest(x)?.mode ?? null);
      return;
    }

    const t = timeAtX(x);
    const delta = t - drag.startPointerTime;
    if (Math.abs(delta) > 0.005) drag.moved = true;

    const prevWordEnd = drag.idx > 0 ? words[drag.idx - 1].end : 0;
    const nextWordStart = drag.idx < words.length - 1 ? words[drag.idx + 1].start : Infinity;

    if (drag.mode === "start") {
      const newStart = Math.max(0, Math.min(t, drag.origEnd - MIN_WORD_DUR));
      setWordTime(segId, drag.idx, "start", newStart);
    } else if (drag.mode === "end") {
      const newEnd = Math.max(drag.origStart + MIN_WORD_DUR, t);
      setWordTime(segId, drag.idx, "end", newEnd);
    } else {
      const dur = drag.origEnd - drag.origStart;
      let newStart = drag.origStart + delta;
      newStart = Math.max(0, Math.min(newStart, nextWordStart - dur));
      if (drag.idx > 0) newStart = Math.max(newStart, prevWordEnd);
      const newEnd = newStart + dur;
      setWordTime(segId, drag.idx, "start", newStart);
      setWordTime(segId, drag.idx, "end", newEnd);
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag && !drag.moved) {
      // plain click on a word: seek to its start
      const v = videoRef.current;
      if (v) v.currentTime = Math.max(0, words[drag.idx].start + 0.001);
    }
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* not captured — fine */
    }
    const rect = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.cursor = cursorFor(hitTest(e.clientX - rect.left)?.mode ?? null);
  };

  if (!hasWords) return null;

  return (
    <div className="waveform-wrap" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        className="waveform-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />
    </div>
  );
}
