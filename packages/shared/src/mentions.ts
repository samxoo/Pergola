/**
 * @mentions in comment text.
 *
 * One definition, used on both sides: the composer inserts a handle the server
 * will recognise, and the server notifies whoever the composer meant. A handle
 * is a display name with the spaces taken out, or the local part of an email —
 * either finds the person, case does not matter, and any script will do, so a
 * Georgian name mentions as well as a Latin one.
 */

/** The handle after an "@": a letter, digit or underscore, then up to 63 more of those, dots or dashes. */
export const MENTION_RE = /@([\p{L}\p{N}_][\p{L}\p{N}_.-]{1,63})/gu;

/** A whole handle on its own, for checking one a name produced. */
const HANDLE_RE = /^[\p{L}\p{N}_][\p{L}\p{N}_.-]{1,63}$/u;

/** The handle that mentions this person — their name run together, or their address before the "@". */
export function mentionHandle(who: { name: string; email: string }): string {
  const fromName = who.name.replace(/\s+/g, "");
  if (HANDLE_RE.test(fromName)) return fromName;
  return who.email.split("@")[0] ?? "";
}

/** Every handle named in a body, lower-cased, in order of appearance, without repeats. */
export function mentionedHandles(body: string): string[] {
  return [...new Set([...body.matchAll(MENTION_RE)].map((m) => m[1]!.toLowerCase()))];
}

/** Does this handle (as typed, any case) name this person? */
export function handleNames(handle: string, who: { name: string; email: string }): boolean {
  const h = handle.toLowerCase();
  const local = who.email.split("@")[0]?.toLowerCase() ?? "";
  const name = who.name.replace(/\s+/g, "").toLowerCase();
  return h === local || (name !== "" && h === name);
}
