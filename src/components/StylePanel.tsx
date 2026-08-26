import { useApp, type AppTheme } from "../store";
import { STYLE_PRESETS } from "../lib/styles";
import type { AnimationKind } from "../types";

const APP_THEMES: { id: AppTheme; name: string; blurb: string; a: string; b: string }[] = [
  { id: "precision", name: "Precision", blurb: "Dense, cool, restrained — Resolve/Premiere-adjacent.", a: "#7c5cff", b: "#2ee6ff" },
  { id: "warm", name: "Creator warm", blurb: "Roomier, warmer, fully rounded — Descript/CapCut-adjacent.", a: "#9b7bff", b: "#3ce6c2" },
  { id: "gamer", name: "High-energy", blurb: "Gradient glow, sharper actions — Discord/RGB-gear-adjacent.", a: "#8b5cf6", b: "#22d3ee" },
];

export default function StylePanel() {
  const style = useApp((s) => s.style);
  const setStyle = useApp((s) => s.setStyle);
  const theme = useApp((s) => s.theme);
  const setTheme = useApp((s) => s.setTheme);

  const set = (patch: Partial<typeof style>) => setStyle({ ...style, ...patch });

  return (
    <div className="style-panel">
      {/* App theme changes how ClipCaption ITSELF looks - the editor chrome,
          buttons, panels. Deliberately separate from the caption preset
          below, which is how captions look in the exported VIDEO - the two
          answer different questions and merging them into one picker would
          make people hunt for the wrong one. */}
      <h4>App theme</h4>
      <div className="theme-grid">
        {APP_THEMES.map((t) => (
          <button
            key={t.id}
            className={`theme-card ${theme === t.id ? "sel" : ""}`}
            onClick={() => setTheme(t.id)}
            title={t.blurb}
          >
            <span className="theme-swatch" style={{ background: `linear-gradient(135deg, ${t.a}, ${t.b})` }} />
            <span className="theme-card-name">{t.name}</span>
          </button>
        ))}
      </div>

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
                fontWeight: p.fontWeight,
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
          <option value="glow">Glow</option>
          <option value="shake">Shake</option>
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
      <div className="field">
        <label title="Captions follow the voice: they slide toward where the speaker is in the stereo field, shrink when someone is far away and quiet, grow when they're close and loud, and shake when someone screams. Needs a transcript made on v0.2.4 or later.">
          Living captions 🎭
        </label>
        <input
          type="checkbox"
          checked={style.dynamic ?? false}
          onChange={(e) => set({ dynamic: e.target.checked })}
        />
      </div>
      {(style.dynamic ?? false) && (
        <div className="field">
          <label title="How far the reaction goes. Lower keeps the same behaviour, just subtler.">
            Reaction
          </label>
          <input
            type="range"
            min={10}
            max={100}
            step={5}
            value={style.dynamicAmountPct ?? 70}
            onChange={(e) => set({ dynamicAmountPct: Number(e.target.value) })}
          />
          <span className="muted small">{style.dynamicAmountPct ?? 70}%</span>
        </div>
      )}
      <div className="field">
        <label title="Shows a named speaker's name above/beside their captions — only for speakers you've named in the Transcript tab">
          Show speaker names
        </label>
        <input
          type="checkbox"
          checked={style.showSpeakerNames}
          onChange={(e) => set({ showSpeakerNames: e.target.checked })}
        />
      </div>
      <div className="field colors">
        <label>Speakers</label>
        {style.speakerColors.map((c, i) => (
          <span className="color-item" key={i}>
            <input
              type="color"
              value={c}
              onChange={(e) =>
                set({
                  speakerColors: style.speakerColors.map((sc, si) =>
                    si === i ? e.target.value : sc
                  ),
                })
              }
            />
            {String.fromCharCode(65 + (i % 26))}
          </span>
        ))}
      </div>
    </div>
  );
}
