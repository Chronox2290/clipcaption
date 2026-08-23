import { useApp } from "../store";

const ENCODERS: { id: string; label: string }[] = [
  { id: "auto", label: "Auto (GPU if available)" },
  { id: "nvenc", label: "NVIDIA NVENC" },
  { id: "amf", label: "AMD AMF" },
  { id: "qsv", label: "Intel QuickSync" },
  { id: "x264", label: "CPU (x264, best compression)" },
];

/** Frame rate + encoder options, shared by the Export tab and Batch screen. */
export default function EncodingOptions() {
  const { fpsOverride, setFpsOverride, encoder, setEncoder, availableEncoders } = useApp();

  const gpuFound = availableEncoders.some((e) => e !== "x264");

  return (
    <div className="enc-options">
      <div className="field">
        <label>Frame rate</label>
        <div className="seg-toggle">
          {[
            { v: null, label: "Auto" },
            { v: 30, label: "30" },
            { v: 60, label: "60" },
          ].map((o) => (
            <button
              key={String(o.v)}
              className={`seg-toggle-btn ${fpsOverride === o.v ? "sel" : ""}`}
              onClick={() => setFpsOverride(o.v)}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <label>Encoder</label>
        <select value={encoder} onChange={(e) => setEncoder(e.target.value)}>
          {ENCODERS.map((e) => {
            const detected = e.id === "auto" || availableEncoders.includes(e.id);
            return (
              <option key={e.id} value={e.id} disabled={!detected}>
                {e.label}
                {!detected ? " — not detected" : ""}
              </option>
            );
          })}
        </select>
      </div>
      <p className="muted small enc-note">
        {gpuFound
          ? "GPU encoding detected — much faster exports. CPU x264 still squeezes the most quality into tight size targets (Discord presets)."
          : "No GPU encoder detected — using CPU x264. (Auto will pick your GPU when the app runs on a machine that has one.)"}
        {" "}Auto frame rate keeps the source fps (or the preset's cap).
      </p>
    </div>
  );
}
