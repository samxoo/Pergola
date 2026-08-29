import type { BoardState, MutationBody } from "@pergola/shared";
import { useDialogs } from "../lib/Dialogs.js";

type Props = {
  state: BoardState;
  apply: (body: MutationBody) => void;
  onClose: () => void;
};

/**
 * Archived cards, with a way back.
 *
 * Archiving is the reversible action the board offers; deleting from here is the
 * irreversible one, and it says so. Keeping them in separate places means nobody
 * reaches for the permanent one by muscle memory.
 */
export function Archive({ state, apply, onClose }: Props) {
  const { confirm } = useDialogs();
  const archived = state.cards
    .filter((c) => c.archivedAt)
    .sort((a, b) => (a.archivedAt! < b.archivedAt! ? 1 : -1));
  const listById = new Map(state.lists.map((l) => [l.id, l]));

  return (
    <>
      <div className="scrim" onClick={onClose} aria-hidden="true" />
      <aside className="drawer" role="dialog" aria-label="Archived cards">
        <header className="drawer-head">
          <strong>Archive</strong>
          <span className="drawer-crumb">
            {archived.length} card{archived.length === 1 ? "" : "s"}
          </span>
          <button className="icon-btn" type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="drawer-body">
          {archived.length === 0 && <p className="muted">Nothing has been archived.</p>}

          {archived.map((c) => (
            <div key={c.id} className="archived-row">
              <div className="archived-main">
                <span className="mono card-no">PRG-{c.number}</span>
                <span className="archived-title">{c.title}</span>
                <span className="muted">{listById.get(c.listId)?.title ?? "—"}</span>
              </div>
              <div className="archived-actions">
                <button
                  className="btn"
                  type="button"
                  onClick={() => apply({ kind: "card.archive", cardId: c.id, archived: false })}
                >
                  Restore
                </button>
                <button
                  className="linkish danger"
                  type="button"
                  onClick={async () => {
                    const ok = await confirm({
                      title: `Delete “${c.title}” for good?`,
                      description:
                        "Its comments and checklists go with it. This is the one action here that cannot be undone.",
                      confirmLabel: "Delete permanently",
                      danger: true,
                    });
                    if (ok) apply({ kind: "card.delete", cardId: c.id });
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      </aside>
    </>
  );
}
