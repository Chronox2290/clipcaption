import { useEffect } from "react";
import { useApp } from "./store";
import { isTauri } from "./lib/tauri";
import Library from "./screens/Library";
import Editor from "./screens/Editor";

export default function App() {
  const screen = useApp((s) => s.screen);
  const error = useApp((s) => s.error);
  const clearError = useApp((s) => s.clearError);
  const init = useApp((s) => s.init);
  const openVideo = useApp((s) => s.openVideo);

  useEffect(() => {
    void init();
  }, [init]);

  // Native file drag & drop (gives us real OS paths)
  useEffect(() => {
    if (!isTauri) return;
    let un: (() => void) | undefined;
    void (async () => {
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      un = await getCurrentWebview().onDragDropEvent((e) => {
        if (e.payload.type === "drop" && e.payload.paths.length > 0) {
          void openVideo(e.payload.paths[0]);
        }
      });
    })();
    return () => un?.();
  }, [openVideo]);

  return (
    <div className="app">
      {screen === "library" ? <Library /> : <Editor />}
      {error && (
        <div className="toast toast-error" onClick={clearError}>
          <span>⚠ {error}</span>
          <button className="toast-close">✕</button>
        </div>
      )}
    </div>
  );
}
