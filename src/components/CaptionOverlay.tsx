import { useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import type { CaptionStyle, Segment } from "../types";
import { paginate, pagesAt, layoutRows, activeWordIndex, applyCensor, captionDynamics } from "../lib/captions";
import { addEmojis } from "../lib/emojis";
import { containerCss, speakerNameCss, wordCss } from "../lib/styles";

interface Props {
  videoRef: RefObject<HTMLVideoElement | null>;
  segments: Segment[];
  style: CaptionStyle;
  censor: boolean;
  /** Rendered height of the visible video area in px */
  stageHeight: number;
  /** Resolved speaker names (see lib/captions.ts's resolveSpeakerNames) —
   * only shown when style.showSpeakerNames is on and this page's speaker
   * has an entry here (unnamed/unmatched speakers get no label). */
  speakerNames: Record<number, string>;
}

export default function CaptionOverlay({
  videoRef,
  segments,
  style,
  censor,
  stageHeight,
  speakerNames,
}: Props) {
  const [time, setTime] = useState(0);
  const raf = useRef(0);

  useEffect(() => {
    const tick = () => {
      const v = videoRef.current;
      if (v) setTime(v.currentTime);
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [videoRef]);

  const pages = useMemo(() => {
    let segs = censor ? applyCensor(segments) : segments;
    if (style.emojis) segs = addEmojis(segs);
    return layoutRows(paginate(segs, style.maxWordsPerPage));
  }, [segments, style.maxWordsPerPage, censor, style.emojis]);

  const live = pagesAt(pages, time);
  if (!live.length || stageHeight <= 0) return null;

  return (
    <>
      {live.map((page) => {
        const active = activeWordIndex(page, time);
        const dyn = captionDynamics(page, style);
        const speakerName =
          style.showSpeakerNames && page.speaker != null ? speakerNames[page.speaker] : undefined;
        return (
          <div
            // Keyed by page so the shake animation restarts on each new
            // shouted line instead of running once and sitting still for the
            // rest of them.
            key={`${page.start}-${page.speaker ?? "x"}`}
            className={dyn.shake ? "caption-shake" : undefined}
            style={containerCss(style, stageHeight, dyn, page.row ?? 0)}
          >
            {speakerName && (
              <div style={speakerNameCss(style, stageHeight, page.speaker!)}>{speakerName}</div>
            )}
            {page.words.map((w, i) => (
              <span
                key={`${page.start}-${i}`}
                style={wordCss(style, i === active, stageHeight, page.speaker)}
              >
                {style.uppercase ? w.text.toUpperCase() : w.text}
              </span>
            ))}
          </div>
        );
      })}
    </>
  );
}
