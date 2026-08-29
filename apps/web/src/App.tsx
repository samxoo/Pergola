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
import { EMPTY, type Filter } from "./lib/filters.js";
import { authClient } from "./lib/auth.js";
import { useDialogs } from "./lib/Dialogs.js";
import { avatarColor, initials } from "./lib/labels.js";
import { useBoard } from "./lib/useBoard.js";
import { SignIn } from "./SignIn.js";

type BoardSummary = { id: string; title: string; seq: number; role: string };

export function App() {
  const { data: session, isPending } = authClient.useSession();
  if (isPending) return <div className="loading">Loading…</div>;
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
  const runsTheInstance = meRole === "owner" || meRole === "admin";
  const { ask, tell } = useDialogs();
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
      title: "New board",
      description: "It starts with three lists and six labels, ready to rename.",
      fields: [{ name: "title", label: "Board name", placeholder: "Roadmap" }],
      confirmLabel: "Create board",
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
      title: "Invite someone",
      description: "They need an account on this instance already.",
      fields: [
        { name: "email", label: "Email", type: "email", placeholder: "them@example.com" },
        {
          name: "role",
          label: "Role",
          type: "select",
          defaultValue: "member",
          options: [
            { value: "member", label: "Member — edits cards" },
            { value: "admin", label: "Admin — edits the board itself" },
            { value: "observer", label: "Observer — reads and comments" },
          ],
        },
      ],
      confirmLabel: "Send invite",
    });
    if (!answer) return;

    const email = (answer.email ?? "").trim().toLowerCase();
    const found = (await (
      await fetch(`/api/people?email=${encodeURIComponent(email)}`)
    ).json()) as { id: string; name: string }[];
    if (found.length === 0) {
      // Say what to do about it rather than just reporting the absence.
      await tell({
        title: "Nobody here uses that address",
        description: `No account on this instance matches ${email}. Ask them to sign up first, then invite them.`,
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
        title: "That invite did not go through",
        description: ((await res.json()) as { message?: string }).message ?? "Please try again.",
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
          title: "That file is not JSON",
          description:
            "Export your board from Trello with Menu → More → Print and export → Export as JSON, then pick the file it saves.",
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
          title: "That import did not work",
          description:
            ((await res.json().catch(() => ({}))) as { message?: string }).message ??
            "The file did not look like a Trello board export.",
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
        title: `Imported “${out.title}”`,
        description:
          `${cards} cards across ${lists} lists, with ${labels} labels, ${checklists} checklists and ${comments} comments.` +
          (archived ? ` ${archived} archived card${archived === 1 ? "" : "s"} went straight to the archive.` : "") +
          (out.skipped.length ? ` Not carried over: ${out.skipped.join("; ")}.` : ""),
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
      label: `Open board: ${b.title}`,
      run: () => setBoardId(b.id),
    })),
    { id: "new-board", label: "Create a board", run: () => void createBoard() },
    { id: "import", label: "Import a board from Trello", run: importTrello },
    ...(boardId ? [{ id: "duplicate", label: "Duplicate this board", run: () => void duplicateBoard() }] : []),
    ...(boardId ? [{ id: "export", label: "Export this board as JSON", run: () => void exportBoard() }] : []),
    ...(boardId ? [{ id: "invite", label: "Invite someone to this board", run: () => void invite() }] : []),
    ...(archivedCount > 0
      ? [{ id: "archive", label: `Open the archive (${archivedCount})`, run: () => setArchiveOpen(true) }]
      : []),
    ...(boardId ? [{ id: "settings", label: "Open board settings", run: () => setSettingsOpen(true) }] : []),
    ...(runsTheInstance
      ? [{ id: "admin", label: "Manage people and access", run: () => setAdminOpen(true) }]
      : []),
    { id: "undo", label: "Undo the last change", hint: "⌘Z", run: undo },
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
      await tell({ title: "That export did not work", description: "Please try again." });
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
      title: `Duplicate “${state.title}”`,
      description:
        "Lists, labels, WIP limits and custom fields always come across. Cards are optional — leave them behind to use this board as a template.",
      fields: [
        { name: "title", label: "New board name", defaultValue: `${state.title} copy` },
        {
          name: "withCards",
          label: "Cards",
          type: "select",
          defaultValue: "no",
          options: [
            { value: "no", label: "Structure only — no cards" },
            { value: "yes", label: "Copy the cards too" },
          ],
        },
      ],
      confirmLabel: "Duplicate",
    });
    const title = answer?.title?.trim();
    if (!title) return;

    const res = await fetch(`/api/boards/${boardId}/duplicate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, withCards: answer?.withCards === "yes" }),
    });
    if (!res.ok) {
      await tell({ title: "That copy did not work", description: "Please try again." });
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
            aria-label="Board"
          >
            {boards.map((b) => (
              <option key={b.id} value={b.id}>
                {b.title}
              </option>
            ))}
          </select>
        )}

        <button className="btn" type="button" onClick={createBoard}>
          New board
        </button>
        <button className="btn" type="button" onClick={importTrello} title="Import a Trello JSON export">
          Import
        </button>
        {boardId && (
          <button className="btn" type="button" onClick={duplicateBoard} title="Copy this board, with or without its cards">
            Duplicate
          </button>
        )}
        {boardId && (
          <button className="btn" type="button" onClick={exportBoard} title="Download this board as JSON">
            Export
          </button>
        )}
        {boardId && (
          <button className="btn" type="button" onClick={() => setSettingsOpen(true)} title="Automation, webhooks, sharing and tokens">
            Settings
          </button>
        )}
        {boardId && (
          <button className="btn" type="button" onClick={invite}>
            Invite
          </button>
        )}

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
          title="Search and commands"
        >
          Search <kbd>⌘K</kbd>
        </button>

        <Notifications
          names={new Map((state?.members ?? []).map((m) => [m.id, m.name || m.email]))}
          onOpen={(bId, cId) => {
            if (bId !== boardId) setBoardId(bId);
            if (cId) setOpenCardId(cId);
          }}
        />

        <button className="btn" type="button" onClick={undo} title="Undo (⌘Z)">
          Undo
        </button>

        <div
          className={`status ${pending > 0 ? "queued" : live ? "live" : "off"}`}
          title={
            pending > 0
              ? `${pending} change${pending === 1 ? "" : "s"} saved here, waiting to sync`
              : live
                ? "Live"
                : "Reconnecting"
          }
        >
          <i />
          {pending > 0 ? `${pending} pending` : live ? "Live" : "Offline"}
        </div>

        {runsTheInstance && (
          <button
            className="btn"
            type="button"
            onClick={() => setAdminOpen(true)}
            title="People, invitations and who may join"
          >
            Admin
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
          Sign out
        </button>
      </header>

      {!boards ? (
        <div className="loading">Loading…</div>
      ) : boards.length === 0 ? (
        <div className="empty">
          <h2>Nothing here yet</h2>
          <p>Make a board and it will come with three lists and six labels to start from.</p>
          <button className="btn primary" type="button" onClick={createBoard}>
            Create the first board
          </button>
        </div>
      ) : state ? (
        <>
          <div className="viewbar">
            <div className="viewtabs" role="tablist" aria-label="View">
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
                    ? "Board"
                    : v === "table"
                      ? "Table"
                      : v === "calendar"
                        ? "Calendar"
                        : "Timeline"}
                </button>
              ))}
            </div>
            {view === "board" && (
              <label className="groupby">
                <span>Swimlanes</span>
                <select
                  className="btn"
                  value={groupBy}
                  onChange={(e) => setGroupBy(e.target.value as GroupBy)}
                >
                  <option value="none">Off</option>
                  <option value="label">By label</option>
                  <option value="assignee">By member</option>
                </select>
              </label>
            )}
          </div>
          <FilterBar
            state={state}
            filter={filter}
            onChange={setFilter}
            archivedCount={archivedCount}
            onShowArchive={() => setArchiveOpen(true)}
          />
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
        <div className="loading">Loading board…</div>
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
