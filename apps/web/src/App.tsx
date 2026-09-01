import { useEffect, useState } from "react";
import { Admin } from "./Admin.js";
import { Archive } from "./board/Archive.js";
import { Board, type GroupBy } from "./board/Board.js";
import { CalendarView } from "./board/CalendarView.js";
import { TableView } from "./board/TableView.js";
import { TimelineView } from "./board/TimelineView.js";
import { CardDrawer } from "./board/CardDrawer.js";
import { FilterBar } from "./board/FilterBar.js";
import { Settings } from "./board/Settings.js";
import { Notifications } from "./lib/Notifications.js";
import { Mark } from "./lib/Mark.js";
import { Palette, type Action, type Hit } from "./lib/Palette.js";
import { EMPTY, isActive, type Filter } from "./lib/filters.js";
import { authClient } from "./lib/auth.js";
import { useDialogs } from "./lib/Dialogs.js";
import { avatarColor, initials } from "./lib/labels.js";
import { useBoard } from "./lib/useBoard.js";
import { SignIn } from "./SignIn.js";
import { useT, usePlural, LanguageToggle } from "./lib/i18n.js";
import { Menu, MenuItem } from "./lib/Menu.js";
import { copyToClipboard } from "./lib/clipboard.js";

type BoardSummary = { id: string; title: string; seq: number; role: string };

export function App() {
  const t = useT();
  const { data: session, isPending } = authClient.useSession();
  if (isPending) return <div className="loading">{t("Loading…")}</div>;
  if (!session?.user) return <SignIn />;
  return (
    <Workspace
      meId={session.user.id}
      meName={session.user.name}
      // Better Auth carries our extra column through on the session user.
      meRole={(session.user as { role?: string }).role ?? "member"}
    />
  );
}

function Workspace({
  meId,
  meName,
  meRole,
}: {
  meId: string;
  meName: string;
  meRole: string;
}) {
  const t = useT();
  const pl = usePlural();
  const [boards, setBoards] = useState<BoardSummary[] | null>(null);
  const [boardId, setBoardId] = useState<string | null>(null);
  const [openCardId, setOpenCardId] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>(EMPTY);
  const [view, setView] = useState<"board" | "table" | "calendar" | "timeline">("board");
  const [groupBy, setGroupBy] = useState<GroupBy>("none");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const runsTheInstance = meRole === "owner" || meRole === "admin";
  const { ask, confirm, tell } = useDialogs();
  const { state, live, pending, error, apply, undo, refresh, dismissError } = useBoard(
    boardId,
    meId,
  );

  // A filter belongs to the board you set it on, not to the next one you open.
  useEffect(() => setFilter(EMPTY), [boardId]);

  // ⌘K is the fast path to everything, so it is global and always available.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    void (async () => {
      const rows = (await (await fetch("/api/boards")).json()) as BoardSummary[];
      setBoards(rows);
      setBoardId((current) => current ?? rows[0]?.id ?? null);
    })();
  }, []);

  const createBoard = async () => {
    const answer = await ask({
      title: t("New board"),
      description: t("It starts with three lists and six labels, ready to rename."),
      fields: [{ name: "title", label: t("Board name"), placeholder: "Roadmap" }],
      confirmLabel: t("Create board"),
    });
    const title = answer?.title?.trim();
    if (!title) return;
    const created = (await (
      await fetch("/api/boards", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title }),
      })
    ).json()) as BoardSummary;
    setBoards((prev) => [...(prev ?? []), created]);
    setBoardId(created.id);
  };

  const invite = async () => {
    if (!boardId) return;
    const answer = await ask({
      title: t("Invite someone"),
      description: t("They need an account on this instance already."),
      fields: [
        { name: "email", label: t("Email"), type: "email", placeholder: "them@example.com" },
        {
          name: "role",
          label: t("Role"),
          type: "select",
          defaultValue: "member",
          options: [
            { value: "member", label: t("Member — edits cards") },
            { value: "admin", label: t("Admin — edits the board itself") },
            { value: "observer", label: t("Observer — reads and comments") },
          ],
        },
      ],
      confirmLabel: t("Send invite"),
    });
    if (!answer) return;

    const email = (answer.email ?? "").trim().toLowerCase();
    const found = (await (
      await fetch(`/api/people?email=${encodeURIComponent(email)}`)
    ).json()) as { id: string; name: string }[];
    if (found.length === 0) {
      /*
       * The dead end this used to be: it said "ask them to sign up first", on an
       * instance where signing up without a link is exactly what is not allowed.
       * Whoever followed that advice was sent straight into "this instance is
       * invite only". So offer the thing that actually unblocks it — the link —
       * rather than naming a door that is locked.
       */
      if (!runsTheInstance) {
        await tell({
          title: t("Nobody here uses that address"),
          description: t(
            "No account on this instance matches {email}, and this instance is invite only — they cannot sign up on their own. Ask an owner or admin for an invite link to send them.",
            { email },
          ),
        });
        return;
      }

      const makeOne = await confirm({
        title: t("Nobody here uses that address"),
        description: t(
          "No account matches {email}. Create an invite link for them? They will need it to sign up, and you can add them to this board once they have.",
          { email },
        ),
        confirmLabel: t("Create invite link"),
      });
      if (!makeOne) return;

      const made = await fetch("/api/admin/invites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, role: "member" }),
      });
      if (!made.ok) {
        await tell({
          title: t("That invite was not created"),
          description: ((await made.json()) as { message?: string }).message ?? t("Please try again."),
        });
        return;
      }
      const { url } = (await made.json()) as { url: string };
      const copied = await copyToClipboard(url);
      await tell({
        title: copied ? t("Invite link copied") : t("Copy this link now"),
        description: t(
          copied
            ? "{url}\n\nCopied to your clipboard. Nothing is emailed — send it to {email} however you already talk to them. It works once, for that address only, and is not shown again."
            : "{url}\n\nCopy it now — it is not shown again. Nothing is emailed, so send it to {email} however you already talk to them. It works once, for that address only.",
          { url, email },
        ),
      });
      return;
    }

    const res = await fetch(`/api/boards/${boardId}/members`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: found[0]!.id, role: answer.role }),
    });
    if (res.ok) location.reload();
    else {
      await tell({
        title: t("That invite did not go through"),
        description: ((await res.json()) as { message?: string }).message ?? t("Please try again."),
      });
    }
  };

  /** Read a Trello export off disk and turn it into a board. */
  const importTrello = () => {
    const picker = document.createElement("input");
    picker.type = "file";
    picker.accept = "application/json,.json";
    picker.onchange = async () => {
      const file = picker.files?.[0];
      if (!file) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(await file.text());
      } catch (_err) {
        void _err;
        await tell({
          title: t("That file is not JSON"),
          description: t(
            "Export your board from Trello with Menu → More → Print and export → Export as JSON, then pick the file it saves.",
          ),
        });
        return;
      }

      // One picker, either format: a Pergola export announces itself.
      const isOurs =
        typeof parsed === "object" &&
        parsed !== null &&
        (parsed as { format?: string }).format === "pergola.board/1";

      const res = isOurs
        ? await fetch("/api/import/pergola", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ data: parsed }),
          })
        : await fetch("/api/import/trello", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(parsed),
          });
      if (!res.ok) {
        await tell({
          title: t("That import did not work"),
          description:
            ((await res.json().catch(() => ({}))) as { message?: string }).message ??
            t("The file did not look like a Trello board export."),
        });
        return;
      }

      const out = (await res.json()) as {
        boardId: string;
        title: string;
        counts: Record<string, number>;
        skipped: string[];
      };
      const { lists, cards, archived, labels, checklists, comments } = out.counts;
      void isOurs;
      await tell({
        title: t("Imported “{title}”", { title: out.title }),
        description:
          t(
            "{cards} cards across {lists} lists, with {labels} labels, {checklists} checklists and {comments} comments.",
            {
              cards: cards ?? 0,
              lists: lists ?? 0,
              labels: labels ?? 0,
              checklists: checklists ?? 0,
              comments: comments ?? 0,
            },
          ) +
          (archived
            ? pl(
                archived,
                " {count} archived card went straight to the archive.",
                " {count} archived cards went straight to the archive.",
              )
            : "") +
          (out.skipped.length ? t(" Not carried over: {skipped}.", { skipped: out.skipped.join("; ") }) : ""),
      });
      const rows = (await (await fetch("/api/boards")).json()) as BoardSummary[];
      setBoards(rows);
      setBoardId(out.boardId);
    };
    picker.click();
  };

  const archivedCount = state?.cards.filter((c) => c.archivedAt).length ?? 0;

  const paletteActions: Action[] = [
    ...(boards ?? []).map((b) => ({
      id: `board:${b.id}`,
      label: t("Open board: {title}", { title: b.title }),
      run: () => setBoardId(b.id),
    })),
    { id: "new-board", label: t("Create a board"), run: () => void createBoard() },
    { id: "import", label: t("Import a board from Trello"), run: importTrello },
    ...(boardId ? [{ id: "duplicate", label: t("Duplicate this board"), run: () => void duplicateBoard() }] : []),
    ...(boardId ? [{ id: "export", label: t("Export this board as JSON"), run: () => void exportBoard() }] : []),
    ...(boardId ? [{ id: "invite", label: t("Invite someone to this board"), run: () => void invite() }] : []),
    ...(archivedCount > 0
      ? [{ id: "archive", label: t("Open the archive ({count})", { count: archivedCount }), run: () => setArchiveOpen(true) }]
      : []),
    ...(boardId ? [{ id: "settings", label: t("Open board settings"), run: () => setSettingsOpen(true) }] : []),
    ...(runsTheInstance
      ? [{ id: "admin", label: t("Manage people and access"), run: () => setAdminOpen(true) }]
      : []),
    { id: "undo", label: t("Undo the last change"), hint: "⌘Z", run: undo },
  ];

  /** Jump to a card from search: switch board if needed, then open its drawer. */
  const goToCard = (hit: Hit) => {
    if (hit.boardId !== boardId) setBoardId(hit.boardId);
    setFilter(EMPTY);
    setOpenCardId(hit.cardId);
  };

  /**
   * Take the board away as JSON.
   *
   * Built here rather than as a plain link so the request carries the session
   * cookie and the file lands with a sensible name.
   */
  const exportBoard = async () => {
    if (!boardId || !state) return;
    const res = await fetch(`/api/boards/${boardId}/export`);
    if (!res.ok) {
      await tell({ title: t("That export did not work"), description: t("Please try again.") });
      return;
    }
    const blob = new Blob([await res.text()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${state.title.replace(/[^\w-]+/g, "-").replace(/^-|-$/g, "") || "board"}.pergola.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  /** Board duplication is how templates work here. */
  const duplicateBoard = async () => {
    if (!boardId || !state) return;
    const answer = await ask({
      title: t("Duplicate “{title}”", { title: state.title }),
      description: t(
        "Lists, labels, WIP limits and custom fields always come across. Cards are optional — leave them behind to use this board as a template.",
      ),
      fields: [
        { name: "title", label: t("New board name"), defaultValue: t("{title} copy", { title: state.title }) },
        {
          name: "withCards",
          label: t("Cards"),
          type: "select",
          defaultValue: "no",
          options: [
            { value: "no", label: t("Structure only — no cards") },
            { value: "yes", label: t("Copy the cards too") },
          ],
        },
      ],
      confirmLabel: t("Duplicate"),
    });
    const title = answer?.title?.trim();
    if (!title) return;

    const res = await fetch(`/api/boards/${boardId}/duplicate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, withCards: answer?.withCards === "yes" }),
    });
    if (!res.ok) {
      await tell({ title: t("That copy did not work"), description: t("Please try again.") });
      return;
    }
    const created = (await res.json()) as BoardSummary;
    const rows = (await (await fetch("/api/boards")).json()) as BoardSummary[];
    setBoards(rows);
    setBoardId(created.id);
  };

  const openCard = state?.cards.find((c) => c.id === openCardId) ?? null;
  // A card that someone else archived or deleted should not leave a ghost drawer.
  useEffect(() => {
    if (openCardId && state && !openCard) setOpenCardId(null);
  }, [openCardId, state, openCard]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <Mark />
          <b>Pergola</b>
        </div>

        {boards && boards.length > 0 && (
          <select
            className="btn board-select"
            value={boardId ?? ""}
            onChange={(e) => setBoardId(e.target.value)}
            aria-label={t("Board")}
          >
            {boards.map((b) => (
              <option key={b.id} value={b.id}>
                {b.title}
              </option>
            ))}
          </select>
        )}

        <button className="btn" type="button" onClick={createBoard}>
          {t("New board")}
        </button>
        <Menu label="⋯" title={t("Board actions")}>
          {(close) => (
            <>
              <MenuItem icon="↧" onClick={() => { importTrello(); close(); }}>
                {t("Import a board from Trello")}
              </MenuItem>
              {boardId && <div className="menu-sep" />}
              {boardId && (
                <MenuItem icon="⧉" onClick={() => { void duplicateBoard(); close(); }}>
                  {t("Duplicate this board")}
                </MenuItem>
              )}
              {boardId && (
                <MenuItem icon="↥" onClick={() => { void exportBoard(); close(); }}>
                  {t("Export this board as JSON")}
                </MenuItem>
              )}
              {boardId && (
                <MenuItem icon="⚙" onClick={() => { setSettingsOpen(true); close(); }}>
                  {t("Settings")}
                </MenuItem>
              )}
              {boardId && (
                <MenuItem icon="＋" onClick={() => { void invite(); close(); }}>
                  {t("Invite")}
                </MenuItem>
              )}
            </>
          )}
        </Menu>

        <div className="spacer" />

        {state && state.members.length > 0 && (
          <div className="member-strip" title={state.members.map((m) => m.name).join(", ")}>
            {state.members.slice(0, 5).map((m) => (
              <span
                key={m.id}
                className="chip avatar small"
                style={{ background: avatarColor(m.id) }}
              >
                {initials(m.name || m.email)}
              </span>
            ))}
          </div>
        )}

        <button
          className="btn"
          type="button"
          onClick={() => setPaletteOpen(true)}
          title={t("Search and commands")}
        >
          {t("Search")} <kbd>⌘K</kbd>
        </button>

        <Notifications
          names={new Map((state?.members ?? []).map((m) => [m.id, m.name || m.email]))}
          onOpen={(bId, cId) => {
            if (bId !== boardId) setBoardId(bId);
            if (cId) setOpenCardId(cId);
          }}
        />

        <button className="btn" type="button" onClick={undo} title={t("Undo (⌘Z)")}>
          {t("Undo")}
        </button>

        <div
          className={`status ${pending > 0 ? "queued" : live ? "live" : "off"}`}
          title={
            pending > 0
              ? pl(pending, "{count} change saved here, waiting to sync", "{count} changes saved here, waiting to sync")
              : live
                ? t("Live")
                : t("Reconnecting")
          }
        >
          <i />
          {pending > 0 ? t("{count} pending", { count: pending }) : live ? t("Live") : t("Offline")}
        </div>

        <LanguageToggle />

        {runsTheInstance && (
          <button
            className="btn"
            type="button"
            onClick={() => setAdminOpen(true)}
            title={t("People, invitations and who may join")}
          >
            {t("Admin")}
          </button>
        )}

        <button
          className="btn"
          type="button"
          title={meName}
          onClick={async () => {
            await authClient.signOut();
            location.reload();
          }}
        >
          {t("Sign out")}
        </button>
      </header>

      {!boards ? (
        <div className="loading">{t("Loading…")}</div>
      ) : boards.length === 0 ? (
        <div className="empty">
          <h2>{t("Nothing here yet")}</h2>
          <p>{t("Make a board and it will come with three lists and six labels to start from.")}</p>
          <button className="btn primary" type="button" onClick={createBoard}>
            {t("Create the first board")}
          </button>
        </div>
      ) : state ? (
        <>
          <div className="viewbar">
            <div className="viewtabs" role="tablist" aria-label={t("View")}>
              {(["board", "table", "calendar", "timeline"] as const).map((v) => (
                <button
                  key={v}
                  role="tab"
                  type="button"
                  aria-selected={view === v}
                  className={`viewtab${view === v ? " on" : ""}`}
                  onClick={() => setView(v)}
                >
                  {v === "board"
                    ? t("Board")
                    : v === "table"
                      ? t("Table")
                      : v === "calendar"
                        ? t("Calendar")
                        : t("Timeline")}
                </button>
              ))}
            </div>
            {view === "board" && (
              <label className="groupby">
                <span>{t("Swimlanes")}</span>
                <select
                  className="btn"
                  value={groupBy}
                  onChange={(e) => setGroupBy(e.target.value as GroupBy)}
                >
                  <option value="none">{t("Off")}</option>
                  <option value="label">{t("By label")}</option>
                  <option value="assignee">{t("By member")}</option>
                </select>
              </label>
            )}
            <span className="spacer" />
            <button
              className={`btn filter-toggle${filtersOpen ? " on" : ""}`}
              type="button"
              onClick={() => setFiltersOpen((v) => !v)}
              aria-expanded={filtersOpen}
              aria-pressed={filtersOpen}
            >
              {t("Filter")}
              {isActive(filter) && (
                <span className="fcount" aria-hidden="true">
                  •
                </span>
              )}
            </button>
          </div>
          {filtersOpen && (
            <FilterBar
              state={state}
              filter={filter}
              onChange={setFilter}
              archivedCount={archivedCount}
              onShowArchive={() => setArchiveOpen(true)}
            />
          )}
          {view === "board" && (
            <Board
              state={state}
              filter={filter}
              groupBy={groupBy}
              apply={apply}
              onOpenCard={setOpenCardId}
            />
          )}
          {view === "table" && (
            <TableView state={state} filter={filter} onOpenCard={setOpenCardId} />
          )}
          {view === "calendar" && (
            <CalendarView
              state={state}
              filter={filter}
              apply={apply}
              onOpenCard={setOpenCardId}
            />
          )}
          {view === "timeline" && (
            <TimelineView
              state={state}
              filter={filter}
              apply={apply}
              onOpenCard={setOpenCardId}
            />
          )}
        </>
      ) : (
        <div className="loading">{t("Loading board…")}</div>
      )}

      {state && openCard && (
        <CardDrawer
          state={state}
          card={openCard}
          meId={meId}
          apply={apply}
          refresh={refresh}
          onClose={() => setOpenCardId(null)}
        />
      )}

      {adminOpen && <Admin meId={meId} onClose={() => setAdminOpen(false)} />}

      {state && boardId && settingsOpen && (
        <Settings state={state} boardId={boardId} onClose={() => setSettingsOpen(false)} />
      )}

      {state && archiveOpen && (
        <Archive state={state} apply={apply} onClose={() => setArchiveOpen(false)} />
      )}

      <Palette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        actions={paletteActions}
        onPick={goToCard}
      />

      {error && (
        <div className="toast" role="status" onClick={dismissError}>
          {error}
        </div>
      )}
    </div>
  );
}
