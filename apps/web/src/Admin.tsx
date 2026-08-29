import { useEffect, useState } from "react";
import { useDialogs } from "./lib/Dialogs.js";
import { avatarColor, initials } from "./lib/labels.js";
// This sheet rides with the component rather than main.tsx: it is the only thing
// that wants these rules, and App.tsx already has to import Admin to show it.
import "./styles.admin.css";

type Props = { meId: string; onClose: () => void };

type Tab = "people" | "invites" | "boards" | "access";

/** Instance roles. Board membership uses a different, smaller set — see guard.ts. */
type Role = "owner" | "admin" | "member";

type Person = {
  id: string;
  name: string;
  email: string;
  role: Role;
  active: boolean;
  boardCount: number;
  lastSeenAt: string | null;
  createdAt: string;
};

type Invite = {
  id: string;
  email: string;
  role: Role;
  expiresAt: string;
  invitedByName: string;
  createdAt: string;
};

type BoardRow = {
  id: string;
  title: string;
  visibility: "private" | "public";
  memberCount: number;
  cardCount: number;
  ownerName: string;
  createdAt: string;
};

type SignupMode = "open" | "invite" | "domain";
type Access = { signupMode: SignupMode; allowedDomains: string[] };

const ROLES: { value: Role; label: string }[] = [
  { value: "member", label: "Member" },
  { value: "admin", label: "Admin" },
  { value: "owner", label: "Owner" },
];

/** Said the same way in the role picker and in the invite dialog. */
const ROLE_BLURB: Record<Role, string> = {
  member: "Member — works on the boards they are added to",
  admin: "Admin — that, and runs this instance",
  owner: "Owner — that, and cannot be locked out",
};

/**
 * The admin console.
 *
 * The instance is the company: there is no organisation object above it, so
 * everything here is about the box you are running — who is on it, who may get
 * on it, and what they have made with it.
 */
export function Admin({ meId, onClose }: Props) {
  const [tab, setTab] = useState<Tab>("people");
  const { ask, confirm, tell } = useDialogs();

  const [people, setPeople] = useState<Person[] | null>(null);
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [boards, setBoards] = useState<BoardRow[] | null>(null);
  const [access, setAccess] = useState<Access | null>(null);
  const [domainDraft, setDomainDraft] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector(".dialog")) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /** The server's own words, if it left any. A failure is never swallowed. */
  const complain = async (res: Response, title: string) => {
    let description = `The server returned ${res.status}.`;
    try {
      const body = (await res.json()) as { message?: unknown };
      if (typeof body.message === "string" && body.message) description = body.message;
    } catch {
      // Not JSON — the status code is the whole story.
    }
    await tell({ title, description });
  };

  /* ------------------------------------------------------------- loading -- */

  const loadPeople = async () => {
    const res = await fetch("/api/admin/people");
    if (!res.ok) {
      await complain(res, "Could not read the people on this instance");
      return;
    }
    setPeople((await res.json()) as Person[]);
  };

  const loadInvites = async () => {
    const res = await fetch("/api/admin/invites");
    if (!res.ok) {
      await complain(res, "Could not read the pending invites");
      return;
    }
    setInvites((await res.json()) as Invite[]);
  };

  const loadBoards = async () => {
    const res = await fetch("/api/admin/boards");
    if (!res.ok) {
      await complain(res, "Could not read the boards");
      return;
    }
    setBoards((await res.json()) as BoardRow[]);
  };

  const loadAccess = async () => {
    const res = await fetch("/api/admin/settings");
    if (!res.ok) {
      await complain(res, "Could not read the sign-up rules");
      return;
    }
    seedAccess((await res.json()) as Access);
  };

  /** The draft always starts from what is saved, so Save can tell them apart. */
  const seedAccess = (next: Access) => {
    setAccess(next);
    setDomainDraft(next.allowedDomains.join(", "));
  };

  // Each tab pays for itself on first visit, and only once.
  useEffect(() => {
    if (tab === "people" && !people) void loadPeople();
    if (tab === "invites" && !invites) void loadInvites();
    if (tab === "boards" && !boards) void loadBoards();
    if (tab === "access" && !access) void loadAccess();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  /* -------------------------------------------------------------- people -- */

  const patchPerson = async (p: Person, patch: { role?: Role; active?: boolean }, title: string) => {
    const res = await fetch(`/api/admin/people/${p.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      // 409 is the last-owner guard, and it explains itself better than we could.
      await complain(res, title);
      // The select is uncontrolled-looking on failure otherwise: put it back.
      await loadPeople();
      return;
    }
    await loadPeople();
  };

  const setActive = async (p: Person, active: boolean) => {
    if (!active) {
      const ok = await confirm({
        title: `Deactivate ${p.name}?`,
        description:
          "It signs them out everywhere immediately and revokes every board they are on. Nothing they wrote is deleted, and activating them again gives all of it back.",
        confirmLabel: "Deactivate",
        danger: true,
      });
      if (!ok) return;
    }
    await patchPerson(
      p,
      { active },
      active ? `${p.name} was not activated` : `${p.name} was not deactivated`,
    );
  };

  /* ------------------------------------------------------------- invites -- */

  const createInvite = async () => {
    const answer = await ask({
      title: "Invite someone",
      description:
        "This makes a one-time link. Nothing is emailed — a self-hosted box has no mail server — so you send it yourself.",
      fields: [
        { name: "email", label: "Email", type: "email", placeholder: "them@example.com" },
        {
          name: "role",
          label: "Role",
          type: "select",
          defaultValue: "member",
          options: ROLES.map((r) => ({ value: r.value, label: ROLE_BLURB[r.value] })),
        },
      ],
      confirmLabel: "Create invite",
    });
    const email = answer?.email?.trim().toLowerCase();
    if (!email) return;

    const res = await fetch("/api/admin/invites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, role: answer?.role ?? "member" }),
    });
    if (!res.ok) {
      await complain(res, "That invite was not created");
      return;
    }
    const { url, expiresAt } = (await res.json()) as {
      id: string;
      url: string;
      expiresAt: string;
    };
    await tell({
      title: "Copy this link now",
      description: `${url}\n\nIt is shown once and cannot be shown again. Send it to ${email} yourself — there is no email server on a fresh instance. It works for one sign-up and expires ${inWords(expiresAt)}.`,
    });
    await loadInvites();
  };

  const revokeInvite = async (i: Invite) => {
    const res = await fetch(`/api/admin/invites/${i.id}`, { method: "DELETE" });
    if (!res.ok) {
      await complain(res, "That invite was not revoked");
      return;
    }
    await loadInvites();
  };

  /* -------------------------------------------------------------- access -- */

  const saveAccess = async (patch: Partial<Access>) => {
    const res = await fetch("/api/admin/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      await complain(res, "The sign-up rules were not changed");
      return;
    }
    // It answers with the settings as they now stand. If that ever stops being
    // true, re-read them rather than leave the tab showing the old ones.
    const next = (await res.json().catch(() => null)) as Access | null;
    if (next) seedAccess(next);
    else await loadAccess();
  };

  /* -------------------------------------------------------------- render -- */

  const drafted = parseDomains(domainDraft);
  const domainsDirty = access !== null && drafted.join(",") !== access.allowedDomains.join(",");
  const deactivated = people?.filter((p) => !p.active).length ?? 0;
  const publicBoards = boards?.filter((b) => b.visibility === "public").length ?? 0;

  return (
    <>
      <div className="scrim" onClick={onClose} aria-hidden="true" />
      <aside className="drawer admin" role="dialog" aria-label="Instance administration">
        <header className="drawer-head">
          <strong>Admin</strong>
          <span className="drawer-crumb">Everyone and everything on this instance</span>
          <button className="icon-btn" type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="settings-tabs" role="tablist">
          {(["people", "invites", "boards", "access"] as const).map((t) => (
            <button
              key={t}
              role="tab"
              type="button"
              aria-selected={tab === t}
              className={`viewtab${tab === t ? " on" : ""}`}
              onClick={() => setTab(t)}
            >
              {t === "people"
                ? "People"
                : t === "invites"
                  ? "Invites"
                  : t === "boards"
                    ? "Boards"
                    : "Access"}
            </button>
          ))}
        </div>

        <div className="drawer-body">
          {tab === "people" && (
            <>
              <div className="section-head">
                <h3>Everyone here</h3>
                {people && (
                  <span className="muted mono tally">
                    {people.length}
                    {deactivated > 0 ? ` · ${deactivated} off` : ""}
                  </span>
                )}
              </div>
              <p className="muted">
                These are instance roles, not board roles. An owner or an admin sees this
                console; a member only ever sees the boards they are on.
              </p>
              {!people && <p className="muted">Loading…</p>}
              {people?.map((p) => {
                const isMe = p.id === meId;
                // A disabled control raises no tooltip, so the reason lives on the
                // wrapper as well as on the controls themselves.
                const why = isMe
                  ? "You cannot change your own role or deactivate yourself. Ask another owner."
                  : undefined;
                return (
                  <div key={p.id} className={`setting-row person${p.active ? "" : " is-off"}`}>
                    <span
                      className="chip avatar"
                      style={{ background: avatarColor(p.id) }}
                      aria-hidden="true"
                    >
                      {initials(p.name || p.email)}
                    </span>
                    <div className="setting-main">
                      <span className="row-name">
                        <strong>{p.name}</strong>
                        {isMe && <span className="muted">you</span>}
                        {!p.active && <span className="badge off">Deactivated</span>}
                      </span>
                      <span className="muted">{p.email}</span>
                      <span
                        className="muted mono small"
                        title={`Joined ${new Date(p.createdAt).toLocaleDateString()}`}
                      >
                        {p.boardCount} board{p.boardCount === 1 ? "" : "s"} ·{" "}
                        {p.lastSeenAt ? `seen ${ago(p.lastSeenAt)} ago` : "never signed in"}
                      </span>
                    </div>
                    <div className="setting-actions" title={why}>
                      <select
                        value={p.role}
                        disabled={isMe}
                        title={why}
                        aria-label={`Instance role for ${p.name}`}
                        onChange={(e) =>
                          void patchPerson(
                            p,
                            { role: e.target.value as Role },
                            `${p.name}'s role was not changed`,
                          )
                        }
                      >
                        {ROLES.map((r) => (
                          <option key={r.value} value={r.value} title={ROLE_BLURB[r.value]}>
                            {r.label}
                          </option>
                        ))}
                      </select>
                      <button
                        className={`linkish${p.active ? " danger" : ""}`}
                        type="button"
                        disabled={isMe}
                        title={why}
                        onClick={() => void setActive(p, !p.active)}
                      >
                        {p.active ? "Deactivate" : "Activate"}
                      </button>
                    </div>
                  </div>
                );
              })}
            </>
          )}

          {tab === "invites" && (
            <>
              <div className="section-head">
                <h3>Pending invites</h3>
                <button className="linkish" type="button" onClick={() => void createInvite()}>
                  Invite
                </button>
              </div>
              <p className="muted">
                An invite is a one-time link, good for a single sign-up. Nothing is emailed, so
                copy the link when it appears and send it however you already talk to people.
              </p>
              {!invites && <p className="muted">Loading…</p>}
              {invites?.length === 0 && <p className="muted">Nobody is waiting to join.</p>}
              {invites?.map((i) => {
                const dead = hasExpired(i.expiresAt);
                return (
                  <div key={i.id} className={`setting-row invite${dead ? " is-off" : ""}`}>
                    <div className="setting-main">
                      <span className="row-name">
                        <strong>{i.email}</strong>
                        <span className="badge">{i.role}</span>
                        {dead && <span className="badge off">Expired</span>}
                      </span>
                      <span
                        className="muted"
                        title={`Created ${new Date(i.createdAt).toLocaleString()}`}
                      >
                        {dead ? "The link no longer works" : `Expires ${inWords(i.expiresAt)}`} ·
                        invited by {i.invitedByName}
                      </span>
                    </div>
                    <button
                      className="linkish danger"
                      type="button"
                      onClick={() => void revokeInvite(i)}
                    >
                      Revoke
                    </button>
                  </div>
                );
              })}
            </>
          )}

          {tab === "boards" && (
            <>
              <div className="section-head">
                <h3>Every board</h3>
                {boards && <span className="muted mono tally">{boards.length}</span>}
              </div>
              <p className="muted">
                Every board on the instance, including the ones you are not a member of. Titles
                and counts only — this console does not open other people's cards.
              </p>
              {publicBoards > 0 && (
                <p className="admin-warn">
                  {publicBoards} of these {boards?.length ?? 0} can be read by anyone with the
                  link, without an account.
                </p>
              )}
              {!boards && <p className="muted">Loading…</p>}
              {boards?.length === 0 && <p className="muted">Nobody has made a board yet.</p>}
              {boards?.map((b) => (
                <div
                  key={b.id}
                  className={`setting-row board${b.visibility === "public" ? " is-public" : ""}`}
                >
                  <div className="setting-main">
                    <span className="row-name">
                      <strong>{b.title}</strong>
                      {b.visibility === "public" && <span className="badge public">Public</span>}
                    </span>
                    <span className="muted">{b.ownerName}</span>
                    <span className="muted mono small">
                      {b.memberCount} member{b.memberCount === 1 ? "" : "s"} · {b.cardCount} card
                      {b.cardCount === 1 ? "" : "s"} · started{" "}
                      {new Date(b.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                </div>
              ))}
            </>
          )}

          {tab === "access" && (
            <>
              <div className="section-head">
                <h3>How people get in</h3>
              </div>
              {!access && <p className="muted">Loading…</p>}
              {access && (
                <>
                  <label className="field admin-field">
                    <span>Sign-up</span>
                    <select
                      value={access.signupMode}
                      onChange={(e) =>
                        void saveAccess({ signupMode: e.target.value as SignupMode })
                      }
                    >
                      <option value="open">Anyone with the link can sign up</option>
                      <option value="invite">Invite only (recommended)</option>
                      <option value="domain">Anyone with an email at an allowed domain</option>
                    </select>
                  </label>
                  <p className="muted">
                    An instance on the public internet with open sign-up will collect strangers.
                  </p>

                  {access.signupMode === "domain" && (
                    <>
                      <label className="field admin-field">
                        <span>Allowed domains</span>
                        <input
                          value={domainDraft}
                          placeholder="acme.com, acme.co.uk"
                          onChange={(e) => setDomainDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              void saveAccess({ allowedDomains: drafted });
                            }
                          }}
                        />
                        <em className="hint">
                          Comma-separated, and only the part after the @.
                        </em>
                      </label>
                      <div className="admin-actions">
                        <button
                          className="btn primary"
                          type="button"
                          disabled={!domainsDirty}
                          onClick={() => void saveAccess({ allowedDomains: drafted })}
                        >
                          Save domains
                        </button>
                      </div>
                      {access.allowedDomains.length === 0 && (
                        <p className="bad">
                          No domains listed, so nobody can sign up at all.
                        </p>
                      )}
                    </>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </aside>
    </>
  );
}

/** Same scale as the activity feed, so "3h" means the same thing everywhere. */
function ago(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "moments";
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) return `${Math.round(mins / 60)}h`;
  return `${Math.round(mins / 1440)}d`;
}

/** "in 6 days". Invites live in hours and days, so nothing finer earns its place. */
function inWords(iso: string): string {
  const mins = Math.round((new Date(iso).getTime() - Date.now()) / 60000);
  if (mins <= 0) return "now";
  if (mins < 60) return `in ${mins} minute${mins === 1 ? "" : "s"}`;
  if (mins < 1440) {
    const hours = Math.round(mins / 60);
    return `in ${hours} hour${hours === 1 ? "" : "s"}`;
  }
  const days = Math.round(mins / 1440);
  return `in ${days} day${days === 1 ? "" : "s"}`;
}

const hasExpired = (iso: string): boolean => new Date(iso).getTime() <= Date.now();

/** Forgive "@acme.com", "ACME.com " and trailing commas — people paste lists. */
const parseDomains = (raw: string): string[] =>
  raw
    .split(",")
    .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);
