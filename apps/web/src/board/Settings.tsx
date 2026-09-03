import { useEffect, useState } from "react";
import { describeRule, type Action, type BoardState, type Rule, type Trigger } from "@pergola/shared";
import { useDialogs } from "../lib/Dialogs.js";
import { ConnectAI } from "./ConnectAI.js";
import { useT, usePlural, useDateLocale } from "../lib/i18n.js";
import { Activity } from "./Activity.js";

type Props = {
  state: BoardState;
  boardId: string;
  onClose: () => void;
};

type Tab = "activity" | "automation" | "webhooks" | "share" | "tokens";

type Hook = {
  id: string;
  url: string;
  active: boolean;
  lastStatus: number | null;
  lastError: string | null;
  lastFiredAt: string | null;
};

type Token = { id: string; name: string; lastUsedAt: string | null; createdAt: string };

export function Settings({ state, boardId, onClose }: Props) {
  const t = useT();
  const pl = usePlural();
  const locale = useDateLocale();
  const [tab, setTab] = useState<Tab>("activity");
  const { ask, confirm, tell } = useDialogs();

  const [rules, setRules] = useState<Rule[] | null>(null);
  const [hooks, setHooks] = useState<Hook[] | null>(null);
  const [tokens, setTokens] = useState<Token[] | null>(null);
  /** A freshly minted token, while the set-up dialog for an assistant is open. */
  const [connecting, setConnecting] = useState<string | null>(null);
  const [visibility, setVisibility] = useState<"private" | "public" | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector(".dialog")) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const loadRules = async () =>
    setRules((await (await fetch(`/api/boards/${boardId}/rules`)).json()) as Rule[]);
  const loadHooks = async () =>
    setHooks((await (await fetch(`/api/boards/${boardId}/webhooks`)).json()) as Hook[]);
  const loadTokens = async () =>
    setTokens((await (await fetch("/api/tokens")).json()) as Token[]);

  useEffect(() => {
    if (tab === "automation" && !rules) void loadRules();
    if (tab === "webhooks" && !hooks) void loadHooks();
    if (tab === "tokens" && !tokens) void loadTokens();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  /* ------------------------------------------------------------- rules -- */

  const addRule = async () => {
    const listOptions = state.lists.map((l) => ({ value: l.id, label: l.title }));
    const answer = await ask({
      title: t("New rule"),
      description: t("When something happens on this board, do something about it."),
      fields: [
        { name: "name", label: t("Name"), placeholder: "Ship it" },
        {
          name: "on",
          label: t("When"),
          type: "select",
          defaultValue: "checklist.completed",
          options: [
            { value: "checklist.completed", label: t("every checklist item is ticked") },
            { value: "card.created", label: t("a card is added") },
            { value: "card.moved", label: t("a card moves") },
            { value: "card.labeled", label: t("a label is added") },
          ],
        },
        {
          name: "action",
          label: t("Then"),
          type: "select",
          defaultValue: "move",
          options: [
            { value: "move", label: t("move it to a list") },
            { value: "archive", label: t("archive it") },
            { value: "setDue", label: t("set a due date") },
            { value: "comment", label: t("post a comment") },
          ],
        },
        {
          name: "target",
          label: t("List"),
          type: "select",
          required: false,
          defaultValue: listOptions[0]?.value ?? "",
          options: listOptions,
          hint: t("Used by “move to a list”."),
        },
      ],
      confirmLabel: t("Create rule"),
    });
    if (!answer?.name?.trim()) return;

    const trigger = { on: answer.on, listId: null, toListId: null, labelId: null } as unknown as Trigger;
    const action: Action =
      answer.action === "move"
        ? { do: "move", toListId: answer.target! }
        : answer.action === "archive"
          ? { do: "archive" }
          : answer.action === "setDue"
            ? { do: "setDue", inDays: 3 }
            : { do: "comment", body: "Handled automatically." };

    const res = await fetch(`/api/boards/${boardId}/rules`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: answer.name.trim(), enabled: true, trigger, actions: [action] }),
    });
    if (!res.ok) {
      await tell({ title: t("That rule was not accepted"), description: t("Check the fields and try again.") });
      return;
    }
    await loadRules();
  };

  /* ---------------------------------------------------------- webhooks -- */

  const addHook = async () => {
    const answer = await ask({
      title: t("Add a webhook"),
      description: t("Every change on this board is POSTed here, signed so you can verify it."),
      fields: [{ name: "url", label: t("Endpoint URL"), placeholder: "https://example.com/hooks/pergola" }],
      confirmLabel: t("Add webhook"),
    });
    const url = answer?.url?.trim();
    if (!url) return;
    const res = await fetch(`/api/boards/${boardId}/webhooks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
    });
    if (!res.ok) {
      await tell({ title: t("That endpoint was not accepted"), description: t("It needs to be a full URL.") });
      return;
    }
    const { secret } = (await res.json()) as { secret: string };
    await tell({
      title: t("Copy the signing secret now"),
      description: t(
        "{secret}\n\nIt is stored hashed and cannot be shown again. Verify deliveries with HMAC-SHA256 over \"timestamp.body\", using the x-pergola-timestamp and x-pergola-signature headers.",
        { secret },
      ),
    });
    await loadHooks();
  };

  /* ------------------------------------------------------------ tokens -- */

  const addToken = async () => {
    const answer = await ask({
      title: t("New API token"),
      description: t("Send it as an Authorization: Bearer header to use the whole API from a script."),
      fields: [{ name: "name", label: t("What is it for?"), placeholder: "CI" }],
      confirmLabel: t("Create token"),
    });
    const name = answer?.name?.trim();
    if (!name) return;
    const res = await fetch("/api/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, expiresInDays: null }),
    });
    const { token } = (await res.json()) as { token: string };
    await tell({
      title: t("Copy this token now"),
      description: t("{token}\n\nOnly its hash is stored, so this is the one time it can be shown.", { token }),
    });
    await loadTokens();
  };

  /**
   * An assistant gets a token of its own, named for what it is, so it shows up
   * in the list as one — and can be revoked on its own, without touching a
   * script's.
   */
  const connectAssistant = async () => {
    const res = await fetch("/api/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: t("AI assistant"), expiresInDays: null }),
    });
    if (!res.ok) {
      await tell({ title: t("That token was not created"), description: t("Please try again.") });
      return;
    }
    const { token } = (await res.json()) as { token: string };
    setConnecting(token);
    await loadTokens();
  };

  /* ------------------------------------------------------------- share -- */

  const publicLink = `${location.origin}/p/${boardId}`;
  const setVisible = async (next: "private" | "public") => {
    const res = await fetch(`/api/boards/${boardId}/visibility`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ visibility: next }),
    });
    if (res.ok) setVisibility(next);
  };

  return (
    <>
      <div className="scrim" onClick={onClose} aria-hidden="true" />
      <aside className="drawer" role="dialog" aria-label={t("Board settings")}>
        <header className="drawer-head">
          <strong>{t("Settings")}</strong>
          <span className="drawer-crumb">{state.title}</span>
          <button className="icon-btn" type="button" onClick={onClose} aria-label={t("Close")}>
            ×
          </button>
        </header>

        <div className="settings-tabs" role="tablist">
          {(["activity", "automation", "webhooks", "share", "tokens"] as const).map((tb) => (
            <button
              key={tb}
              role="tab"
              type="button"
              aria-selected={tab === tb}
              className={`viewtab${tab === tb ? " on" : ""}`}
              onClick={() => setTab(tb)}
            >
              {tb === "activity"
                ? t("Activity")
                : tb === "automation"
                  ? t("Automation")
                  : tb === "webhooks"
                    ? t("Webhooks")
                    : tb === "share"
                      ? t("Share")
                      : t("Tokens")}
            </button>
          ))}
        </div>

        <div className="drawer-body">
          {tab === "activity" && (
            <>
              <div className="section-head">
                <h3>{t("Everything that has happened")}</h3>
              </div>
              <p className="muted">
                {t("Read straight from the mutation log, so it cannot disagree with the board.")}
              </p>
              <Activity boardId={boardId} cursor={state.seq} />
            </>
          )}

          {tab === "automation" && (
            <>
              <div className="section-head">
                <h3>{t("Rules")}</h3>
                <button className="linkish" type="button" onClick={addRule}>
                  {t("Add")}
                </button>
              </div>
              {!rules && <p className="muted">{t("Loading…")}</p>}
              {rules?.length === 0 && (
                <p className="muted">
                  {t(
                    "No rules yet. A rule watches for something happening and does something about it — the sort of thing Trello meters and calls Butler.",
                  )}
                </p>
              )}
              {rules?.map((r) => (
                <div key={r.id} className="setting-row">
                  <div className="setting-main">
                    <strong>{r.name}</strong>
                    <span className="muted">{describeRule(r)}</span>
                    <span className="muted mono">
                      {pl(r.fireCount, "fired {count} time", "fired {count} times")}
                    </span>
                  </div>
                  <div className="setting-actions">
                    <label className="toggle">
                      <input
                        type="checkbox"
                        checked={r.enabled}
                        onChange={async (e) => {
                          await fetch(`/api/boards/${boardId}/rules/${r.id}`, {
                            method: "PATCH",
                            headers: { "content-type": "application/json" },
                            body: JSON.stringify({ enabled: e.target.checked }),
                          });
                          await loadRules();
                        }}
                      />
                      <span>{r.enabled ? t("On") : t("Off")}</span>
                    </label>
                    <button
                      className="linkish danger"
                      type="button"
                      onClick={async () => {
                        if (
                          await confirm({
                            title: t("Delete “{name}”?", { name: r.name }),
                            confirmLabel: t("Delete rule"),
                            danger: true,
                          })
                        ) {
                          await fetch(`/api/boards/${boardId}/rules/${r.id}`, { method: "DELETE" });
                          await loadRules();
                        }
                      }}
                    >
                      {t("Delete")}
                    </button>
                  </div>
                </div>
              ))}
            </>
          )}

          {tab === "webhooks" && (
            <>
              <div className="section-head">
                <h3>{t("Endpoints")}</h3>
                <button className="linkish" type="button" onClick={addHook}>
                  {t("Add")}
                </button>
              </div>
              {!hooks && <p className="muted">{t("Loading…")}</p>}
              {hooks?.length === 0 && (
                <p className="muted">
                  {t(
                    "Nothing subscribed. A webhook receives every change on this board as JSON, signed with its own secret.",
                  )}
                </p>
              )}
              {hooks?.map((h) => (
                <div key={h.id} className="setting-row">
                  <div className="setting-main">
                    <strong className="mono small">{h.url}</strong>
                    <span className={h.lastError ? "muted bad" : "muted"}>
                      {h.lastFiredAt
                        ? h.lastError
                          ? t("Last delivery failed: {error}", { error: h.lastError })
                          : t("Last delivery OK ({status})", { status: h.lastStatus ?? "" })
                        : t("Not fired yet")}
                    </span>
                  </div>
                  <button
                    className="linkish danger"
                    type="button"
                    onClick={async () => {
                      await fetch(`/api/boards/${boardId}/webhooks/${h.id}`, { method: "DELETE" });
                      await loadHooks();
                    }}
                  >
                    {t("Remove")}
                  </button>
                </div>
              ))}
            </>
          )}

          {tab === "share" && (
            <>
              <div className="section-head">
                <h3>{t("Public link")}</h3>
              </div>
              <p className="muted">
                {t(
                  "A public board is readable by anyone with the link, without an account. Members and comment threads are never included — a visitor sees the work, not the people.",
                )}
              </p>
              <div className="setting-row">
                <div className="setting-main">
                  <strong>{visibility === "public" ? t("Anyone with the link") : t("Members only")}</strong>
                  {visibility === "public" && <span className="mono small">{publicLink}</span>}
                </div>
                <button
                  className="btn"
                  type="button"
                  onClick={() => setVisible(visibility === "public" ? "private" : "public")}
                >
                  {visibility === "public" ? t("Make private") : t("Publish")}
                </button>
              </div>
              {visibility === null && (
                <p className="muted">{t("Publish to generate the link, or leave the board private.")}</p>
              )}
            </>
          )}

          {tab === "tokens" && (
            <>
              <div className="section-head">
                <h3>{t("AI assistants")}</h3>
                <button className="linkish" type="button" onClick={() => void connectAssistant()}>
                  {t("Connect")}
                </button>
              </div>
              <p className="muted">
                {t(
                  "Claude Code, Cursor, VS Code and any other MCP client can read your boards and work the cards on them — as you, with your access. One click or one command to set up.",
                )}
              </p>

              <div className="section-head">
                <h3>{t("Your API tokens")}</h3>
                <button className="linkish" type="button" onClick={addToken}>
                  {t("Add")}
                </button>
              </div>
              <p className="muted">
                {t("Tokens belong to you, not to a board, and reach every board you are a member of.")}
              </p>
              {!tokens && <p className="muted">{t("Loading…")}</p>}
              {tokens?.map((tk) => (
                <div key={tk.id} className="setting-row">
                  <div className="setting-main">
                    <strong>{tk.name}</strong>
                    <span className="muted">
                      {tk.lastUsedAt
                        ? t("Last used {date}", {
                            date: new Date(tk.lastUsedAt).toLocaleDateString(locale),
                          })
                        : t("Never used")}
                    </span>
                  </div>
                  <button
                    className="linkish danger"
                    type="button"
                    onClick={async () => {
                      await fetch(`/api/tokens/${tk.id}`, { method: "DELETE" });
                      await loadTokens();
                    }}
                  >
                    {t("Revoke")}
                  </button>
                </div>
              ))}
            </>
          )}
        </div>
      </aside>
      {connecting && <ConnectAI token={connecting} onClose={() => setConnecting(null)} />}
    </>
  );
}
