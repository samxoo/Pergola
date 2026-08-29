import { useEffect, useState } from "react";
import { Mark } from "./lib/Mark.js";

/**
 * Accepting an invitation.
 *
 * The address is fixed by the invite and shown read-only — an invite that let
 * you sign up as somebody else would not be an invite.
 */
export function Join({ token }: { token: string }) {
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
        <h2>That invitation is no longer good</h2>
        <p>It has expired or already been used. Ask whoever invited you for a fresh link.</p>
        <a className="btn" href="/">Go to the sign-in page</a>
      </div>
    );
  }

  if (!invite) return <div className="loading">Checking your invitation…</div>;

  return (
    <div className="gate">
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
                  "That did not work. Try again.",
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
          You have been invited to join as {invite.role === "member" ? "a member" : `an ${invite.role}`}.
        </p>

        <label className="field">
          <span>Email</span>
          <input value={invite.email} readOnly aria-readonly="true" />
          <em className="hint">Fixed by the invitation.</em>
        </label>

        <label className="field">
          <span>Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
            placeholder="How teammates will see you"
          />
        </label>

        <label className="field">
          <span>Password</span>
          <input
            type="password"
            required
            minLength={10}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
          />
          <em className="hint">At least 10 characters.</em>
        </label>

        {error && <div className="gate-error" role="alert">{error}</div>}

        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? "Working…" : "Join"}
        </button>
      </form>
    </div>
  );
}
