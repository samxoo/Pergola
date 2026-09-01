/**
 * Put a file on a card.
 *
 * The server writes the attachment row itself rather than it arriving as a
 * mutation, so whatever calls this reloads the board afterwards. Returns the
 * reason it was refused, or null when it worked — a caller in the middle of
 * another action (creating a card, say) needs to decide for itself whether that
 * is worth a dialog.
 */
export async function uploadToCard(cardId: string, file: File): Promise<string | null> {
  try {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(`/api/cards/${cardId}/files`, { method: "POST", body: form });
    if (res.ok) return null;
    const { message } = (await res.json().catch(() => ({}))) as { message?: string };
    return message ?? "That file was not accepted.";
  } catch {
    return "That file could not be uploaded.";
  }
}

/** Every file a paste or a drop carried, image or not. */
export function filesFrom(source: DataTransfer | null): File[] {
  if (!source) return [];
  const fromItems = [...source.items]
    .filter((i) => i.kind === "file")
    .map((i) => i.getAsFile())
    .filter((f): f is File => f !== null);
  return fromItems.length > 0 ? fromItems : [...source.files];
}
