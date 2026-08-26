import { useEffect } from "react";
import { useApp } from "./store";
import { isTauri } from "./lib/tauri";
import Library from "./screens/Library";
import Editor from "./screens/Editor";
import BatchScreen from "./screens/BatchScreen";
import UpdateBanner from "./components/UpdateBanner";

export default function App() {
  const screen = useApp((s) => s.screen);
  const error = useApp((s) => s.error);
  const clearError = useApp((s) => s.clearError);
  const init = useApp((s) => s.init);
  const openVideo = useApp((s) => s.openVideo);
  const theme = useApp((s) => s.theme);

  useEffect(() => {
    void init();
  }, [init]);

  // "precision" is the default and needs no attribute — its tokens live in
  // plain :root, so the alternate themes' [data-theme="..."] blocks only
  // need to exist for "warm" and "gamer".
  useEffect(() => {
    if (theme === "precision") {
      delete document.documentElement.dataset.theme;
    } else {
      document.documentElement.dataset.theme = theme;
    }
  }, [theme]);

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
      {screen === "library" && <Library />}
      {screen === "editor" && <Editor />}
      {screen === "batch" && <BatchScreen />}
      <UpdateBanner />
      {error && (
        <div className="toast toast-error" role="alert">
          <span>⚠ {error}</span>
          <button className="toast-close" onClick={clearError} title="Dismiss">
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
