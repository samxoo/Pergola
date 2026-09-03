import type { MutationRecord } from "@pergola/shared";

/**
 * What an upload came back with.
 *
 * A success carries the mutation the server appended for it, so the caller can
 * feed it straight into the board the way any other confirmed change arrives —
 * no reload, and everyone else on the board gets the same record over the live
 * connection. A refusal carries the reason, and the caller decides whether that
 * is worth a dialog.
 */
export type UploadOutcome =
  | { ok: true; record: MutationRecord }
  | { ok: false; message: string };

/** Put a file on a card. */
export async function uploadToCard(cardId: string, file: File): Promise<UploadOutcome> {
  try {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(`/api/cards/${cardId}/files`, { method: "POST", body: form });
    const body = (await res.json().catch(() => ({}))) as {
      message?: string;
      mutation?: MutationRecord;
    };
    if (res.ok && body.mutation) return { ok: true, record: body.mutation };
    return { ok: false, message: body.message ?? "That file was not accepted." };
  } catch {
    return { ok: false, message: "That file could not be uploaded." };
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
