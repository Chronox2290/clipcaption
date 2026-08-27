// Thin wrapper around the Tauri APIs so the UI can also load in a plain
// browser (npm run dev without Tauri) for quick UI work.

import type { JobProgressPayload } from "../types";

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri) throw new Error(`Tauri not available (cmd: ${cmd}) — run via 'npm run tauri dev'`);
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

export async function fileSrc(path: string): Promise<string> {
  if (!isTauri) return path;
  const { convertFileSrc } = await import("@tauri-apps/api/core");
  return convertFileSrc(path);
}

export async function listenJobProgress(
  cb: (p: JobProgressPayload) => void
): Promise<() => void> {
  if (!isTauri) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  const un = await listen<JobProgressPayload>("job-progress", (e) => cb(e.payload));
  return un;
}

export async function pickVideoFile(): Promise<string | null> {
  if (!isTauri) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const res = await open({
    multiple: false,
    filters: [
      { name: "Video", extensions: ["mp4", "mkv", "mov", "webm", "avi", "flv", "ts"] },
    ],
  });
  return typeof res === "string" ? res : null;
}

export async function pickVideoFiles(): Promise<string[]> {
  if (!isTauri) return [];
  const { open } = await import("@tauri-apps/plugin-dialog");
  const res = await open({
    multiple: true,
    filters: [
      { name: "Video", extensions: ["mp4", "mkv", "mov", "webm", "avi", "flv", "ts", "m4v"] },
    ],
  });
  if (Array.isArray(res)) return res;
  return typeof res === "string" ? [res] : [];
}

export async function pickDirectory(): Promise<string | null> {
  if (!isTauri) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const res = await open({ directory: true, multiple: false });
  return typeof res === "string" ? res : null;
}

export async function pickSavePath(defaultName: string): Promise<string | null> {
  if (!isTauri) return null;
  const { save } = await import("@tauri-apps/plugin-dialog");
  const res = await save({
    defaultPath: defaultName,
    filters: [{ name: "MP4 video", extensions: ["mp4"] }],
  });
  return res ?? null;
}

export async function pickProjectSavePath(defaultName: string): Promise<string | null> {
  if (!isTauri) return null;
  const { save } = await import("@tauri-apps/plugin-dialog");
  const res = await save({
    defaultPath: defaultName,
    filters: [{ name: "ClipCaption project", extensions: ["ccproj"] }],
  });
  return res ?? null;
}

export async function pickProjectOpenPath(): Promise<string | null> {
  if (!isTauri) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const res = await open({
    multiple: false,
    filters: [{ name: "ClipCaption project", extensions: ["ccproj"] }],
  });
  return typeof res === "string" ? res : null;
}

/** Same picker, but multi-select - the montage builder pulls clips from
 * several saved projects at once, so adding them one dialog at a time
 * would be needless friction. */
export async function pickProjectOpenPaths(): Promise<string[]> {
  if (!isTauri) return [];
  const { open } = await import("@tauri-apps/plugin-dialog");
  const res = await open({
    multiple: true,
    filters: [{ name: "ClipCaption project", extensions: ["ccproj"] }],
  });
  if (Array.isArray(res)) return res;
  return typeof res === "string" ? [res] : [];
}

/** A caption style saved to its own plain file - the "shareable preset" the
 * brief asked for: send a .ccstyle to a friend, they import it, no walled
 * marketplace involved. Same shape as the project pickers above. */
export async function pickStyleSavePath(defaultName: string): Promise<string | null> {
  if (!isTauri) return null;
  const { save } = await import("@tauri-apps/plugin-dialog");
  const res = await save({
    defaultPath: defaultName,
    filters: [{ name: "ClipCaption style", extensions: ["ccstyle"] }],
  });
  return res ?? null;
}

export async function pickStyleOpenPath(): Promise<string | null> {
  if (!isTauri) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const res = await open({
    multiple: false,
    filters: [{ name: "ClipCaption style", extensions: ["ccstyle"] }],
  });
  return typeof res === "string" ? res : null;
}

export async function pickThumbnailSavePath(defaultName: string): Promise<string | null> {
  if (!isTauri) return null;
  const { save } = await import("@tauri-apps/plugin-dialog");
  const res = await save({
    defaultPath: defaultName,
    filters: [{ name: "JPEG image", extensions: ["jpg", "jpeg"] }],
  });
  return res ?? null;
}
