import { useState } from "react";
import { Mark } from "./lib/Mark.js";
import { authClient } from "./lib/auth.js";

/**
 * The first screen anyone sees on a fresh instance.
 *
 * Email and password only. A self-hosted box should not require registering an
 * OAuth app before its owner can get in.
 */
export function SignIn() {
  const [mode, setMode] = useState<"in" | "up">("in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res =
        mode === "up"
          ? await authClient.signUp.email({ email, password, name: name.trim() || email.split("@")[0]! })
          : await authClient.signIn.email({ email, password });
      if (res.error) {
        setError(res.error.message ?? "That did not work. Check the details and try again.");
        return;
      }
      // The session cookie is set; App re-renders on the session change.
      location.reload();
    } catch {
      setError("Could not reach the server. Is it running?");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gate">
      <form className="gate-card" onSubmit={submit}>
        <div className="gate-brand">
          <Mark size={30} />
          <b>Pergola</b>
        </div>
        <p className="gate-lede">
          {mode === "up"
            ? "Create the first account on this instance."
            : "Sign in to your boards."}
        </p>

        {mode === "up" && (
          <label className="field">
            <span>Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
              placeholder="How teammates will see you"
            />
          </label>
        )}

        <label className="field">
          <span>Email</span>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
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
            autoComplete={mode === "up" ? "new-password" : "current-password"}
          />
          {mode === "up" && <em className="hint">At least 10 characters.</em>}
        </label>

        {error && (
          <div className="gate-error" role="alert">
            {error}
          </div>
        )}

        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? "Working…" : mode === "up" ? "Create account" : "Sign in"}
        </button>

        <button
          className="linkish"
          type="button"
          onClick={() => {
            setMode(mode === "in" ? "up" : "in");
            setError(null);
          }}
        >
          {mode === "in" ? "Create an account instead" : "I already have an account"}
        </button>
      </form>
    </div>
  );
}
