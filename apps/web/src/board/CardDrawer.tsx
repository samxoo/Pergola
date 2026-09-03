import { useEffect, useRef, useState } from "react";
import {
  atEnd,
  attachmentsFor,
  checklistsFor,
  coverImageFor,
  commentThreads,
  itemsFor,
  type BoardState,
  type Card,
  type Comment,
  type CustomField,
  type MutationBody,
  type MutationRecord,
} from "@pergola/shared";
import { useDialogs } from "../lib/Dialogs.js";
import { uploadToCard } from "../lib/upload.js";
import { Activity } from "./Activity.js";
import { InlineEdit } from "../lib/InlineEdit.js";
import { LABEL_NAMES, avatarColor, hexFor, initials } from "../lib/labels.js";
import { useT, useDateLocale } from "../lib/i18n.js";
import { Icon } from "../lib/Icon.js";

type Props = {
  state: BoardState;
  card: Card;
  meId: string | null;
  apply: (body: MutationBody) => void;
  /** Take in a change the server committed for us — an upload, say. */
  ingest: (rec: MutationRecord) => void;
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
export function CardDrawer({ state, card, meId, apply, ingest, onClose }: Props) {
  const t = useT();
  const locale = useDateLocale();
  const [panel, setPanel] = useState<Panel>(null);
  const [zoom, setZoom] = useState<{ url: string; name: string } | null>(null);
  /** The comment being answered, if the composer is in reply mode. */
  const [replyTo, setReplyTo] = useState<Comment | null>(null);
  /** The activity log is reference: folded away until asked for. */
  const [showActivity, setShowActivity] = useState(false);
  const { ask, confirm, tell } = useDialogs();
  const list = state.lists.find((l) => l.id === card.listId);
  const checklists = checklistsFor(state, card.id);
  /* The card's picture, along the top, where it can be seen without hunting. */
  const banner = coverImageFor(state, card.id);
  const attachments = attachmentsFor(state, card.id);
  const threads = commentThreads(state, card.id);
  const memberById = new Map(state.members.map((m) => [m.id, m]));
  // A member's current name first; the name recorded at creation if they left.
  const maker = card.createdBy ? memberById.get(card.createdBy) : undefined;
  const makerName = maker ? maker.name || maker.email : card.createdByName;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const el = e.target as HTMLElement | null;
      // Escape belongs to whatever field is open before it belongs to the drawer.
      if (el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT")) return;
      if (zoom) return setZoom(null);
      if (panel) return setPanel(null);
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panel, zoom, onClose]);

  const toggle = (p: Panel) => setPanel((cur) => (cur === p ? null : p));

  /**
   * Put a file on this card.
   *
   * One path, whichever way the file arrived — the picker, a drop, or a paste
   * from the clipboard. The server appends the attachment to the log itself
   * and hands the record back, which goes into the board the way any confirmed
   * change does.
   */
  const upload = async (file: File) => {
    const outcome = await uploadToCard(card.id, file);
    if (outcome.ok) {
      ingest(outcome.record);
      return;
    }
    await tell({
      title: t("That file was not accepted"),
      description: outcome.message || t("Try a smaller file."),
    });
  };

  /*
   * Paste a screenshot straight onto the card.
   *
   * Bound to the drawer rather than a particular field, because a screenshot is
   * pasted at whatever happens to have focus — and taken only when the clipboard
   * actually carries a file, so pasting text into the comment box still pastes
   * text.
   */
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = [...(e.clipboardData?.items ?? [])]
        .filter((i) => i.kind === "file")
        .map((i) => i.getAsFile())
        .filter((f): f is File => f !== null);
      if (files.length === 0) return;
      e.preventDefault();
      for (const f of files) void upload(f);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card.id]);

  return (
    <>
      {/* Dimmed but not blacked out: the board stays legible and live behind it. */}
      <div className="scrim" onClick={onClose} aria-hidden="true" />
      <aside className="drawer modal" role="dialog" aria-modal="true" aria-label={card.title}>
        <header className="drawer-head">
          <span className="mono card-no">PRG-{card.number}</span>
          <span className="drawer-crumb">{t("in {list}", { list: list?.title ?? "—" })}</span>
          <button className="icon-btn" type="button" onClick={onClose} aria-label={t("Close")}>
            ×
          </button>
        </header>

        <div className="drawer-body">
          <div className="drawer-main">
            {banner && (
              <button
                type="button"
                className="drawer-banner"
                onClick={() => setZoom({ url: banner.url, name: banner.name })}
                aria-label={t("Preview {name}", { name: banner.name })}
              >
                <img src={banner.url} alt={banner.name} />
              </button>
            )}
          <InlineEdit
            value={card.title}
            onCommit={(title) => apply({ kind: "card.rename", cardId: card.id, title })}
            className="drawer-title-edit"
            multiline
            ariaLabel={t("Card title")}
          >
            {(open) => (
              <h2 className="drawer-title" onClick={open} title={t("Click to rename")}>
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
          {/*
            * One row of chips, each an icon and a word. The panel a chip opens
            * stays marked while it is open, so the row doubles as the indicator
            * of where you are rather than needing a second one.
            */}
          <div className="actions">
            <button
              className={`cardact${panel === "labels" ? " on" : ""}`}
              type="button"
              aria-expanded={panel === "labels"}
              onClick={() => toggle("labels")}
            >
              <Icon name="tag" />
              {t("Labels")}
            </button>
            <button
              className={`cardact${panel === "members" ? " on" : ""}`}
              type="button"
              aria-expanded={panel === "members"}
              onClick={() => toggle("members")}
            >
              <Icon name="user" />
              {t("Members")}
            </button>
            <button
              className={`cardact${panel === "dates" ? " on" : ""}`}
              type="button"
              aria-expanded={panel === "dates"}
              onClick={() => toggle("dates")}
            >
              <Icon name="clock" />
              {t("Dates")}
            </button>
            <button
              className={`cardact${panel === "cover" ? " on" : ""}`}
              type="button"
              aria-expanded={panel === "cover"}
              onClick={() => toggle("cover")}
            >
              <Icon name="image" />
              {t("Cover")}
            </button>
            <button
              className={`cardact${meId && card.voterIds.includes(meId) ? " voted" : ""}`}
              type="button"
              aria-pressed={Boolean(meId && card.voterIds.includes(meId))}
              onClick={() =>
                apply({
                  kind: "card.vote",
                  cardId: card.id,
                  on: !(meId ? card.voterIds.includes(meId) : false),
                })
              }
              title={t("One vote each")}
            >
              <Icon name="vote" />
              {t("Vote")}
              {card.voterIds.length > 0 && <b className="actcount">{card.voterIds.length}</b>}
            </button>
            <button
              className="cardact"
              type="button"
              onClick={() => {
                apply({ kind: "card.archive", cardId: card.id, archived: true });
                onClose();
              }}
              title={t("Archiving can be undone with ⌘Z")}
            >
              <Icon name="archive" />
              {t("Archive")}
            </button>
          </div>

          {panel === "labels" && (
            <Panel title={t("Labels")}>
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
              <p className="panel-note">{t("Double-click a label's text to name it.")}</p>
            </Panel>
          )}

          {panel === "members" && (
            <Panel title={t("Members")}>
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
                      {m.id === meId && <em> ({t("you")})</em>}
                    </span>
                    {on && <span className="tick">✓</span>}
                  </button>
                );
              })}
            </Panel>
          )}

          {panel === "dates" && (
            <Panel title={t("Dates")}>
              <div className="date-row">
                <label className="field inline">
                  <span>{t("Starts")}</span>
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
                  <span>{t("Due")}</span>
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
                  {t("Clear both dates")}
                </button>
              )}
            </Panel>
          )}

          {panel === "cover" && (
            <Panel title={t("Cover")}>
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
          <Section title={t("Description")}>
            <InlineEdit
              value={card.descMd ?? ""}
              onCommit={(descMd) =>
                apply({ kind: "card.describe", cardId: card.id, descMd: descMd || null })
              }
              className="desc-edit"
              multiline
              ariaLabel={t("Description")}
            >
              {(open) =>
                card.descMd ? (
                  <p className="desc" onClick={open}>
                    {card.descMd}
                  </p>
                ) : (
                  <button className="empty-slot" type="button" onClick={open}>
                    {t("Add a more detailed description")}
                  </button>
                )
              }
            </InlineEdit>
          </Section>

          {/* ---- custom fields ---- */}
          <Section
            title={t("Fields")}
            action={
              <button
                className="linkish"
                type="button"
                onClick={async () => {
                  const answer = await ask({
                    title: t("Add a field"),
                    description: t("Fields belong to the board, and every card on it gets one."),
                    fields: [
                      { name: "name", label: t("Field name"), placeholder: "Effort" },
                      {
                        name: "type",
                        label: t("Type"),
                        type: "select",
                        defaultValue: "text",
                        options: [
                          { value: "text", label: t("Text") },
                          { value: "number", label: t("Number") },
                          { value: "date", label: t("Date") },
                          { value: "select", label: t("Choice from a list") },
                          { value: "checkbox", label: t("Checkbox") },
                        ],
                      },
                      {
                        name: "options",
                        label: t("Choices"),
                        required: false,
                        placeholder: "Small, Medium, Large",
                        hint: t("Comma separated. Only used by a choice field."),
                      },
                    ],
                    confirmLabel: t("Add field"),
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
                {t("Add")}
              </button>
            }
          >
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
                    title: t("Delete the field “{name}”?", { name: f.name }),
                    description: t("It goes from every card on this board, and its values go with it."),
                    confirmLabel: t("Delete field"),
                    danger: true,
                  });
                  if (ok) apply({ kind: "field.delete", fieldId: f.id });
                }}
              />
            ))}
          </Section>

          {/* ---- checklists ---- */}
          <Section
            title={t("Checklists")}
            action={
              <button
                className="linkish"
                type="button"
                onClick={async () => {
                  const answer = await ask({
                    title: t("Add a checklist"),
                    fields: [
                      {
                        name: "title",
                        label: t("Checklist name"),
                        defaultValue: t("Checklist"),
                        placeholder: "Acceptance",
                      },
                    ],
                    confirmLabel: t("Add checklist"),
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
                {t("Add")}
              </button>
            }
          >
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
                      ariaLabel={t("Checklist name")}
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
                      aria-label={t("Delete {name}", { name: cl.title })}
                      onClick={async () => {
                        const ok = await confirm({
                          title: t("Delete “{name}”?", { name: cl.title }),
                          description: t("Its items go with it, and this cannot be undone."),
                          confirmLabel: t("Delete checklist"),
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
                        ariaLabel={t("Item text")}
                      >
                        {(open) => <span onDoubleClick={open}>{it.text}</span>}
                      </InlineEdit>
                      <button
                        className="icon-btn"
                        type="button"
                        aria-label={t("Delete {name}", { name: it.text })}
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
          <Section title={t("Attachments")}>
            <button
              type="button"
              className="attach-dropzone"
              onClick={() => {
                // A hidden file input is the affordance every browser and screen
                // reader already agrees on; the big target just makes it obvious.
                const picker = document.createElement("input");
                picker.type = "file";
                picker.onchange = () => {
                  const file = picker.files?.[0];
                  if (file) void upload(file);
                };
                picker.click();
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                for (const f of e.dataTransfer.files) void upload(f);
              }}
            >
              <span className="az-ic" aria-hidden="true">⬆</span>
              <span>
                <b>{t("Upload a file")}</b>
                {t("Image, PDF or document — click to choose.")}
              </span>
            </button>
            <div style={{ marginBottom: 12 }}>
              <button
                type="button"
                className="btn-attach"
                onClick={async () => {
                  const answer = await ask({
                    title: t("Attach a link"),
                    description: t("Or upload a file, if it lives on your machine."),
                    fields: [
                      { name: "url", label: t("URL"), placeholder: "https://…" },
                      {
                        name: "name",
                        label: t("Label"),
                        required: false,
                        placeholder: t("What is it?"),
                      },
                    ],
                    confirmLabel: t("Attach"),
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
                🔗 {t("Add a link")}
              </button>
            </div>
            {attachments.map((a) => (
              <div key={a.id} className="attach-row">
                {isImageName(a.name) ? (
                  <button
                    type="button"
                    className="attach-thumb"
                    onClick={() => setZoom({ url: a.url, name: a.name })}
                    aria-label={t("Preview {name}", { name: a.name })}
                  >
                    <img src={a.url} alt={a.name} loading="lazy" />
                  </button>
                ) : (
                  <span className="attach-thumb file" aria-hidden="true">
                    📄
                  </span>
                )}
                <div className="attach-info">
                  {/* Untrusted destination: never let it reach back into this tab. */}
                  <a href={a.url} target="_blank" rel="noopener noreferrer nofollow">
                    {a.name}
                  </a>
                  <span className="muted mono attach-host">{hostOf(a.url)}</span>
                </div>
                <button
                  className="icon-btn"
                  type="button"
                  aria-label={t("Remove {name}", { name: a.name })}
                  onClick={() => apply({ kind: "attachment.remove", attachmentId: a.id })}
                >
                  ×
                </button>
              </div>
            ))}
          </Section>

          </div>

          {/*
            * Comments beside the card, not below it.
            *
            * A conversation is the part people come back to, and stacking it
            * under the description meant scrolling past everything else to
            * reach it. The activity log lives here too, folded away: it is
            * reference, wanted occasionally and in the way permanently.
            */}
          <aside className="drawer-side">
            <div className="side-head">
              <h3>{t("Comments and activity")}</h3>
              <button
                className="btn"
                type="button"
                aria-pressed={showActivity}
                onClick={() => setShowActivity((v) => !v)}
              >
                {showActivity ? t("Hide details") : t("Show details")}
              </button>
            </div>
            <AddComment
              replyingTo={replyTo ? nameOf(memberById.get(replyTo.authorId), t) : null}
              onCancelReply={() => setReplyTo(null)}
              onSend={(body) => {
                apply({
                  kind: "comment.create",
                  commentId: crypto.randomUUID(),
                  cardId: card.id,
                  body,
                  parentId: replyTo?.id ?? null,
                });
                setReplyTo(null);
              }}
            />
            {threads.map(({ comment: root, replies }) => (
              <div key={root.id} className="thread">
                <CommentRow
                  comment={root}
                  author={memberById.get(root.authorId)}
                  meId={meId}
                  onReply={() => setReplyTo(root)}
                  onEdit={(body) => apply({ kind: "comment.edit", commentId: root.id, body })}
                  onDelete={() => apply({ kind: "comment.delete", commentId: root.id })}
                />
                {replies.length > 0 && (
                  <div className="thread-replies">
                    {replies.map((r) => (
                      <CommentRow
                        key={r.id}
                        comment={r}
                        author={memberById.get(r.authorId)}
                        meId={meId}
                        /* A reply to a reply joins this thread rather than nesting again. */
                        onReply={() => setReplyTo(root)}
                        onEdit={(body) => apply({ kind: "comment.edit", commentId: r.id, body })}
                        onDelete={() => apply({ kind: "comment.delete", commentId: r.id })}
                      />
                    ))}
                  </div>
                )}
              </div>
            ))}

            {showActivity && (
              <div className="side-activity">
                <Activity boardId={state.id} cardId={card.id} cursor={state.seq} />
              </div>
            )}

            {/* Where it all started: who made the card, and when. */}
            <div className="side-origin">
              <span
                className="chip avatar small"
                style={{ background: card.createdBy ? avatarColor(card.createdBy) : "var(--muted)" }}
                aria-hidden="true"
              >
                {initials(makerName ?? "?")}
              </span>
              <span className="muted">
                {makerName
                  ? t("Created by {name}", { name: makerName })
                  : t("Created by someone no longer here")}
                {card.createdAt && (
                  <>
                    {" · "}
                    <time
                      dateTime={card.createdAt}
                      title={new Date(card.createdAt).toLocaleString(locale)}
                    >
                      {new Date(card.createdAt).toLocaleDateString(locale, {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                      })}
                    </time>
                  </>
                )}
              </span>
            </div>
          </aside>
        </div>
      </aside>
      {zoom && (
        <div
          className="lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={zoom.name}
          onClick={() => setZoom(null)}
        >
          <img src={zoom.url} alt={zoom.name} onClick={(e) => e.stopPropagation()} />
          <button
            className="lightbox-close"
            type="button"
            aria-label={t("Close")}
            onClick={() => setZoom(null)}
          >
            ×
          </button>
        </div>
      )}
    </>
  );
}

/** Uploaded files keep their real name, so the extension is a good-enough hint. */
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i;
function isImageName(name: string): boolean {
  return IMAGE_EXT.test(name.trim());
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
  const t = useT();
  return (
    <InlineEdit
      value={label.name}
      onCommit={onRename}
      className="label-name-edit"
      ariaLabel={t("Label name")}
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
  const t = useT();
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

      <button className="icon-btn" type="button" aria-label={t("Delete field {name}", { name: field.name })} onClick={onDelete}>
        ×
      </button>
    </div>
  );
}

function AddItem({ onAdd }: { onAdd: (text: string) => void }) {
  const t = useT();
  const [text, setText] = useState("");
  return (
    <form
      className="add-item"
      onSubmit={(e) => {
        e.preventDefault();
        const v = text.trim();
        if (!v) return;
        onAdd(v);
        setText(""); // adding several in a row is the common case
      }}
    >
      <input
        value={text}
        placeholder={t("Add an item")}
        onChange={(e) => setText(e.target.value)}
        aria-label={t("Add an item")}
      />
    </form>
  );
}

/** Who wrote it, falling back through name, email, then a placeholder. */
function nameOf(
  who: { name?: string; email?: string } | undefined,
  t: (k: string) => string,
): string {
  return who?.name || who?.email || t("Someone");
}

/**
 * One comment, whether it starts a thread or answers one.
 *
 * The same row either way: a reply is not a different kind of thing, it just
 * sits inside a thread. Actions are the author's own — anyone may reply, only
 * the writer may edit or delete.
 */
function CommentRow({
  comment: cm,
  author,
  meId,
  onReply,
  onEdit,
  onDelete,
}: {
  comment: Comment;
  author: { id: string; name: string; email: string } | undefined;
  meId: string | null;
  onReply: () => void;
  onEdit: (body: string) => void;
  onDelete: () => void;
}) {
  const t = useT();
  const locale = useDateLocale();
  const mine = cm.authorId === meId;
  const who = nameOf(author, t);

  return (
    <div className="comment">
      <span
        className="chip avatar"
        style={{ background: avatarColor(cm.authorId) }}
        title={who}
        aria-hidden="true"
      >
        {initials(who)}
      </span>
      <div className="comment-body">
        <div className="comment-meta">
          <strong>{who}</strong>
          <span className="muted mono">{when(cm.createdAt, t, locale)}</span>
          {cm.editedAt && <span className="muted">{t("edited")}</span>}
        </div>
        <InlineEdit
          value={cm.body}
          onCommit={onEdit}
          className="comment-edit"
          multiline
          ariaLabel={t("Comment")}
        >
          {(open) => <p onDoubleClick={mine ? open : undefined}>{cm.body}</p>}
        </InlineEdit>
        <div className="comment-actions">
          <button className="linkish" type="button" onClick={onReply}>
            {t("Reply")}
          </button>
          {mine && (
            <button className="linkish" type="button" onClick={onDelete}>
              {t("Delete")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function AddComment({
  onSend,
  replyingTo,
  onCancelReply,
}: {
  onSend: (body: string) => void;
  /** Whose comment is being answered, or null when starting a new thread. */
  replyingTo: string | null;
  onCancelReply: () => void;
}) {
  const t = useT();
  const [body, setBody] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);

  // Choosing Reply should put the cursor where the reply gets typed, rather
  // than leaving a banner on screen and the person hunting for the box.
  useEffect(() => {
    if (replyingTo) box.current?.focus();
  }, [replyingTo]);

  return (
    <form
      className={`add-comment${replyingTo ? " replying" : ""}`}
      onSubmit={(e) => {
        e.preventDefault();
        const b = body.trim();
        if (!b) return;
        onSend(b);
        setBody("");
      }}
    >
      {replyingTo && (
        <div className="replying-to">
          <span>{t("Replying to {name}", { name: replyingTo })}</span>
          <button className="linkish" type="button" onClick={onCancelReply}>
            {t("Cancel")}
          </button>
        </div>
      )}
      <textarea
        ref={box}
        rows={2}
        value={body}
        placeholder={replyingTo ? t("Write a reply") : t("Write a comment")}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            e.currentTarget.form?.requestSubmit();
          }
          // Escape leaves reply mode before it reaches the drawer and closes it.
          if (e.key === "Escape" && replyingTo) {
            e.stopPropagation();
            onCancelReply();
          }
        }}
        aria-label={replyingTo ? t("Write a reply") : t("Write a comment")}
      />
      <div className="add-comment-foot">
        <span className="muted">
          <kbd>⌘</kbd>
          <kbd>Enter</kbd> {t("to post")}
        </span>
        <button className="btn primary" type="submit" disabled={!body.trim()}>
          {replyingTo ? t("Reply") : t("Comment")}
        </button>
      </div>
    </form>
  );
}

function DueChip({ dueAt }: { dueAt: string }) {
  const t = useT();
  const locale = useDateLocale();
  const due = new Date(dueAt);
  const overdue = due.getTime() < Date.now();
  return (
    <span className={`chip due${overdue ? " overdue" : ""}`} title={due.toLocaleString(locale)}>
      {overdue ? t("Overdue") : t("Due")}{" "}
      {due.toLocaleDateString(locale, { month: "short", day: "numeric" })}
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

function when(
  iso: string,
  t: (k: string, p?: Record<string, string | number>) => string,
  locale: string | undefined,
): string {
  const then = new Date(iso).getTime();
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return t("just now");
  if (mins < 60) return t("{count}m ago", { count: mins });
  if (mins < 60 * 24) return t("{count}h ago", { count: Math.round(mins / 60) });
  return new Date(iso).toLocaleDateString(locale, { month: "short", day: "numeric" });
}
