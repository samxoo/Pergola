import { useEffect, useRef, useState } from "react";

type Props = {
  value: string;
  onCommit: (next: string) => void;
  /** Rendered when not editing. Receives the props that open the editor. */
  children: (open: () => void) => React.ReactNode;
  className?: string;
  multiline?: boolean;
  ariaLabel: string;
};

/**
 * Click to edit, Enter to keep, Escape to abandon.
 *
 * Blur commits rather than discards: losing a rename because you clicked away is
 * the kind of small betrayal that makes a tool feel unsafe to type into.
 */
export function InlineEdit({
  value,
  onCommit,
  children,
  className,
  multiline = false,
  ariaLabel,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);
  // Escape must not let the blur handler save what we just abandoned.
  const abandoned = useRef(false);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  useEffect(() => {
    if (!editing) return;
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [editing]);

  if (!editing) {
    return (
      <>
        {children(() => {
          abandoned.current = false;
          setEditing(true);
        })}
      </>
    );
  }

  const commit = () => {
    if (abandoned.current) return;
    const next = draft.trim();
    setEditing(false);
    if (next && next !== value) onCommit(next);
  };

  return (
    <textarea
      ref={ref}
      className={className}
      aria-label={ariaLabel}
      rows={multiline ? 2 : 1}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          commit();
        }
        if (e.key === "Escape") {
          e.preventDefault();
          abandoned.current = true;
          setDraft(value);
          setEditing(false);
        }
      }}
      onBlur={commit}
    />
  );
}
