import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

export type Field = {
  name: string;
  label: string;
  type?: "text" | "number" | "email" | "select" | "textarea";
  placeholder?: string;
  defaultValue?: string;
  options?: { value: string; label: string }[];
  hint?: string;
  required?: boolean;
};

type AskOptions = {
  title: string;
  description?: string;
  fields: Field[];
  confirmLabel?: string;
};

type ConfirmOptions = {
  title: string;
  description?: string;
  confirmLabel?: string;
  danger?: boolean;
};

type Dialogs = {
  /** Resolves with the field values, or null if dismissed. */
  ask: (opts: AskOptions) => Promise<Record<string, string> | null>;
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  /** A message with a single way out. Never for questions. */
  tell: (opts: { title: string; description?: string }) => Promise<void>;
};

const Ctx = createContext<Dialogs | null>(null);

export function useDialogs(): Dialogs {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useDialogs used outside DialogProvider");
  return ctx;
}

type Pending =
  | { kind: "ask"; opts: AskOptions; resolve: (v: Record<string, string> | null) => void }
  | { kind: "confirm"; opts: ConfirmOptions; resolve: (v: boolean) => void }
  | { kind: "tell"; opts: { title: string; description?: string }; resolve: () => void };

/**
 * Dialogs, in the app's own voice.
 *
 * The browser's `prompt` and `confirm` are the wrong texture next to everything
 * else here — unstyled, untranslatable, unable to hold more than one field, and
 * they freeze the page while the board is meant to be live behind them.
 *
 * The promise-based API keeps call sites as short as the built-ins were:
 * `const answer = await ask({...})`.
 */
export function DialogProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);

  const ask = useCallback<Dialogs["ask"]>(
    (opts) => new Promise((resolve) => setPending({ kind: "ask", opts, resolve })),
    [],
  );
  const confirm = useCallback<Dialogs["confirm"]>(
    (opts) => new Promise((resolve) => setPending({ kind: "confirm", opts, resolve })),
    [],
  );
  const tell = useCallback<Dialogs["tell"]>(
    (opts) => new Promise((resolve) => setPending({ kind: "tell", opts, resolve })),
    [],
  );

  const close = (settle: () => void) => {
    settle();
    setPending(null);
  };

  return (
    <Ctx.Provider value={{ ask, confirm, tell }}>
      {children}
      {pending && (
        <DialogHost
          pending={pending}
          onDismiss={() =>
            close(() => {
              if (pending.kind === "ask") pending.resolve(null);
              else if (pending.kind === "confirm") pending.resolve(false);
              else pending.resolve();
            })
          }
          onSubmit={(values) =>
            close(() => {
              if (pending.kind === "ask") pending.resolve(values);
              else if (pending.kind === "confirm") pending.resolve(true);
              else pending.resolve();
            })
          }
        />
      )}
    </Ctx.Provider>
  );
}

function DialogHost({
  pending,
  onDismiss,
  onSubmit,
}: {
  pending: Pending;
  onDismiss: () => void;
  onSubmit: (values: Record<string, string>) => void;
}) {
  const cardRef = useRef<HTMLFormElement>(null);
  const fields = pending.kind === "ask" ? pending.opts.fields : [];

  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.name, f.defaultValue ?? ""])),
  );

  useEffect(() => {
    // Focus the first thing worth typing into, or the confirm button.
    const el = cardRef.current?.querySelector<HTMLElement>(
      "input, select, textarea, button[data-confirm]",
    );
    el?.focus();
    if (el instanceof HTMLInputElement) el.select();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onDismiss();
        return;
      }
      if (e.key !== "Tab" || !cardRef.current) return;
      // Keep focus inside: a dialog you can tab out of is a dialog you can lose.
      const focusable = cardRef.current.querySelectorAll<HTMLElement>(
        "input, select, textarea, button, [href]",
      );
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onDismiss]);

  const title = pending.opts.title;
  const description = pending.opts.description;
  const danger = pending.kind === "confirm" && pending.opts.danger;
  const confirmLabel =
    pending.kind === "tell"
      ? "Close"
      : (pending.opts.confirmLabel ?? (pending.kind === "confirm" ? "Confirm" : "Save"));

  const missing = fields.some((f) => f.required !== false && !values[f.name]?.trim());

  return (
    <>
      <div className="scrim" onClick={onDismiss} aria-hidden="true" />
      <form
        ref={cardRef}
        className={`dialog${danger ? " danger" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onSubmit={(e) => {
          e.preventDefault();
          if (missing) return;
          onSubmit(values);
        }}
      >
        <h2 className="dialog-title">{title}</h2>
        {description && <p className="dialog-desc">{description}</p>}

        {fields.map((f) => (
          <label className="field" key={f.name}>
            <span>{f.label}</span>
            {f.type === "select" ? (
              <select
                value={values[f.name] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
              >
                {(f.options ?? []).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : f.type === "textarea" ? (
              <textarea
                rows={3}
                value={values[f.name] ?? ""}
                placeholder={f.placeholder}
                onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
              />
            ) : (
              <input
                type={f.type ?? "text"}
                value={values[f.name] ?? ""}
                placeholder={f.placeholder}
                onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
              />
            )}
            {f.hint && <em className="hint">{f.hint}</em>}
          </label>
        ))}

        <div className="dialog-actions">
          {pending.kind !== "tell" && (
            <button className="btn" type="button" onClick={onDismiss}>
              Cancel
            </button>
          )}
          <button
            className={`btn ${danger ? "destructive" : "primary"}`}
            type="submit"
            data-confirm
            disabled={missing}
          >
            {confirmLabel}
          </button>
        </div>
      </form>
    </>
  );
}
