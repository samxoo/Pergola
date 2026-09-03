import { Icon } from "./lib/Icon.js";
import { useT, usePlural } from "./lib/i18n.js";
// Rides with the component, the way the admin console's sheet does: nothing
// else wants these rules, and App.tsx already imports Home to show it.
import "./styles.home.css";

/** One row of GET /api/boards. */
export type BoardSummary = {
  id: string;
  title: string;
  seq: number;
  /** Board role — the membership's, or "admin" by virtue of running the instance. */
  role: string;
  /** False on a board this person can open only because they run the instance. */
  member: boolean;
  /** Who started it. Null on a board whose creator's account is gone. */
  createdBy: string | null;
  createdAt: string;
  memberCount: number;
  cardCount: number;
};

/* ------------------------------------------------------------ recents -- */

const RECENT_KEY = "pergola.recent";
const RECENT_MAX = 8;

/** Boards opened lately, newest first. Per browser, like a browser's own history. */
export function readRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const ids: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Note that a board was opened. Returns the new list. */
export function pushRecent(id: string): string[] {
  const next = [id, ...readRecent().filter((x) => x !== id)].slice(0, RECENT_MAX);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Private mode or blocked storage: the list still works for this session.
  }
  return next;
}

/* ------------------------------------------------------------- covers -- */

/*
 * A board has no picture, so it gets a colour it keeps: two hues from the label
 * palette, chosen by its id. The same board is the same colour on every device
 * and for every member, which is what makes a tile recognisable at a glance.
 */
const HUES = ["#0b6e77", "#3b5fa6", "#7a4f9e", "#4c8a52", "#b08a1e", "#c2691f", "#a34734"];

export function coverFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const a = h % HUES.length;
  const b = (a + 1 + ((h >>> 8) % (HUES.length - 1))) % HUES.length;
  return `linear-gradient(135deg, ${HUES[a]} 0%, ${HUES[b]} 100%)`;
}

/* --------------------------------------------------------------- home -- */

type Props = {
  boards: BoardSummary[];
  recentIds: string[];
  /** Owner or admin of the instance: sees every board, not only their own. */
  runsTheInstance: boolean;
  onOpen: (id: string) => void;
  onCreate: () => void;
  onImport: () => void;
  onAdmin: () => void;
};

/**
 * The home page: every board this person can open, laid out to be picked from.
 *
 * Three groups. What they looked at lately, because that is nearly always what
 * they came back for; the boards they are on; and, for whoever runs the
 * instance, everything else on it — kept apart, so an admin can tell the
 * boards they work on from the ones they merely oversee.
 */
export function Home({ boards, recentIds, runsTheInstance, onOpen, onCreate, onImport, onAdmin }: Props) {
  const t = useT();
  const byId = new Map(boards.map((b) => [b.id, b]));
  const mine = boards.filter((b) => b.member);
  const others = boards.filter((b) => !b.member);
  const recent = recentIds
    .map((id) => byId.get(id))
    .filter((b): b is BoardSummary => Boolean(b))
    .slice(0, 4);

  return (
    <div className="home">
      <nav className="home-side" aria-label={t("Home")}>
        <span className="side-item on" aria-current="page">
          <Icon name="boards" />
          {t("Boards")}
        </span>
        <button className="side-item" type="button" onClick={onCreate}>
          <Icon name="plus" />
          {t("Create new board")}
        </button>
        <button className="side-item" type="button" onClick={onImport}>
          <Icon name="import" />
          {t("Import from Trello")}
        </button>
        {runsTheInstance && (
          <button className="side-item" type="button" onClick={onAdmin}>
            <Icon name="user" />
            {t("People and access")}
          </button>
        )}

        {mine.length > 0 && (
          <>
            <div className="side-group">{t("Your boards")}</div>
            {mine.map((b) => (
              <button
                key={b.id}
                className="side-board"
                type="button"
                onClick={() => onOpen(b.id)}
                title={b.title}
              >
                <i style={{ background: coverFor(b.id) }} aria-hidden="true" />
                <span>{b.title}</span>
              </button>
            ))}
          </>
        )}
      </nav>

      <main className="home-main">
        {boards.length === 0 ? (
          <div className="home-empty">
            <h2>{t("Nothing here yet")}</h2>
            <p className="muted">
              {t("Make a board and it will come with three lists and six labels to start from.")}
            </p>
            <div className="home-empty-actions">
              <button className="btn primary" type="button" onClick={onCreate}>
                {t("Create the first board")}
              </button>
              <button className="btn" type="button" onClick={onImport}>
                {t("Import from Trello")}
              </button>
            </div>
          </div>
        ) : (
          <>
            {recent.length > 0 && (
              <Section icon="clock" title={t("Recently viewed")}>
                {recent.map((b) => (
                  <Tile key={b.id} board={b} onOpen={onOpen} />
                ))}
              </Section>
            )}

            <Section icon="boards" title={t("Your boards")} count={mine.length}>
              {mine.map((b) => (
                <Tile key={b.id} board={b} onOpen={onOpen} />
              ))}
              <button className="tile create" type="button" onClick={onCreate}>
                <Icon name="plus" />
                <span>{t("Create new board")}</span>
              </button>
            </Section>

            {runsTheInstance && others.length > 0 && (
              <Section
                icon="user"
                title={t("Everything else on this instance")}
                count={others.length}
                blurb={t(
                  "You are not a member of these. As an owner or admin you can still open and run them.",
                )}
              >
                {others.map((b) => (
                  <Tile key={b.id} board={b} onOpen={onOpen} />
                ))}
              </Section>
            )}
          </>
        )}
      </main>
    </div>
  );
}

function Section({
  icon,
  title,
  count,
  blurb,
  children,
}: {
  icon: "clock" | "boards" | "user";
  title: string;
  count?: number;
  blurb?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="home-section">
      <h2>
        <Icon name={icon} />
        {title}
        {count !== undefined && <span className="muted mono">{count}</span>}
      </h2>
      {blurb && <p className="muted home-blurb">{blurb}</p>}
      <div className="tiles">{children}</div>
    </section>
  );
}

function Tile({ board, onOpen }: { board: BoardSummary; onOpen: (id: string) => void }) {
  const t = useT();
  const pl = usePlural();
  return (
    <button
      className="tile"
      type="button"
      onClick={() => onOpen(board.id)}
      aria-label={t("Open board {title}", { title: board.title })}
    >
      <span className="tile-cover" style={{ background: coverFor(board.id) }} aria-hidden="true">
        <span className="tile-beams" />
      </span>
      <span className="tile-body">
        <strong>{board.title}</strong>
        <span className="tile-meta muted">
          {board.createdBy ? t("by {name}", { name: board.createdBy }) : t("creator unknown")}
          {" · "}
          {pl(board.cardCount, "{count} card", "{count} cards")}
          {" · "}
          {pl(board.memberCount, "{count} member", "{count} members")}
        </span>
        {!board.member && <span className="badge tile-badge">{t("Admin access")}</span>}
      </span>
    </button>
  );
}
