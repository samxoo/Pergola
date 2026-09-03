import { authClient } from "./lib/auth.js";
import { Mark } from "./lib/Mark.js";
import { useT, LanguageToggle } from "./lib/i18n.js";

/**
 * The notice a banned person sees.
 *
 * It replaces the whole app rather than sitting on top of it, so there is
 * nothing behind it to reach and nothing to close: no × , no Escape, no
 * clicking the backdrop. The one way out is to sign out — and signing back in
 * lands here again, for as long as the ban stands.
 */
export function Banned({ reason }: { reason: string }) {
  const t = useT();
  return (
    <div className="gate banned" role="alertdialog" aria-modal="true" aria-labelledby="banned-title">
      <LanguageToggle className="gate-lang" />
      <div className="gate-card">
        <div className="gate-brand">
          <Mark size={30} />
          <b>Pergola</b>
        </div>
        <h1 id="banned-title" className="banned-title">
          {t("Your account is banned")}
        </h1>
        <p className="banned-reason">{reason}</p>
        <p className="gate-lede banned-lede">
          {t(
            "An owner or admin of this instance banned your account. This notice stays until they lift it; nothing you made has been deleted.",
          )}
        </p>
        <button
          className="btn"
          type="button"
          onClick={async () => {
            await authClient.signOut();
            location.reload();
          }}
        >
          {t("Sign out")}
        </button>
      </div>
    </div>
  );
}
