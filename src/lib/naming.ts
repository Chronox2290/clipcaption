/** Filesystem-safe helpers for user-supplied clip/export names. */

// Windows forbids these in filenames; also strip control chars just in case.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[<>:"/\\|?*\x00-\x1f]/g;
const RESERVED = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

/** Turns a free-typed clip name into a safe Windows filename stem (no extension). */
export function sanitizeFilename(name: string, fallback: string): string {
  let s = name.trim().replace(UNSAFE, "").replace(/\s+/g, " ").trim();
  s = s.replace(/\.+$/, ""); // trailing dots aren't allowed either
  if (!s || RESERVED.has(s.toUpperCase())) return fallback;
  return s.slice(0, 120); // keep well under Windows' 255-char path component limit
}
