import { useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import type { CaptionStyle, Segment } from "../types";
import { paginate, pageAt, activeWordIndex, applyCensor } from "../lib/captions";
import { containerCss, wordCss } from "../lib/styles";

interface Props {
  videoRef: RefObject<HTMLVideoElement | null>;
  segments: Segment[];
  style: CaptionStyle;
  censor: boolean;
  /** Rendered height of the visible video area in px */
  stageHeight: number;
}

export default function CaptionOverlay({ videoRef, segments, style, censor, stageHeight }: Props) {
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
    const segs = censor ? applyCensor(segments) : segments;
    return paginate(segs, style.maxWordsPerPage);
  }, [segments, style.maxWordsPerPage, censor]);

  const page = pageAt(pages, time);
  if (!page || stageHeight <= 0) return null;
  const active = activeWordIndex(page, time);

  return (
    <div style={containerCss(style, stageHeight)}>
      {page.words.map((w, i) => (
        <span key={`${page.start}-${i}`} style={wordCss(style, i === active, stageHeight)}>
          {style.uppercase ? w.text.toUpperCase() : w.text}
        </span>
      ))}
    </div>
  );
}
