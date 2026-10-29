import { authClient } from "./auth.js";
import { useDialogs } from "./Dialogs.js";
import { useT } from "./i18n.js";

/**
 * Change your own password.
 *
 * Asks for the current one first. Better Auth insists, and it should: a
 * session left open on someone else's machine is not the same as knowing the
 * password. Every other device is signed out; this one stays in.
 */
export function useChangePassword(): () => Promise<void> {
  const t = useT();
  const { ask, tell } = useDialogs();
  return async () => {
    const answer = await ask({
      title: t("Change your password"),
      description: t("Every other device you are signed in on is signed out. This one stays in."),
      fields: [
        {
          name: "current",
          label: t("Current password"),
          type: "password",
          autoComplete: "current-password",
        },
        {
          name: "next",
          label: t("New password"),
          type: "password",
          autoComplete: "new-password",
          minLength: 10,
          hint: t("At least 10 characters."),
        },
      ],
      confirmLabel: t("Change password"),
    });
    if (!answer) return;

    const { error } = await authClient.changePassword({
      currentPassword: answer.current ?? "",
      newPassword: answer.next ?? "",
      revokeOtherSessions: true,
    });
    if (error) {
      await tell({
        title: t("Your password was not changed"),
        description:
          error.code === "INVALID_PASSWORD"
            ? t("The current password is not right.")
            : (error.message ?? t("Please try again.")),
      });
      return;
    }
    await tell({
      title: t("Password changed"),
      description: t("Use the new one the next time you sign in."),
    });
  };
}
