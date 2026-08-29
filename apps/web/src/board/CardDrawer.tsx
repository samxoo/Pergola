import { useEffect, useState } from "react";
import {
  atEnd,
  attachmentsFor,
  checklistsFor,
  commentsFor,
  itemsFor,
  type BoardState,
  type Card,
  type CustomField,
  type MutationBody,
} from "@pergola/shared";
import { useDialogs } from "../lib/Dialogs.js";
import { Activity } from "./Activity.js";
import { InlineEdit } from "../lib/InlineEdit.js";
import { LABEL_NAMES, avatarColor, hexFor, initials } from "../lib/labels.js";

type Props = {
  state: BoardState;
  card: Card;
  meId: string | null;
  apply: (body: MutationBody) => void;
  /** Reload the board — an upload is written by the server, not by a mutation. */
  refresh: () => Promise<void>;
  onClose: () => void;
};

type Panel = "labels" | "members" | "dates" | "cover" | null;

/**
 * The card, in full.
 *
 * A drawer rather than a modal on purpose: Trello blacks out the board behind
 * its card dialog, which is exactly the wrong move in a tool where the board is
 * live and teammates are moving things while you read.
 */
export function CardDrawer({ state, card, meId, apply, refresh, onClose }: Props) {
  const [panel, setPanel] = useState<Panel>(null);
  const { ask, confirm, tell } = useDialogs();
  const list = state.lists.find((l) => l.id === card.listId);
  const checklists = checklistsFor(state, card.id);
  const attachments = attachmentsFor(state, card.id);
  const comments = commentsFor(state, card.id);
  const memberById = new Map(state.members.map((m) => [m.id, m]));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const el = e.target as HTMLElement | null;
      // Escape belongs to whatever field is open before it belongs to the drawer.
      if (el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT")) return;
      if (panel) return setPanel(null);
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panel, onClose]);

  const toggle = (p: Panel) => setPanel((cur) => (cur === p ? null : p));

  return (
    <>
      {/* Dimmed but not blacked out: the board stays legible and live behind it. */}
      <div className="scrim" onClick={onClose} aria-hidden="true" />
      <aside className="drawer" role="dialog" aria-label={card.title}>
        <header className="drawer-head">
          <span className="mono card-no">PRG-{card.number}</span>
          <span className="drawer-crumb">in {list?.title ?? "—"}</span>
          <button className="icon-btn" type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="drawer-body">
          <InlineEdit
            value={card.title}
            onCommit={(title) => apply({ kind: "card.rename", cardId: card.id, title })}
            className="drawer-title-edit"
            multiline
            ariaLabel="Card title"
          >
            {(open) => (
              <h2 className="drawer-title" onClick={open} title="Click to rename">
                {card.title}
              </h2>
            )}
          </InlineEdit>

          {/* ---- what is already on the card ---- */}
          {(card.labelIds.length > 0 || card.assigneeIds.length > 0 || card.dueAt) && (
            <div className="chips">
              {card.labelIds.map((id) => {
                const l = state.labels.find((x) => x.id === id);
                if (!l) return null;
                return (
                  <span
                    key={id}
                    className="chip label"
                    style={{ background: hexFor(l.color) }}
                    title={l.name || l.color}
                  >
                    {l.name || l.color}
                  </span>
                );
              })}
              {card.assigneeIds.map((id) => {
                const m = memberById.get(id);
                return (
                  <span
                    key={id}
                    className="chip avatar"
                    style={{ background: avatarColor(id) }}
                    title={m?.name ?? id}
                  >
                    {initials(m?.name ?? m?.email ?? "?")}
                  </span>
                );
              })}
              {card.dueAt && <DueChip dueAt={card.dueAt} />}
            </div>
          )}

          {/* ---- actions ---- */}
          <div className="actions">
            <button className="btn" type="button" onClick={() => toggle("labels")}>Labels</button>
            <button className="btn" type="button" onClick={() => toggle("members")}>Members</button>
            <button className="btn" type="button" onClick={() => toggle("dates")}>Dates</button>
            <button className="btn" type="button" onClick={() => toggle("cover")}>Cover</button>
            <button
              className={`btn${meId && card.voterIds.includes(meId) ? " primary" : ""}`}
              type="button"
              onClick={() =>
                apply({
                  kind: "card.vote",
                  cardId: card.id,
                  on: !(meId ? card.voterIds.includes(meId) : false),
                })
              }
              title="One vote each"
            >
              ▲ Vote{card.voterIds.length > 0 ? ` · ${card.voterIds.length}` : ""}
            </button>
            <button
              className="btn"
              type="button"
              onClick={() => {
                apply({ kind: "card.archive", cardId: card.id, archived: true });
                onClose();
              }}
              title="Archiving can be undone with ⌘Z"
            >
              Archive
            </button>
          </div>

          {panel === "labels" && (
            <Panel title="Labels">
              {state.labels.map((l) => {
                const on = card.labelIds.includes(l.id);
                return (
                  <button
                    key={l.id}
                    type="button"
                    className={`pick label-pick${on ? " on" : ""}`}
                    style={{ borderColor: hexFor(l.color) }}
                    onClick={() =>
                      apply({ kind: "card.label", cardId: card.id, labelId: l.id, on: !on })
                    }
                  >
                    <i style={{ background: hexFor(l.color) }} />
                    <InlineEditableLabel
                      label={l}
                      onRename={(name) =>
                        apply({ kind: "label.update", labelId: l.id, name, color: l.color })
                      }
                    />
                    {on && <span className="tick">✓</span>}
                  </button>
                );
              })}
              <p className="panel-note">Double-click a label's text to name it.</p>
            </Panel>
          )}

          {panel === "members" && (
            <Panel title="Members">
              {state.members.map((m) => {
                const on = card.assigneeIds.includes(m.id);
                return (
                  <button
                    key={m.id}
                    type="button"
                    className={`pick${on ? " on" : ""}`}
                    onClick={() =>
                      apply({ kind: "card.assign", cardId: card.id, userId: m.id, on: !on })
                    }
                  >
                    <span className="chip avatar" style={{ background: avatarColor(m.id) }}>
                      {initials(m.name || m.email)}
                    </span>
                    <span className="pick-name">
                      {m.name}
                      {m.id === meId && <em> (you)</em>}
                    </span>
                    {on && <span className="tick">✓</span>}
                  </button>
                );
              })}
            </Panel>
          )}

          {panel === "dates" && (
            <Panel title="Dates">
              <div className="date-row">
                <label className="field inline">
                  <span>Starts</span>
                  <input
                    type="datetime-local"
                    value={toLocal(card.startAt)}
                    onChange={(e) =>
                      apply({
                        kind: "card.setDates",
                        cardId: card.id,
                        startAt: fromLocal(e.target.value),
                        dueAt: card.dueAt,
                      })
                    }
                  />
                </label>
                <label className="field inline">
                  <span>Due</span>
                  <input
                    type="datetime-local"
                    value={toLocal(card.dueAt)}
                    onChange={(e) =>
                      apply({
                        kind: "card.setDates",
                        cardId: card.id,
                        startAt: card.startAt,
                        dueAt: fromLocal(e.target.value),
                      })
                    }
                  />
                </label>
              </div>
              {(card.startAt || card.dueAt) && (
                <button
                  className="linkish"
                  type="button"
                  onClick={() =>
                    apply({ kind: "card.setDates", cardId: card.id, startAt: null, dueAt: null })
                  }
                >
                  Clear both dates
                </button>
              )}
            </Panel>
          )}

          {panel === "cover" && (
            <Panel title="Cover">
              <div className="swatch-row">
                {LABEL_NAMES.map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-label={c}
                    className={`swatch${card.coverColor === c ? " on" : ""}`}
                    style={{ background: hexFor(c) }}
                    onClick={() =>
                      apply({
                        kind: "card.setCover",
                        cardId: card.id,
                        coverColor: card.coverColor === c ? null : c,
                      })
                    }
                  />
                ))}
              </div>
            </Panel>
          )}

          {/* ---- description ---- */}
          <Section title="Description">
            <InlineEdit
              value={card.descMd ?? ""}
              onCommit={(descMd) =>
                apply({ kind: "card.describe", cardId: card.id, descMd: descMd || null })
              }
              className="desc-edit"
              multiline
              ariaLabel="Description"
            >
              {(open) =>
                card.descMd ? (
                  <p className="desc" onClick={open}>
                    {card.descMd}
                  </p>
                ) : (
                  <button className="empty-slot" type="button" onClick={open}>
                    Add a more detailed description
                  </button>
                )
              }
            </InlineEdit>
          </Section>

          {/* ---- custom fields ---- */}
          <Section
            title="Fields"
            action={
              <button
                className="linkish"
                type="button"
                onClick={async () => {
                  const answer = await ask({
                    title: "Add a field",
                    description: "Fields belong to the board, and every card on it gets one.",
                    fields: [
                      { name: "name", label: "Field name", placeholder: "Effort" },
                      {
                        name: "type",
                        label: "Type",
                        type: "select",
                        defaultValue: "text",
                        options: [
                          { value: "text", label: "Text" },
                          { value: "number", label: "Number" },
                          { value: "date", label: "Date" },
                          { value: "select", label: "Choice from a list" },
                          { value: "checkbox", label: "Checkbox" },
                        ],
                      },
                      {
                        name: "options",
                        label: "Choices",
                        required: false,
                        placeholder: "Small, Medium, Large",
                        hint: "Comma separated. Only used by a choice field.",
                      },
                    ],
                    confirmLabel: "Add field",
                  });
                  const name = answer?.name?.trim();
                  const type = answer?.type as CustomField["type"] | undefined;
                  if (!name || !type) return;
                  apply({
                    kind: "field.create",
                    fieldId: crypto.randomUUID(),
                    name,
                    type,
                    options:
                      type === "select"
                        ? (answer?.options ?? "").split(",").map((o) => o.trim()).filter(Boolean)
                        : [],
                    position: atEnd(state.fields.at(-1)?.position ?? null),
                  });
                }}
              >
                Add
              </button>
            }
          >
            {state.fields.length === 0 && (
              <p className="muted">None on this board yet.</p>
            )}
            {state.fields.map((f) => (
              <FieldRow
                key={f.id}
                field={f}
                value={card.fields[f.id] ?? null}
                onSet={(value) =>
                  apply({ kind: "card.setField", cardId: card.id, fieldId: f.id, value })
                }
                onDelete={async () => {
                  const ok = await confirm({
                    title: `Delete the field “${f.name}”?`,
                    description:
                      "It goes from every card on this board, and its values go with it.",
                    confirmLabel: "Delete field",
                    danger: true,
                  });
                  if (ok) apply({ kind: "field.delete", fieldId: f.id });
                }}
              />
            ))}
          </Section>

          {/* ---- checklists ---- */}
          <Section
            title="Checklists"
            action={
              <button
                className="linkish"
                type="button"
                onClick={async () => {
                  const answer = await ask({
                    title: "Add a checklist",
                    fields: [
                      {
                        name: "title",
                        label: "Checklist name",
                        defaultValue: "Checklist",
                        placeholder: "Acceptance",
                      },
                    ],
                    confirmLabel: "Add checklist",
                  });
                  const title = answer?.title?.trim();
                  if (!title) return;
                  apply({
                    kind: "checklist.create",
                    checklistId: crypto.randomUUID(),
                    cardId: card.id,
                    title,
                    position: atEnd(checklists.at(-1)?.position ?? null),
                  });
                }}
              >
                Add
              </button>
            }
          >
            {checklists.length === 0 && <p className="muted">None yet.</p>}
            {checklists.map((cl) => {
              const items = itemsFor(state, cl.id);
              const done = items.filter((i) => i.done).length;
              return (
                <div key={cl.id} className="checklist">
                  <div className="checklist-head">
                    <InlineEdit
                      value={cl.title}
                      onCommit={(title) =>
                        apply({ kind: "checklist.rename", checklistId: cl.id, title })
                      }
                      className="checklist-edit"
                      ariaLabel="Checklist name"
                    >
                      {(open) => (
                        <strong onDoubleClick={open}>{cl.title}</strong>
                      )}
                    </InlineEdit>
                    <span className="mono muted">
                      {done}/{items.length}
                    </span>
                    <button
                      className="icon-btn"
                      type="button"
                      aria-label={`Delete ${cl.title}`}
                      onClick={async () => {
                        const ok = await confirm({
                          title: `Delete “${cl.title}”?`,
                          description: "Its items go with it, and this cannot be undone.",
                          confirmLabel: "Delete checklist",
                          danger: true,
                        });
                        if (ok) apply({ kind: "checklist.delete", checklistId: cl.id });
                      }}
                    >
                      ×
                    </button>
                  </div>
                  {items.length > 0 && (
                    <div
                      className="progress"
                      role="progressbar"
                      aria-valuenow={items.length ? Math.round((done / items.length) * 100) : 0}
                      aria-valuemin={0}
                      aria-valuemax={100}
                    >
                      <i style={{ width: `${items.length ? (done / items.length) * 100 : 0}%` }} />
                    </div>
                  )}
                  {items.map((it) => (
                    <div key={it.id} className={`item${it.done ? " done" : ""}`}>
                      <input
                        type="checkbox"
                        checked={it.done}
                        onChange={(e) =>
                          apply({ kind: "item.toggle", itemId: it.id, done: e.target.checked })
                        }
                        aria-label={it.text}
                      />
                      <InlineEdit
                        value={it.text}
                        onCommit={(text) => apply({ kind: "item.rename", itemId: it.id, text })}
                        className="item-edit"
                        ariaLabel="Item text"
                      >
                        {(open) => <span onDoubleClick={open}>{it.text}</span>}
                      </InlineEdit>
                      <button
                        className="icon-btn"
                        type="button"
                        aria-label={`Delete ${it.text}`}
                        onClick={() => apply({ kind: "item.delete", itemId: it.id })}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  <AddItem
                    onAdd={(text) =>
                      apply({
                        kind: "item.create",
                        itemId: crypto.randomUUID(),
                        checklistId: cl.id,
                        text,
                        position: atEnd(items.at(-1)?.position ?? null),
                      })
                    }
                  />
                </div>
              );
            })}
          </Section>

          {/* ---- attachments ---- */}
          <Section
            title="Attachments"
            action={
              <span className="attach-actions">
              <button
                className="linkish"
                type="button"
                onClick={() => {
                  /*
                   * A hidden input rather than a drop zone: the picker is the
                   * one affordance every browser and screen reader already
                   * agrees on, and a card drawer is a poor drop target anyway.
                   */
                  const picker = document.createElement("input");
                  picker.type = "file";
                  picker.onchange = async () => {
                    const file = picker.files?.[0];
                    if (!file) return;
                    const form = new FormData();
                    form.append("file", file);
                    const res = await fetch(`/api/cards/${card.id}/files`, {
                      method: "POST",
                      body: form,
                    });
                    if (!res.ok) {
                      const { message } = (await res.json().catch(() => ({}))) as {
                        message?: string;
                      };
                      await tell({
                        title: "That file was not accepted",
                        description: message ?? "Try a smaller file.",
                      });
                      return;
                    }
                    // The server has already written the row; pull it into view.
                    await refresh();
                  };
                  picker.click();
                }}
              >
                Upload
              </button>
              <button
                className="linkish"
                type="button"
                onClick={async () => {
                  const answer = await ask({
                    title: "Attach a link",
                    description: "Or upload a file, if it lives on your machine.",
                    fields: [
                      { name: "url", label: "URL", placeholder: "https://…" },
                      {
                        name: "name",
                        label: "Label",
                        required: false,
                        placeholder: "What is it?",
                      },
                    ],
                    confirmLabel: "Attach",
                  });
                  const url = answer?.url?.trim();
                  if (!url) return;
                  apply({
                    kind: "attachment.add",
                    attachmentId: crypto.randomUUID(),
                    cardId: card.id,
                    url,
                    name: answer?.name?.trim() || hostOf(url),
                  });
                }}
              >
                Link
              </button>
              </span>
            }
          >
            {attachments.length === 0 && <p className="muted">None.</p>}
            {attachments.map((a) => (
              <div key={a.id} className="attach-row">
                {/* Untrusted destination: never let it reach back into this tab. */}
                <a href={a.url} target="_blank" rel="noopener noreferrer nofollow">
                  {a.name}
                </a>
                <span className="muted mono attach-host">{hostOf(a.url)}</span>
                <button
                  className="icon-btn"
                  type="button"
                  aria-label={`Remove ${a.name}`}
                  onClick={() => apply({ kind: "attachment.remove", attachmentId: a.id })}
                >
                  ×
                </button>
              </div>
            ))}
          </Section>

          {/* ---- activity ---- */}
          <Section title="Activity">
            <Activity boardId={state.id} cardId={card.id} cursor={state.seq} />
          </Section>

          {/* ---- comments ---- */}
          <Section title="Comments">
            <AddComment
              onSend={(body) =>
                apply({
                  kind: "comment.create",
                  commentId: crypto.randomUUID(),
                  cardId: card.id,
                  body,
                })
              }
            />
            {comments.length === 0 && <p className="muted">No comments yet.</p>}
            {comments.map((cm) => {
              const author = memberById.get(cm.authorId);
              return (
                <div key={cm.id} className="comment">
                  <span
                    className="chip avatar"
                    style={{ background: avatarColor(cm.authorId) }}
                    title={author?.name ?? "Someone"}
                  >
                    {initials(author?.name ?? author?.email ?? "?")}
                  </span>
                  <div className="comment-body">
                    <div className="comment-meta">
                      <strong>{author?.name ?? "Someone"}</strong>
                      <span className="muted mono">{when(cm.createdAt)}</span>
                      {cm.editedAt && <span className="muted">edited</span>}
                    </div>
                    <InlineEdit
                      value={cm.body}
                      onCommit={(body) => apply({ kind: "comment.edit", commentId: cm.id, body })}
                      className="comment-edit"
                      multiline
                      ariaLabel="Comment"
                    >
                      {(open) => (
                        <p onDoubleClick={cm.authorId === meId ? open : undefined}>{cm.body}</p>
                      )}
                    </InlineEdit>
                  </div>
                  {cm.authorId === meId && (
                    <button
                      className="icon-btn"
                      type="button"
                      aria-label="Delete comment"
                      onClick={() => apply({ kind: "comment.delete", commentId: cm.id })}
                    >
                      ×
                    </button>
                  )}
                </div>
              );
            })}
          </Section>
        </div>
      </aside>
    </>
  );
}

/* -------------------------------------------------------------- fragments */

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="drawer-section">
      <div className="section-head">
        <h3>{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="panel">
      <h4>{title}</h4>
      {children}
    </div>
  );
}

function InlineEditableLabel({
  label,
  onRename,
}: {
  label: { name: string; color: string };
  onRename: (name: string) => void;
}) {
  return (
    <InlineEdit
      value={label.name}
      onCommit={onRename}
      className="label-name-edit"
      ariaLabel="Label name"
    >
      {(open) => (
        <span
          className="pick-name"
          onDoubleClick={(e) => {
            e.stopPropagation();
            open();
          }}
        >
          {label.name || <em className="muted">{label.color}</em>}
        </span>
      )}
    </InlineEdit>
  );
}

function FieldRow({
  field,
  value,
  onSet,
  onDelete,
}: {
  field: CustomField;
  value: string | null;
  onSet: (value: string | null) => void;
  onDelete: () => void;
}) {
  // An empty string means "no value", never the empty string itself — otherwise
  // clearing a field and typing nothing into it would be two different states.
  const set = (v: string) => onSet(v === "" ? null : v);

  return (
    <div className="field-row">
      <span className="field-name">{field.name}</span>

      {field.type === "checkbox" ? (
        <input
          type="checkbox"
          checked={value === "true"}
          aria-label={field.name}
          onChange={(e) => onSet(e.target.checked ? "true" : null)}
        />
      ) : field.type === "select" ? (
        <select
          className="field-input"
          value={value ?? ""}
          aria-label={field.name}
          onChange={(e) => set(e.target.value)}
        >
          <option value="">—</option>
          {field.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : (
        <input
          className="field-input"
          type={field.type === "number" ? "number" : field.type === "date" ? "date" : "text"}
          value={value ?? ""}
          aria-label={field.name}
          onChange={(e) => set(e.target.value)}
        />
      )}

      <button className="icon-btn" type="button" aria-label={`Delete field ${field.name}`} onClick={onDelete}>
        ×
      </button>
    </div>
  );
}

function AddItem({ onAdd }: { onAdd: (text: string) => void }) {
  const [text, setText] = useState("");
  return (
    <form
      className="add-item"
      onSubmit={(e) => {
        e.preventDefault();
        const t = text.trim();
        if (!t) return;
        onAdd(t);
        setText(""); // adding several in a row is the common case
      }}
    >
      <input
        value={text}
        placeholder="Add an item"
        onChange={(e) => setText(e.target.value)}
        aria-label="Add an item"
      />
    </form>
  );
}

function AddComment({ onSend }: { onSend: (body: string) => void }) {
  const [body, setBody] = useState("");
  return (
    <form
      className="add-comment"
      onSubmit={(e) => {
        e.preventDefault();
        const b = body.trim();
        if (!b) return;
        onSend(b);
        setBody("");
      }}
    >
      <textarea
        rows={2}
        value={body}
        placeholder="Write a comment"
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            e.currentTarget.form?.requestSubmit();
          }
        }}
        aria-label="Write a comment"
      />
      <div className="add-comment-foot">
        <span className="muted">
          <kbd>⌘</kbd>
          <kbd>Enter</kbd> to post
        </span>
        <button className="btn primary" type="submit" disabled={!body.trim()}>
          Comment
        </button>
      </div>
    </form>
  );
}

function DueChip({ dueAt }: { dueAt: string }) {
  const due = new Date(dueAt);
  const overdue = due.getTime() < Date.now();
  return (
    <span className={`chip due${overdue ? " overdue" : ""}`} title={due.toLocaleString()}>
      {overdue ? "Overdue " : "Due "}
      {due.toLocaleDateString(undefined, { month: "short", day: "numeric" })}
    </span>
  );
}

/* ------------------------------------------------------------------ dates */

/** ISO instant -> the value a datetime-local input wants, in local time. */
function toLocal(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** ...and back. An empty field means "no date", not "epoch". */
function fromLocal(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Just the host, so a long URL does not swamp the row. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 40);
  }
}

function when(iso: string): string {
  const then = new Date(iso).getTime();
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
