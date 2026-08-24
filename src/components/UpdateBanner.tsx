import { useApp } from "../store";

// Rendered once, globally (mounted in App.tsx) so an update found while
// you're mid-edit in the Editor screen still surfaces, not just from Library.
// Silent on "checking"/"idle"/"none" — those only matter to the manual
// "Check for updates" button in the Library header, which reads updateStatus
// itself to show its own inline feedback instead of duplicating this banner.
export default function UpdateBanner() {
  const status = useApp((s) => s.updateStatus);
  const info = useApp((s) => s.updateInfo);
  const progress = useApp((s) => s.updateProgress);
  const error = useApp((s) => s.updateError);
  const installUpdate = useApp((s) => s.installUpdate);
  const dismiss = useApp((s) => s.dismissUpdateBanner);

  if (status === "available" && info) {
    return (
      <div className="toast toast-update" role="status">
        <span>
          ⬆ ClipCaption {info.version} is available.
          {info.body ? ` ${info.body}` : ""}
        </span>
        <button className="btn btn-primary btn-small" onClick={() => void installUpdate()}>
          Update &amp; restart
        </button>
        <button className="toast-close" onClick={dismiss} title="Not now">
          ✕
        </button>
      </div>
    );
  }

  if (status === "downloading") {
    return (
      <div className="toast toast-update" role="status">
        <span>Downloading update{progress != null ? ` — ${progress}%` : "…"}</span>
      </div>
    );
  }

  if (status === "error" && error) {
    return (
      <div className="toast toast-error" role="alert">
        <span>⚠ Update check failed: {error}</span>
        <button className="toast-close" onClick={dismiss} title="Dismiss">
          ✕
        </button>
      </div>
    );
  }

  return null;
}
