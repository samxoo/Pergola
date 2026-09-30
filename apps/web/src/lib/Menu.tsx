import { useEffect, useState } from "react";

/**
 * A small overflow menu: a button that opens a popover of actions. Mirrors the
 * notifications bell — a click on the backdrop or Escape closes it. It keeps the
 * rarely-used board actions out of the top bar so the everyday ones are not lost
 * in a long row of buttons.
 */
export function Menu({
  label,
  title,
  align = "left",
  triggerClassName = "btn icon-only",
  children,
}: {
  label: React.ReactNode;
  title?: string;
  align?: "left" | "right";
  /** The button's look. An outline button unless the label is its own shape. */
  triggerClassName?: string;
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="menuwrap">
      <button
        className={triggerClassName}
        type="button"
        title={title}
        aria-label={title}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {label}
      </button>
      {open && (
        <>
          <div className="menu-backdrop" onClick={() => setOpen(false)} aria-hidden="true" />
          <div className={`menu-panel${align === "right" ? " right" : ""}`} role="menu">
            {children(() => setOpen(false))}
          </div>
        </>
      )}
    </div>
  );
}

/** One row in a {@link Menu}. */
export function MenuItem({
  icon,
  onClick,
  children,
}: {
  icon?: React.ReactNode;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button className="menu-item" type="button" role="menuitem" onClick={onClick}>
      {icon != null && (
        <span className="mi-ic" aria-hidden="true">
          {icon}
        </span>
      )}
      <span>{children}</span>
    </button>
  );
}
