import { useRef, useState } from "react";
import { useApp } from "../store";
import { STICKER_STYLES, getStickerStyle } from "../lib/stickerStyles";

interface Props {
  /** Rendered size of the visible video area in px - same "stage" the
   * caption overlay and safe-zone guides are positioned against, so a
   * sticker's xPct/yPct lands in the same place preview and export agree
   * on (see lib/stickerAss.ts). */
  stageW: number;
  stageH: number;
  time: number;
}

/** Live-preview render of the decorative sticker layer (see Sticker in
 * types.ts) - CSS approximation of what lib/stickerAss.ts burns into the
 * export via ASS, same "preview should look like the burn-in" goal
 * CaptionOverlay already follows for dialogue captions. Click to select
 * (shows a small edit toolbar with a style picker), drag to reposition,
 * delete from the toolbar. Free placement + rotation is new UI this
 * project didn't have before - there's no free-placement text feature to
 * build on top of, so this is built from scratch rather than adapted from
 * an existing one. */
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
        const style = getStickerStyle(s.styleId);
        const fontSize = Math.max(10, (s.fontSizePct / 100) * stageH);
        const selected = s.id === selectedStickerId;
        const displayText = style.uppercase ? s.text.toUpperCase() : s.text;
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
              padding: style.boxColor ? `${fontSize * 0.35}px ${fontSize * 0.55}px` : 0,
              background: style.boxColor ?? "transparent",
              borderRadius: style.boxColor ? fontSize * 0.35 : 0,
              boxShadow: style.shadow
                ? `${fontSize * 0.12}px ${fontSize * 0.16}px 0 rgba(0,0,0,0.35)`
                : "none",
              outline: selected ? "2px dashed #6b6bff" : "none",
              outlineOffset: 3,
              whiteSpace: "nowrap",
            }}
          >
            <span
              style={{
                fontFamily: `"${style.font}", cursive, sans-serif`,
                fontWeight: 700,
                fontSize,
                WebkitTextStroke: style.outlineColor
                  ? `${Math.max(1, fontSize * 0.05)}px ${style.outlineColor}`
                  : undefined,
                filter: style.glow ? `blur(0.4px) drop-shadow(0 0 ${fontSize * 0.25}px currentColor)` : undefined,
                textShadow:
                  style.shadow && !style.boxColor ? `${fontSize * 0.08}px ${fontSize * 0.1}px 0 rgba(0,0,0,0.5)` : undefined,
              }}
            >
              {[...displayText].map((ch, i) => (
                <span key={i} style={{ color: style.palette[i % style.palette.length] }}>
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
                  minWidth: 220,
                }}
              >
                <input
                  type="text"
                  value={s.text}
                  onChange={(e) => updateSticker(s.id, { text: e.target.value })}
                  style={{ width: "100%", boxSizing: "border-box" }}
                />
                <div
                  className="sticker-style-picker"
                  style={{
                    display: "flex",
                    gap: 4,
                    overflowX: "auto",
                    maxWidth: 220,
                    padding: "2px 0",
                  }}
                >
                  {STICKER_STYLES.map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      title={opt.name}
                      onClick={() => updateSticker(s.id, { styleId: opt.id })}
                      style={{
                        flex: "0 0 auto",
                        width: 28,
                        height: 22,
                        borderRadius: 5,
                        border: opt.id === style.id ? "2px solid #6b6bff" : "1px solid rgba(255,255,255,0.25)",
                        background: opt.boxColor ?? "#1a1a1f",
                        color: opt.palette[0],
                        fontFamily: `"${opt.font}", sans-serif`,
                        fontSize: 11,
                        fontWeight: 700,
                        cursor: "pointer",
                        padding: 0,
                      }}
                    >
                      A
                    </button>
                  ))}
                </div>
                <span className="muted small">{style.name}</span>
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
