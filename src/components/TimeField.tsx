import { useEffect, useState } from "react";
import { fmtTime, parseTime } from "../lib/captions";

interface Props {
  value: number;
  onCommit: (seconds: number) => void;
  /** Optional bounds; the committed value is clamped into them. */
  min?: number;
  max?: number;
  title?: string;
  /** Rendered inside the field's row, e.g. a "set to playhead" button. */
  children?: React.ReactNode;
}

/** An editable timestamp. Type "1:23.4", "1:23" or "83.4" and press Enter (or
 * click away) to commit; Escape or anything unparseable reverts.
 *
 * This replaced rows of −5s/−1s/+1s/+5s buttons. Those took four clicks to
 * move a clip twenty seconds, couldn't express "start at 29:02.4" at all, and
 * didn't fit the panel width. */
export default function TimeField({ value, onCommit, min, max, title, children }: Props) {
  const [text, setText] = useState(() => fmtTime(value));
  const [editing, setEditing] = useState(false);

  // Track external changes (dragging the clip on the waveform, nudging from
  // elsewhere) — but never while the user is mid-edit, which would yank the
  // text out from under them.
  useEffect(() => {
    if (!editing) setText(fmtTime(value));
  }, [value, editing]);

  const commit = () => {
    setEditing(false);
    const parsed = parseTime(text);
    if (parsed == null) {
      setText(fmtTime(value));
      return;
    }
    let next = parsed;
    if (min != null) next = Math.max(min, next);
    if (max != null) next = Math.min(max, next);
    setText(fmtTime(next));
    if (next !== value) onCommit(next);
  };

  return (
    <span className="time-field">
      <input
        type="text"
        inputMode="decimal"
        value={text}
        title={title}
        onFocus={(e) => {
          setEditing(true);
          e.currentTarget.select();
        }}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            setText(fmtTime(value));
            setEditing(false);
            e.currentTarget.blur();
          }
        }}
      />
      {children}
    </span>
  );
}
