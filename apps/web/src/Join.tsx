import { useEffect, useState } from "react";
import { Mark } from "./lib/Mark.js";
import { useT, LanguageToggle } from "./lib/i18n.js";

/**
 * Accepting an invitation.
 *
 * The address is fixed by the invite and shown read-only — an invite that let
 * you sign up as somebody else would not be an invite.
 */
export function Join({ token }: { token: string }) {
  const t = useT();
  const [invite, setInvite] = useState<{ email: string; role: string } | null>(null);
  const [dead, setDead] = useState(false);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      const res = await fetch(`/api/invites/${encodeURIComponent(token)}`);
      if (!res.ok) return setDead(true);
      setInvite((await res.json()) as { email: string; role: string });
    })();
  }, [token]);

  if (dead) {
    return (
      <div className="empty">
        <h2>{t("That invitation is no longer good")}</h2>
        <p>{t("It has expired or already been used. Ask whoever invited you for a fresh link.")}</p>
        <a className="btn" href="/">{t("Go to the sign-in page")}</a>
      </div>
    );
  }

  if (!invite) return <div className="loading">{t("Checking your invitation…")}</div>;

  const roleWord = invite.role === "member" ? t("a member") : t(`an ${invite.role}`);

  return (
    <div className="gate">
      <LanguageToggle className="gate-lang" />
      <form
        className="gate-card"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          setBusy(true);
          try {
            const res = await fetch(`/api/invites/${encodeURIComponent(token)}/accept`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ name: name.trim() || invite.email.split("@")[0], password }),
            });
            if (!res.ok) {
              setError(
                ((await res.json().catch(() => ({}))) as { message?: string }).message ??
                  t("That did not work. Try again."),
              );
              return;
            }
            location.href = "/";
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="gate-brand">
          <Mark size={30} />
          <b>Pergola</b>
        </div>
        <p className="gate-lede">
          {t("You have been invited to join as {role}.", { role: roleWord })}
        </p>

        <label className="field">
          <span>{t("Email")}</span>
          <input value={invite.email} readOnly aria-readonly="true" />
          <em className="hint">{t("Fixed by the invitation.")}</em>
        </label>

        <label className="field">
          <span>{t("Name")}</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
            placeholder={t("How teammates will see you")}
          />
        </label>

        <label className="field">
          <span>{t("Password")}</span>
          <input
            type="password"
            required
            minLength={10}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
          />
          <em className="hint">{t("At least 10 characters.")}</em>
        </label>

        {error && <div className="gate-error" role="alert">{error}</div>}

        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? t("Working…") : t("Join")}
        </button>
      </form>
    </div>
  );
}
