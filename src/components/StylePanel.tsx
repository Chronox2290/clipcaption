import { useApp } from "../store";
import { STYLE_PRESETS } from "../lib/styles";
import type { AnimationKind } from "../types";

export default function StylePanel() {
  const style = useApp((s) => s.style);
  const setStyle = useApp((s) => s.setStyle);

  const set = (patch: Partial<typeof style>) => setStyle({ ...style, ...patch });

  return (
    <div className="style-panel">
      <h4>Preset</h4>
      <div className="preset-grid">
        {STYLE_PRESETS.map((p) => (
          <button
            key={p.id}
            className={`preset-card ${style.id === p.id ? "sel" : ""}`}
            onClick={() => setStyle({ ...p })}
          >
            <span
              className="preset-sample"
              style={{
                fontFamily: `"${p.font}", sans-serif`,
                color: p.fill,
                background: p.boxColor ? "rgba(0,0,0,0.7)" : undefined,
                WebkitTextStroke: p.outlineWidthPct > 0 ? `1px ${p.outline}` : undefined,
                textTransform: p.uppercase ? "uppercase" : "none",
              }}
            >
              Nice <em style={{ color: p.activeFill, fontStyle: "normal" }}>shot!</em>
            </span>
            <span className="preset-name">{p.name}</span>
          </button>
        ))}
      </div>

      <h4>Tweak</h4>
      <div className="field">
        <label>Size</label>
        <input
          type="range"
          min={2.5}
          max={9}
          step={0.1}
          value={style.fontSizePct}
          onChange={(e) => set({ fontSizePct: Number(e.target.value) })}
        />
      </div>
      <div className="field">
        <label>Position</label>
        <input
          type="range"
          min={8}
          max={92}
          step={1}
          value={style.positionPct}
          onChange={(e) => set({ positionPct: Number(e.target.value) })}
        />
      </div>
      <div className="field">
        <label>Words / page</label>
        <input
          type="range"
          min={1}
          max={8}
          step={1}
          value={style.maxWordsPerPage}
          onChange={(e) => set({ maxWordsPerPage: Number(e.target.value) })}
        />
        <span className="field-val">{style.maxWordsPerPage}</span>
      </div>
      <div className="field">
        <label>Animation</label>
        <select
          value={style.animation}
          onChange={(e) => set({ animation: e.target.value as AnimationKind })}
        >
          <option value="pop">Pop</option>
          <option value="bounce">Bounce</option>
          <option value="karaoke">Karaoke</option>
          <option value="none">None</option>
        </select>
      </div>
      <div className="field colors">
        <label>Colors</label>
        <span className="color-item">
          <input type="color" value={style.fill} onChange={(e) => set({ fill: e.target.value })} />
          text
        </span>
        <span className="color-item">
          <input
            type="color"
            value={style.activeFill}
            onChange={(e) => set({ activeFill: e.target.value })}
          />
          active
        </span>
        <span className="color-item">
          <input
            type="color"
            value={style.outline}
            onChange={(e) => set({ outline: e.target.value })}
          />
          outline
        </span>
      </div>
      <div className="field">
        <label>Uppercase</label>
        <input
          type="checkbox"
          checked={style.uppercase}
          onChange={(e) => set({ uppercase: e.target.checked })}
        />
      </div>
      <div className="field">
        <label title="Adds a relevant emoji after the key word in each caption line">
          Emojis 🔥
        </label>
        <input
          type="checkbox"
          checked={style.emojis}
          onChange={(e) => set({ emojis: e.target.checked })}
        />
      </div>
      <div className="field colors">
        <label>Speakers</label>
        <span className="color-item">
          <input
            type="color"
            value={style.speakerColors[0]}
            onChange={(e) => set({ speakerColors: [e.target.value, style.speakerColors[1]] })}
          />
          A
        </span>
        <span className="color-item">
          <input
            type="color"
            value={style.speakerColors[1]}
            onChange={(e) => set({ speakerColors: [style.speakerColors[0], e.target.value] })}
          />
          B
        </span>
      </div>
    </div>
  );
}
