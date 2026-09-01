/**
 * Put text on the clipboard, and say whether it worked.
 *
 * The modern API is unavailable on a plain-HTTP origin — which a self-hosted
 * instance on a LAN address very often is — and can be refused outright. This
 * matters more than usual here: the one thing it copies is an invite link that
 * is shown once and cannot be shown again, so a silent failure costs somebody
 * their invitation. Hence the old execCommand path behind it, and a boolean
 * rather than a promise that resolves whatever happened.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Denied, or no permission on this origin. Fall through and try the old way.
  }

  try {
    const scratch = document.createElement("textarea");
    scratch.value = text;
    // Off-screen rather than hidden: a display:none element cannot be selected.
    scratch.style.cssText = "position:fixed;top:-1000px;opacity:0";
    document.body.appendChild(scratch);
    scratch.select();
    const ok = document.execCommand("copy");
    scratch.remove();
    return ok;
  } catch {
    return false;
  }
}
