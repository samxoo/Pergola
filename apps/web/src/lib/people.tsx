import { createContext, useContext, useMemo } from "react";
import type { BoardState } from "@pergola/shared";

export type Person = { id: string; name: string; email: string };

type Lookup = (id: string | null | undefined) => Person | undefined;

const PeopleContext = createContext<Lookup>(() => undefined);

/**
 * Who someone is, for anyone a board names — not only its members.
 *
 * A board's history names people who are not on it: an instance admin who
 * opened it without joining and commented, a maker or author who has since
 * left. Looking names up among the members alone called all of them
 * "Someone". So the directory is the members, the names the snapshot carries
 * for everyone else, and the person signed in — who is the one most likely to
 * have just done something live, before any snapshot could name them.
 */
export function PeopleProvider({
  state,
  me,
  children,
}: {
  state: BoardState | null;
  me: Person;
  children: React.ReactNode;
}) {
  const cards = state?.cards;
  const comments = state?.comments;
  const members = state?.members;
  const lookup = useMemo<Lookup>(() => {
    const byId = new Map<string, Person>();
    for (const c of cards ?? []) {
      if (c.createdBy && c.createdByName) {
        byId.set(c.createdBy, { id: c.createdBy, name: c.createdByName, email: "" });
      }
    }
    for (const m of comments ?? []) {
      if (m.authorName) byId.set(m.authorId, { id: m.authorId, name: m.authorName, email: "" });
    }
    byId.set(me.id, me);
    // Last, so a member's current name wins over one recorded earlier.
    for (const m of members ?? []) byId.set(m.id, m);
    return (id) => (id ? byId.get(id) : undefined);
  }, [cards, comments, members, me]);

  return <PeopleContext.Provider value={lookup}>{children}</PeopleContext.Provider>;
}

/** Look a person up by id. Undefined only for someone nothing here can name. */
export const usePeople = (): Lookup => useContext(PeopleContext);

/** What to call them: their name, or their email when they never gave one. */
export const displayName = (p: Person | undefined): string | null =>
  p ? p.name || p.email || null : null;
