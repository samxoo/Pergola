import type { MutationEnvelope } from "@pergola/shared";

/**
 * The offline queue.
 *
 * This is where the mutation log pays for itself. A queued mutation carries its
 * own client-generated id, so replaying it is a no-op if the server already has
 * it — which means we can retry indiscriminately on reconnect without checking
 * what landed and what did not.
 *
 * localStorage rather than IndexedDB: the queue is a handful of small JSON
 * objects, and a synchronous read on startup is worth more than the capacity.
 * Every access is guarded, because private windows and blocked site data both
 * make these throw rather than return empty.
 */
const key = (boardId: string) => `pergola:queue:${boardId}`;

export function readQueue(boardId: string): MutationEnvelope[] {
  try {
    const raw = localStorage.getItem(key(boardId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as MutationEnvelope[]) : [];
  } catch {
    return [];
  }
}

function write(boardId: string, items: MutationEnvelope[]): void {
  try {
    if (items.length === 0) localStorage.removeItem(key(boardId));
    else localStorage.setItem(key(boardId), JSON.stringify(items));
  } catch {
    // Out of quota or storage blocked. The mutation is still applied locally;
    // it simply will not survive a reload. Better than losing the interaction.
  }
}

export function enqueue(boardId: string, envelope: MutationEnvelope): number {
  const items = readQueue(boardId);
  items.push(envelope);
  write(boardId, items);
  return items.length;
}

export function dequeue(boardId: string, id: string): void {
  write(
    boardId,
    readQueue(boardId).filter((m) => m.id !== id),
  );
}

export function clearQueue(boardId: string): void {
  write(boardId, []);
}
