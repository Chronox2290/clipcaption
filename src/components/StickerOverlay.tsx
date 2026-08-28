import { useRef, useState } from "react";
import { useApp } from "../store";

interface Props {
  /** Rendered size of the visible video area in px - same "stage" the
   * caption overlay and safe-zone guides are positioned against, so a
   * sticker's xPct/yPct lands in the same place preview and export agree
   * on (see lib/stickerAss.ts). */
  stageW: number;
  stageH: number;
  time: number;
}

const RAINBOW = ["#FF3E9E", "#2EE6D6", "#FFD93D"];

/** Live-preview render of the decorative sticker layer (see Sticker in
 * types.ts) - CSS approximation of what lib/stickerAss.ts burns into the
 * export via ASS, same "preview should look like the burn-in" goal
 * CaptionOverlay already follows for dialogue captions. Click to select
 * (shows a small edit toolbar), drag to reposition, delete from the
 * toolbar. Free placement + rotation is new UI this project didn't have
 * before - there's no free-placement text feature to build on top of, so
 * this is built from scratch rather than adapted from an existing one. */
export default function StickerOverlay({ stageW, stageH, time }: Props) {
  const stickers = useApp((s) => s.stickers);
  const selectedStickerId = useApp((s) => s.selectedStickerId);
  const setSelectedStickerId = useApp((s) => s.setSelectedStickerId);
  const updateSticker = useApp((s) => s.updateSticker);
  const removeSticker = useApp((s) => s.removeSticker);

  const dragRef = useRef<{ id: string; movedPx: number } | null>(null);
  const [, forceRerender] = useState(0);

  if (stageW <= 0 || stageH <= 0) return null;

  const startDrag = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    setSelectedStickerId(id);
    dragRef.current = { id, movedPx: 0 };
    const stageEl = (e.currentTarget as HTMLElement).closest(".stage") as HTMLElement | null;
    const rect = stageEl?.getBoundingClientRect();
    if (!rect) return;

    const onMove = (ev: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      drag.movedPx += Math.abs(ev.movementX) + Math.abs(ev.movementY);
      const xPct = Math.min(100, Math.max(0, ((ev.clientX - rect.left) / rect.width) * 100));
      const yPct = Math.min(100, Math.max(0, ((ev.clientY - rect.top) / rect.height) * 100));
      updateSticker(drag.id, { xPct, yPct }, "move");
      forceRerender((n) => n + 1);
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const active = stickers.filter((s) => time >= s.startSec && time <= s.endSec);

  return (
    <>
      {active.map((s) => {
        const fontSize = Math.max(10, (s.fontSizePct / 100) * stageH);
        const selected = s.id === selectedStickerId;
        return (
          <div
            key={s.id}
            onMouseDown={(e) => startDrag(e, s.id)}
            onClick={(e) => e.stopPropagation()}
            style={{
              position: "absolute",
              left: `${s.xPct}%`,
              top: `${s.yPct}%`,
              transform: `translate(-50%, -50%) rotate(${s.rotationDeg}deg)`,
              cursor: "grab",
              pointerEvents: "auto",
              userSelect: "none",
              padding: `${fontSize * 0.35}px ${fontSize * 0.55}px`,
              background: "#FFF8EC",
              borderRadius: fontSize * 0.35,
              boxShadow: `${fontSize * 0.12}px ${fontSize * 0.16}px 0 rgba(0,0,0,0.35)`,
              outline: selected ? "2px dashed #6b6bff" : "none",
              outlineOffset: 3,
              whiteSpace: "nowrap",
            }}
          >
            <span
              style={{
                fontFamily: '"Comic Sans MS", "Comic Sans", cursive, sans-serif',
                fontWeight: 700,
                fontSize,
                WebkitTextStroke: `${Math.max(1, fontSize * 0.05)}px #000`,
              }}
            >
              {[...s.text].map((ch, i) => (
                <span key={i} style={{ color: RAINBOW[i % RAINBOW.length] }}>
                  {ch}
                </span>
              ))}
            </span>

            {selected && (
              <div
                onMouseDown={(e) => e.stopPropagation()}
                style={{
                  position: "absolute",
                  top: "100%",
                  left: "50%",
                  transform: `translateX(-50%) rotate(${-s.rotationDeg}deg)`,
                  marginTop: 8,
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                  background: "rgba(20,20,24,0.92)",
                  borderRadius: 8,
                  padding: 8,
                  minWidth: 160,
                }}
              >
                <input
                  type="text"
                  value={s.text}
                  onChange={(e) => updateSticker(s.id, { text: e.target.value })}
                  style={{ width: "100%", boxSizing: "border-box" }}
                />
                <label className="muted small" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  Rotate
                  <input
                    type="range"
                    min={-45}
                    max={45}
                    value={s.rotationDeg}
                    onChange={(e) => updateSticker(s.id, { rotationDeg: Number(e.target.value) }, "rotate")}
                    style={{ flex: 1 }}
                  />
                </label>
                <label className="muted small" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  Size
                  <input
                    type="range"
                    min={4}
                    max={20}
                    value={s.fontSizePct}
                    onChange={(e) => updateSticker(s.id, { fontSizePct: Number(e.target.value) }, "size")}
                    style={{ flex: 1 }}
                  />
                </label>
                <div style={{ display: "flex", gap: 6 }}>
                  <button
                    type="button"
                    className="btn btn-ghost btn-small"
                    onClick={() => setSelectedStickerId(null)}
                  >
                    Done
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-small"
                    onClick={() => removeSticker(s.id)}
                  >
                    ✕ Delete
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
