import { useEffect, useState } from "react";
import { useDialogs } from "./lib/Dialogs.js";
import { avatarColor, initials } from "./lib/labels.js";
import { useT, usePlural, useDateLocale } from "./lib/i18n.js";
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

type T = (key: string, params?: Record<string, string | number>) => string;
type PL = (count: number, one: string, many: string, params?: Record<string, string | number>) => string;

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
  const t = useT();
  const pl = usePlural();
  const locale = useDateLocale();
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
    let description = t("The server returned {status}.", { status: res.status });
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
      await complain(res, t("Could not read the people on this instance"));
      return;
    }
    setPeople((await res.json()) as Person[]);
  };

  const loadInvites = async () => {
    const res = await fetch("/api/admin/invites");
    if (!res.ok) {
      await complain(res, t("Could not read the pending invites"));
      return;
    }
    setInvites((await res.json()) as Invite[]);
  };

  const loadBoards = async () => {
    const res = await fetch("/api/admin/boards");
    if (!res.ok) {
      await complain(res, t("Could not read the boards"));
      return;
    }
    setBoards((await res.json()) as BoardRow[]);
  };

  const loadAccess = async () => {
    const res = await fetch("/api/admin/settings");
    if (!res.ok) {
      await complain(res, t("Could not read the sign-up rules"));
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
        title: t("Deactivate {name}?", { name: p.name }),
        description: t(
          "It signs them out everywhere immediately and revokes every board they are on. Nothing they wrote is deleted, and activating them again gives all of it back.",
        ),
        confirmLabel: t("Deactivate"),
        danger: true,
      });
      if (!ok) return;
    }
    await patchPerson(
      p,
      { active },
      active
        ? t("{name} was not activated", { name: p.name })
        : t("{name} was not deactivated", { name: p.name }),
    );
  };

  /* ------------------------------------------------------------- invites -- */

  const createInvite = async () => {
    const answer = await ask({
      title: t("Invite someone"),
      description: t(
        "This makes a one-time link. Nothing is emailed — a self-hosted box has no mail server — so you send it yourself.",
      ),
      fields: [
        { name: "email", label: t("Email"), type: "email", placeholder: "them@example.com" },
        {
          name: "role",
          label: t("Role"),
          type: "select",
          defaultValue: "member",
          options: ROLES.map((r) => ({ value: r.value, label: t(ROLE_BLURB[r.value]) })),
        },
      ],
      confirmLabel: t("Create invite"),
    });
    const email = answer?.email?.trim().toLowerCase();
    if (!email) return;

    const res = await fetch("/api/admin/invites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, role: answer?.role ?? "member" }),
    });
    if (!res.ok) {
      await complain(res, t("That invite was not created"));
      return;
    }
    const { url, expiresAt } = (await res.json()) as {
      id: string;
      url: string;
      expiresAt: string;
    };
    await tell({
      title: t("Copy this link now"),
      description: t(
        "{url}\n\nIt is shown once and cannot be shown again. Send it to {email} yourself — there is no email server on a fresh instance. It works for one sign-up and expires {when}.",
        { url, email, when: inWords(expiresAt, t, pl) },
      ),
    });
    await loadInvites();
  };

  const revokeInvite = async (i: Invite) => {
    const res = await fetch(`/api/admin/invites/${i.id}`, { method: "DELETE" });
    if (!res.ok) {
      await complain(res, t("That invite was not revoked"));
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
      await complain(res, t("The sign-up rules were not changed"));
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
      <aside className="drawer admin" role="dialog" aria-label={t("Instance administration")}>
        <header className="drawer-head">
          <strong>{t("Admin")}</strong>
          <span className="drawer-crumb">{t("Everyone and everything on this instance")}</span>
          <button className="icon-btn" type="button" onClick={onClose} aria-label={t("Close")}>
            ×
          </button>
        </header>

        <div className="settings-tabs" role="tablist">
          {(["people", "invites", "boards", "access"] as const).map((tb) => (
            <button
              key={tb}
              role="tab"
              type="button"
              aria-selected={tab === tb}
              className={`viewtab${tab === tb ? " on" : ""}`}
              onClick={() => setTab(tb)}
            >
              {tb === "people"
                ? t("People")
                : tb === "invites"
                  ? t("Invites")
                  : tb === "boards"
                    ? t("Boards")
                    : t("Access")}
            </button>
          ))}
        </div>

        <div className="drawer-body">
          {tab === "people" && (
            <>
              <div className="section-head">
                <h3>{t("Everyone here")}</h3>
                {people && (
                  <span className="muted mono tally">
                    {people.length}
                    {deactivated > 0 ? ` · ${t("{count} off", { count: deactivated })}` : ""}
                  </span>
                )}
              </div>
              <p className="muted">
                {t(
                  "These are instance roles, not board roles. An owner or an admin sees this console; a member only ever sees the boards they are on.",
                )}
              </p>
              {!people && <p className="muted">{t("Loading…")}</p>}
              {people?.map((p) => {
                const isMe = p.id === meId;
                // A disabled control raises no tooltip, so the reason lives on the
                // wrapper as well as on the controls themselves.
                const why = isMe
                  ? t("You cannot change your own role or deactivate yourself. Ask another owner.")
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
                        {isMe && <span className="muted">{t("you")}</span>}
                        {!p.active && <span className="badge off">{t("Deactivated")}</span>}
                      </span>
                      <span className="muted">{p.email}</span>
                      <span
                        className="muted mono small"
                        title={t("Joined {date}", {
                          date: new Date(p.createdAt).toLocaleDateString(locale),
                        })}
                      >
                        {pl(p.boardCount, "{count} board", "{count} boards")} ·{" "}
                        {p.lastSeenAt
                          ? t("seen {ago} ago", { ago: ago(p.lastSeenAt, t) })
                          : t("never signed in")}
                      </span>
                    </div>
                    <div className="setting-actions" title={why}>
                      <select
                        value={p.role}
                        disabled={isMe}
                        title={why}
                        aria-label={t("Instance role for {name}", { name: p.name })}
                        onChange={(e) =>
                          void patchPerson(
                            p,
                            { role: e.target.value as Role },
                            t("{name}'s role was not changed", { name: p.name }),
                          )
                        }
                      >
                        {ROLES.map((r) => (
                          <option key={r.value} value={r.value} title={t(ROLE_BLURB[r.value])}>
                            {t(r.label)}
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
                        {p.active ? t("Deactivate") : t("Activate")}
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
                <h3>{t("Pending invites")}</h3>
                <button className="linkish" type="button" onClick={() => void createInvite()}>
                  {t("Invite")}
                </button>
              </div>
              <p className="muted">
                {t(
                  "An invite is a one-time link, good for a single sign-up. Nothing is emailed, so copy the link when it appears and send it however you already talk to people.",
                )}
              </p>
              {!invites && <p className="muted">{t("Loading…")}</p>}
              {invites?.length === 0 && <p className="muted">{t("Nobody is waiting to join.")}</p>}
              {invites?.map((i) => {
                const dead = hasExpired(i.expiresAt);
                return (
                  <div key={i.id} className={`setting-row invite${dead ? " is-off" : ""}`}>
                    <div className="setting-main">
                      <span className="row-name">
                        <strong>{i.email}</strong>
                        <span className="badge">{t(i.role)}</span>
                        {dead && <span className="badge off">{t("Expired")}</span>}
                      </span>
                      <span
                        className="muted"
                        title={t("Created {date}", {
                          date: new Date(i.createdAt).toLocaleString(locale),
                        })}
                      >
                        {dead
                          ? t("The link no longer works")
                          : t("Expires {when}", { when: inWords(i.expiresAt, t, pl) })}{" "}
                        · {t("invited by {name}", { name: i.invitedByName })}
                      </span>
                    </div>
                    <button
                      className="linkish danger"
                      type="button"
                      onClick={() => void revokeInvite(i)}
                    >
                      {t("Revoke")}
                    </button>
                  </div>
                );
              })}
            </>
          )}

          {tab === "boards" && (
            <>
              <div className="section-head">
                <h3>{t("Every board")}</h3>
                {boards && <span className="muted mono tally">{boards.length}</span>}
              </div>
              <p className="muted">
                {t(
                  "Every board on the instance, including the ones you are not a member of. Titles and counts only — this console does not open other people's cards.",
                )}
              </p>
              {publicBoards > 0 && (
                <p className="admin-warn">
                  {t("{count} of these {total} can be read by anyone with the link, without an account.", {
                    count: publicBoards,
                    total: boards?.length ?? 0,
                  })}
                </p>
              )}
              {!boards && <p className="muted">{t("Loading…")}</p>}
              {boards?.length === 0 && <p className="muted">{t("Nobody has made a board yet.")}</p>}
              {boards?.map((b) => (
                <div
                  key={b.id}
                  className={`setting-row board${b.visibility === "public" ? " is-public" : ""}`}
                >
                  <div className="setting-main">
                    <span className="row-name">
                      <strong>{b.title}</strong>
                      {b.visibility === "public" && <span className="badge public">{t("Public")}</span>}
                    </span>
                    <span className="muted">{b.ownerName}</span>
                    <span className="muted mono small">
                      {pl(b.memberCount, "{count} member", "{count} members")} ·{" "}
                      {pl(b.cardCount, "{count} card", "{count} cards")} ·{" "}
                      {t("started {date}", {
                        date: new Date(b.createdAt).toLocaleDateString(locale),
                      })}
                    </span>
                  </div>
                </div>
              ))}
            </>
          )}

          {tab === "access" && (
            <>
              <div className="section-head">
                <h3>{t("How people get in")}</h3>
              </div>
              {!access && <p className="muted">{t("Loading…")}</p>}
              {access && (
                <>
                  <label className="field admin-field">
                    <span>{t("Sign-up")}</span>
                    <select
                      value={access.signupMode}
                      onChange={(e) =>
                        void saveAccess({ signupMode: e.target.value as SignupMode })
                      }
                    >
                      <option value="open">{t("Anyone with the link can sign up")}</option>
                      <option value="invite">{t("Invite only (recommended)")}</option>
                      <option value="domain">{t("Anyone with an email at an allowed domain")}</option>
                    </select>
                  </label>
                  <p className="muted">
                    {t("An instance on the public internet with open sign-up will collect strangers.")}
                  </p>

                  {access.signupMode === "domain" && (
                    <>
                      <label className="field admin-field">
                        <span>{t("Allowed domains")}</span>
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
                          {t("Comma-separated, and only the part after the @.")}
                        </em>
                      </label>
                      <div className="admin-actions">
                        <button
                          className="btn primary"
                          type="button"
                          disabled={!domainsDirty}
                          onClick={() => void saveAccess({ allowedDomains: drafted })}
                        >
                          {t("Save domains")}
                        </button>
                      </div>
                      {access.allowedDomains.length === 0 && (
                        <p className="bad">
                          {t("No domains listed, so nobody can sign up at all.")}
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
function ago(iso: string, t: T): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return t("moments");
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) return `${Math.round(mins / 60)}h`;
  return `${Math.round(mins / 1440)}d`;
}

/** "in 6 days". Invites live in hours and days, so nothing finer earns its place. */
function inWords(iso: string, t: T, pl: PL): string {
  const mins = Math.round((new Date(iso).getTime() - Date.now()) / 60000);
  if (mins <= 0) return t("now");
  if (mins < 60) return pl(mins, "in {count} minute", "in {count} minutes");
  if (mins < 1440) {
    const hours = Math.round(mins / 60);
    return pl(hours, "in {count} hour", "in {count} hours");
  }
  const days = Math.round(mins / 1440);
  return pl(days, "in {count} day", "in {count} days");
}

const hasExpired = (iso: string): boolean => new Date(iso).getTime() <= Date.now();

/** Forgive "@acme.com", "ACME.com " and trailing commas — people paste lists. */
const parseDomains = (raw: string): string[] =>
  raw
    .split(",")
    .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);
