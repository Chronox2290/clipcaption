/** Per-speaker colour coding for the timeline lanes.
 *
 * The colours themselves come from the active caption style's
 * `speakerColors` — the exact colours that speaker's captions are drawn in on
 * the video and in the transcript panel — so a lane in the timeline, a dot in
 * the transcript and the burned-in caption all read as the same person. The
 * labels match the transcript's "Speaker A/B/C" for the same reason.
 *
 * Speaker indices come from diarize.rs's voice-fingerprint clustering, which
 * is stable across a whole video (the same person keeps their index if they
 * speak again an hour later), so these assignments are stable too. A null
 * speaker means diarization didn't run, or that segment's audio didn't
 * overlap any detected speaker — deliberately grey rather than borrowing a
 * real speaker's colour. */
export interface SpeakerColor {
  /** The speaker's own colour: lane chips, handles, selected outlines. */
  solid: string;
  /** Translucent fill for a word block. */
  soft: string;
  /** Border for a word block. */
  line: string;
}

const UNKNOWN = "#8b93a7";

/** #rgb / #rrggbb -> "rgba(r, g, b, a)". Falls back to the input untouched if
 * it isn't a hex colour, so a style using some other CSS colour notation
 * degrades to a solid block rather than an invalid fillStyle (which canvas
 * silently ignores, drawing the previous colour instead). */
function withAlpha(hex: string, alpha: number): string {
  let h = hex.trim().replace("#", "");
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (h.length !== 6 || !/^[0-9a-f]{6}$/i.test(h)) return hex;
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export function speakerColor(speaker: number | null, palette: string[]): SpeakerColor {
  const solid = speaker == null || palette.length === 0
    ? UNKNOWN
    : palette[speaker % palette.length];
  return { solid, soft: withAlpha(solid, 0.2), line: withAlpha(solid, 0.7) };
}

/** The name to show for a speaker.
 *
 * Prefers the name the user gave that voice (resolved by voice-fingerprint
 * matching - see resolveSpeakerNames in lib/captions.ts) and falls back to
 * "Speaker A/B/C", matching what the transcript panel shows. Without the
 * names map the timeline lanes would keep saying "Speaker B" for someone the
 * captions already call Luke. */
export function speakerLabel(
  speaker: number | null,
  names?: Record<number, string>
): string {
  if (speaker == null) return "Unknown";
  const named = names?.[speaker];
  if (named) return named;
  return `Speaker ${String.fromCharCode(65 + (speaker % 26))}`;
}

/** The distinct speakers present, in a stable display order: real speakers
 * ascending, then the unknown lane last if anything needs it. Callers use the
 * position in this array as the lane index. */
export function speakerLanes(
  speakers: (number | null)[],
  /** Show at least this many speaker lanes even when nobody has been
   * attributed to them yet. You can't drag a line onto a track that isn't
   * drawn, so when the user has said there are three people, three lanes
   * exist - including the empty one they're about to move someone into. */
  minLanes = 0
): (number | null)[] {
  const real = new Set(speakers.filter((s): s is number => s != null));
  for (let i = 0; i < minLanes; i++) real.add(i);
  const lanes: (number | null)[] = [...real].sort((a, b) => a - b);
  if (speakers.some((s) => s == null)) lanes.push(null);
  return lanes.length ? lanes : [null];
}
