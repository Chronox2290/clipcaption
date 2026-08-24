import { useCallback, useEffect, useRef, useState } from "react";

interface Options {
  /** Remembered per machine under this localStorage key. */
  storageKey: string;
  initial: number;
  min: number;
  /** Upper bound. A function so it can track the window as it resizes -
   * a remembered size from a 3440-wide monitor must not strand the panel
   * off-screen on a laptop. */
  max: () => number;
  /** "x" grows the value as the pointer moves right, "y" as it moves down.
   * Panels anchored to the right or bottom edge invert this. */
  axis: "x" | "y";
  invert?: boolean;
}

/**
 * A draggable pane divider whose size persists.
 *
 * Sizes are clamped on read as well as on drag: a value saved on a large
 * monitor would otherwise push a pane off-screen entirely on a smaller one,
 * with no visible handle left to drag it back.
 */
export function useSplitter({ storageKey, initial, min, max, axis, invert }: Options) {
  const [size, setSize] = useState(() => {
    const saved = Number(localStorage.getItem(storageKey));
    return Number.isFinite(saved) && saved > 0 ? saved : initial;
  });
  const [dragging, setDragging] = useState(false);
  const originRef = useRef({ pointer: 0, size: 0 });

  const clamp = useCallback((v: number) => Math.max(min, Math.min(max(), v)), [min, max]);

  // Re-clamp when the window changes, so a shrunk window can't leave a pane
  // larger than the space available.
  useEffect(() => {
    const onResize = () => setSize((s) => clamp(s));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [clamp]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    originRef.current = { pointer: axis === "x" ? e.clientX : e.clientY, size };
    setDragging(true);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    const now = axis === "x" ? e.clientX : e.clientY;
    const delta = (now - originRef.current.pointer) * (invert ? -1 : 1);
    setSize(clamp(originRef.current.size + delta));
  };

  const end = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    setDragging(false);
    e.currentTarget.releasePointerCapture(e.pointerId);
    localStorage.setItem(storageKey, String(Math.round(size)));
  };

  /** Snap between a compact and a roomy size - the "I just want to see the
   * video for a second" gesture without hunting for a drag handle. */
  const onDoubleClick = () => {
    const next = size > (min + max()) / 2 ? min : clamp(max() * 0.66);
    setSize(next);
    localStorage.setItem(storageKey, String(Math.round(next)));
  };

  return {
    size,
    dragging,
    handleProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp: end,
      onPointerCancel: end,
      onDoubleClick,
      role: "separator" as const,
      tabIndex: 0,
      "aria-orientation": (axis === "x" ? "vertical" : "horizontal") as "vertical" | "horizontal",
    },
  };
}
