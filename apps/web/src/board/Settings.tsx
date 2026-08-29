import { useEffect, useState } from "react";
import { describeRule, type Action, type BoardState, type Rule, type Trigger } from "@pergola/shared";
import { useDialogs } from "../lib/Dialogs.js";
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
  const [tab, setTab] = useState<Tab>("activity");
  const { ask, confirm, tell } = useDialogs();

  const [rules, setRules] = useState<Rule[] | null>(null);
  const [hooks, setHooks] = useState<Hook[] | null>(null);
  const [tokens, setTokens] = useState<Token[] | null>(null);
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
      title: "New rule",
      description: "When something happens on this board, do something about it.",
      fields: [
        { name: "name", label: "Name", placeholder: "Ship it" },
        {
          name: "on",
          label: "When",
          type: "select",
          defaultValue: "checklist.completed",
          options: [
            { value: "checklist.completed", label: "every checklist item is ticked" },
            { value: "card.created", label: "a card is added" },
            { value: "card.moved", label: "a card moves" },
            { value: "card.labeled", label: "a label is added" },
          ],
        },
        {
          name: "action",
          label: "Then",
          type: "select",
          defaultValue: "move",
          options: [
            { value: "move", label: "move it to a list" },
            { value: "archive", label: "archive it" },
            { value: "setDue", label: "set a due date" },
            { value: "comment", label: "post a comment" },
          ],
        },
        {
          name: "target",
          label: "List",
          type: "select",
          required: false,
          defaultValue: listOptions[0]?.value ?? "",
          options: listOptions,
          hint: "Used by “move to a list”.",
        },
      ],
      confirmLabel: "Create rule",
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
      await tell({ title: "That rule was not accepted", description: "Check the fields and try again." });
      return;
    }
    await loadRules();
  };

  /* ---------------------------------------------------------- webhooks -- */

  const addHook = async () => {
    const answer = await ask({
      title: "Add a webhook",
      description: "Every change on this board is POSTed here, signed so you can verify it.",
      fields: [{ name: "url", label: "Endpoint URL", placeholder: "https://example.com/hooks/pergola" }],
      confirmLabel: "Add webhook",
    });
    const url = answer?.url?.trim();
    if (!url) return;
    const res = await fetch(`/api/boards/${boardId}/webhooks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
    });
    if (!res.ok) {
      await tell({ title: "That endpoint was not accepted", description: "It needs to be a full URL." });
      return;
    }
    const { secret } = (await res.json()) as { secret: string };
    await tell({
      title: "Copy the signing secret now",
      description: `${secret}\n\nIt is stored hashed and cannot be shown again. Verify deliveries with HMAC-SHA256 over "timestamp.body", using the x-pergola-timestamp and x-pergola-signature headers.`,
    });
    await loadHooks();
  };

  /* ------------------------------------------------------------ tokens -- */

  const addToken = async () => {
    const answer = await ask({
      title: "New API token",
      description: "Send it as an Authorization: Bearer header to use the whole API from a script.",
      fields: [{ name: "name", label: "What is it for?", placeholder: "CI" }],
      confirmLabel: "Create token",
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
      title: "Copy this token now",
      description: `${token}\n\nOnly its hash is stored, so this is the one time it can be shown.`,
    });
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
      <aside className="drawer" role="dialog" aria-label="Board settings">
        <header className="drawer-head">
          <strong>Settings</strong>
          <span className="drawer-crumb">{state.title}</span>
          <button className="icon-btn" type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="settings-tabs" role="tablist">
          {(["activity", "automation", "webhooks", "share", "tokens"] as const).map((t) => (
            <button
              key={t}
              role="tab"
              type="button"
              aria-selected={tab === t}
              className={`viewtab${tab === t ? " on" : ""}`}
              onClick={() => setTab(t)}
            >
              {t === "activity"
                ? "Activity"
                : t === "automation"
                  ? "Automation"
                  : t === "webhooks"
                    ? "Webhooks"
                    : t === "share"
                      ? "Share"
                      : "Tokens"}
            </button>
          ))}
        </div>

        <div className="drawer-body">
          {tab === "activity" && (
            <>
              <div className="section-head">
                <h3>Everything that has happened</h3>
              </div>
              <p className="muted">
                Read straight from the mutation log, so it cannot disagree with the board.
              </p>
              <Activity boardId={boardId} cursor={state.seq} />
            </>
          )}

          {tab === "automation" && (
            <>
              <div className="section-head">
                <h3>Rules</h3>
                <button className="linkish" type="button" onClick={addRule}>
                  Add
                </button>
              </div>
              {!rules && <p className="muted">Loading…</p>}
              {rules?.length === 0 && (
                <p className="muted">
                  No rules yet. A rule watches for something happening and does something about it —
                  the sort of thing Trello meters and calls Butler.
                </p>
              )}
              {rules?.map((r) => (
                <div key={r.id} className="setting-row">
                  <div className="setting-main">
                    <strong>{r.name}</strong>
                    <span className="muted">{describeRule(r)}</span>
                    <span className="muted mono">
                      fired {r.fireCount} time{r.fireCount === 1 ? "" : "s"}
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
                      <span>{r.enabled ? "On" : "Off"}</span>
                    </label>
                    <button
                      className="linkish danger"
                      type="button"
                      onClick={async () => {
                        if (
                          await confirm({
                            title: `Delete “${r.name}”?`,
                            confirmLabel: "Delete rule",
                            danger: true,
                          })
                        ) {
                          await fetch(`/api/boards/${boardId}/rules/${r.id}`, { method: "DELETE" });
                          await loadRules();
                        }
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </>
          )}

          {tab === "webhooks" && (
            <>
              <div className="section-head">
                <h3>Endpoints</h3>
                <button className="linkish" type="button" onClick={addHook}>
                  Add
                </button>
              </div>
              {!hooks && <p className="muted">Loading…</p>}
              {hooks?.length === 0 && (
                <p className="muted">
                  Nothing subscribed. A webhook receives every change on this board as JSON, signed
                  with its own secret.
                </p>
              )}
              {hooks?.map((h) => (
                <div key={h.id} className="setting-row">
                  <div className="setting-main">
                    <strong className="mono small">{h.url}</strong>
                    <span className={h.lastError ? "muted bad" : "muted"}>
                      {h.lastFiredAt
                        ? h.lastError
                          ? `Last delivery failed: ${h.lastError}`
                          : `Last delivery OK (${h.lastStatus})`
                        : "Not fired yet"}
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
                    Remove
                  </button>
                </div>
              ))}
            </>
          )}

          {tab === "share" && (
            <>
              <div className="section-head">
                <h3>Public link</h3>
              </div>
              <p className="muted">
                A public board is readable by anyone with the link, without an account. Members and
                comment threads are never included — a visitor sees the work, not the people.
              </p>
              <div className="setting-row">
                <div className="setting-main">
                  <strong>{visibility === "public" ? "Anyone with the link" : "Members only"}</strong>
                  {visibility === "public" && <span className="mono small">{publicLink}</span>}
                </div>
                <button
                  className="btn"
                  type="button"
                  onClick={() => setVisible(visibility === "public" ? "private" : "public")}
                >
                  {visibility === "public" ? "Make private" : "Publish"}
                </button>
              </div>
              {visibility === null && (
                <p className="muted">Publish to generate the link, or leave the board private.</p>
              )}
            </>
          )}

          {tab === "tokens" && (
            <>
              <div className="section-head">
                <h3>Your API tokens</h3>
                <button className="linkish" type="button" onClick={addToken}>
                  Add
                </button>
              </div>
              <p className="muted">
                Tokens belong to you, not to a board, and reach every board you are a member of.
              </p>
              {!tokens && <p className="muted">Loading…</p>}
              {tokens?.map((t) => (
                <div key={t.id} className="setting-row">
                  <div className="setting-main">
                    <strong>{t.name}</strong>
                    <span className="muted">
                      {t.lastUsedAt
                        ? `Last used ${new Date(t.lastUsedAt).toLocaleDateString()}`
                        : "Never used"}
                    </span>
                  </div>
                  <button
                    className="linkish danger"
                    type="button"
                    onClick={async () => {
                      await fetch(`/api/tokens/${t.id}`, { method: "DELETE" });
                      await loadTokens();
                    }}
                  >
                    Revoke
                  </button>
                </div>
              ))}
            </>
          )}
        </div>
      </aside>
    </>
  );
}
