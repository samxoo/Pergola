import { useEffect, useState } from "react";
import { Mark } from "./lib/Mark.js";
import { hexFor } from "./lib/labels.js";
import { useT, useDateLocale, LanguageToggle } from "./lib/i18n.js";

type PublicCard = {
  id: string;
  listId: string;
  number: number;
  title: string;
  descMd: string | null;
  dueAt: string | null;
  coverColor: string | null;
  labelIds: string[];
  checklist: { done: number; total: number } | null;
};

type PublicView = {
  id: string;
  title: string;
  lists: { id: string; title: string }[];
  labels: { id: string; name: string; color: string }[];
  cards: PublicCard[];
};

/**
 * A board someone published.
 *
 * Read-only by construction, not by hiding buttons: this component has no way to
 * write, and the endpoint behind it never returns members or comments. A visitor
 * needs no account and gets no account.
 */
export function PublicBoard({ boardId }: { boardId: string }) {
  const t = useT();
  const locale = useDateLocale();
  const [view, setView] = useState<PublicView | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    void (async () => {
      const res = await fetch(`/api/public/boards/${boardId}`);
      if (!res.ok) return setMissing(true);
      setView((await res.json()) as PublicView);
    })();
  }, [boardId]);

  if (missing) {
    return (
      <div className="empty">
        <h2>{t("Nothing at this link")}</h2>
        <p>
          {t("This board is private, or the link is wrong. Ask whoever shared it to publish it again.")}
        </p>
        <a className="btn" href="/">
          {t("Go to Pergola")}
        </a>
      </div>
    );
  }

  if (!view) return <div className="loading">{t("Loading…")}</div>;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <Mark />
          <b>Pergola</b>
        </div>
        <span className="board-title">{view.title}</span>
        <span className="spacer" />
        <LanguageToggle />
        <span className="status">
          <i />
          {t("Read only")}
        </span>
        <a className="btn" href="/">
          {t("Sign in")}
        </a>
      </header>

      <div className="boardscroll">
        <div className="lane bare">
          <div className="board">
            {view.lists.map((list) => {
              const cards = view.cards.filter((c) => c.listId === list.id);
              return (
                <section className="column" key={list.id}>
                  <header className="column-head" style={{ cursor: "default" }}>
                    <span className="column-title">{list.title}</span>
                    <span className="count mono" style={{ cursor: "default" }}>
                      {cards.length}
                    </span>
                  </header>
                  <div className="cards">
                    {cards.map((c) => (
                      <article className="card" key={c.id} style={{ cursor: "default" }}>
                        {c.coverColor && (
                          <div className="cover" style={{ background: hexFor(c.coverColor) }} />
                        )}
                        {c.labelIds.length > 0 && (
                          <div className="card-labels">
                            {c.labelIds.map((id) => {
                              const l = view.labels.find((x) => x.id === id);
                              return l ? (
                                <span
                                  key={id}
                                  className="label-dash"
                                  style={{ background: hexFor(l.color) }}
                                  title={l.name || l.color}
                                />
                              ) : null;
                            })}
                          </div>
                        )}
                        <div className="card-title">{c.title}</div>
                        <div className="card-meta">
                          <span className="card-no mono">PRG-{c.number}</span>
                          {c.dueAt && (
                            <span className="badge due">
                              {new Date(c.dueAt).toLocaleDateString(locale, {
                                month: "short",
                                day: "numeric",
                              })}
                            </span>
                          )}
                          {c.checklist && c.checklist.total > 0 && (
                            <span className="badge mono">
                              ✓ {c.checklist.done}/{c.checklist.total}
                            </span>
                          )}
                        </div>
                      </article>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
