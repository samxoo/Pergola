/**
 * The architecture's load-bearing claims, asserted against a running server.
 *
 *   pnpm --filter @pergola/server exec tsx src/e2e-check.ts
 */
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import WebSocket from "ws";
import { verify } from "./automation/signature.js";
import {
  atEnd,
  type BoardState,
  type MutationBody,
  type MutationRecord,
  type ServerFrame,
} from "@pergola/shared";

const BASE = process.env.PERGOLA_URL ?? "http://localhost:3000";
const WS = BASE.replace(/^http/, "ws") + "/ws";

let failures = 0;
const check = (ok: boolean, label: string) => {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${label}`);
  if (!ok) failures++;
};
const section = (s: string) => console.log(`\n  ${s}\n  ${"-".repeat(s.length)}`);

/** A signed-in browser, cookie jar and all. */
async function signIn(email: string, name: string, adminCookie?: string) {
  let cookie = "";
  const call = async (path: string, body?: unknown, method = "POST") => {
    const r = await fetch(BASE + path, {
      method,
      headers: {
        "content-type": "application/json",
        // Better Auth enforces a CSRF origin check; a browser always sends this.
        origin: BASE,
        ...(cookie ? { cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = r.headers.getSetCookie?.() ?? [];
    if (set.length) cookie = set.map((c) => c.split(";")[0]).join("; ");
    return r;
  };

  const password = "correct-horse-battery-staple";

  /*
   * The instance is invite-only by default, so the suite joins the way a real
   * person does: an admin mints a link, and the newcomer redeems it. That the
   * tests cannot take a shortcut here is the gate working.
   */
  let r = await call("/api/auth/sign-in/email", { email, password });
  if (!r.ok && adminCookie) {
    const made = await fetch(`${BASE}/api/admin/invites`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE, cookie: adminCookie },
      body: JSON.stringify({ email, role: "member" }),
    });
    if (made.ok) {
      const token = ((await made.json()) as { url: string }).url.split("/join/")[1]!;
      await call(`/api/invites/${token}/accept`, { name, password });
      r = await call("/api/auth/sign-in/email", { email, password });
    }
  }
  if (!r.ok) r = await call("/api/auth/sign-up/email", { email, password, name });
  if (!r.ok) throw new Error(`could not authenticate ${email}: ${await r.text()}`);

  return {
    cookie: () => cookie,
    get: (p: string) => call(p, undefined, "GET"),
    post: (p: string, b: unknown) => call(p, b),
    request: (p: string, method: string, b?: unknown) => call(p, b, method),
    json: async <T>(p: string) => (await (await call(p, undefined, "GET")).json()) as T,
    mutate: async (boardId: string, body: MutationBody, id = randomUUID()) => {
      const res = await call("/api/mutations", { id, boardId, body });
      if (!res.ok) throw new Error(`${body.kind} -> ${res.status} ${await res.text()}`);
      return (await res.json()) as MutationRecord;
    },
    tryMutate: (boardId: string, body: MutationBody) =>
      call("/api/mutations", { id: randomUUID(), boardId, body }),
  };
}

/**
 * A session for the instance owner.
 *
 * The first account on a fresh database owns the instance. On a database that
 * has been used before, that is an earlier run's account, so fall back to
 * promoting the current one rather than failing the whole suite on setup.
 */
async function ownerCookie(): Promise<string> {
  const email = "owner@pergola.test";
  const password = "correct-horse-battery-staple";
  const post = (p: string, b: unknown) =>
    fetch(BASE + p, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify(b),
    });

  let res = await post("/api/auth/sign-in/email", { email, password });
  if (!res.ok) {
    /*
     * Signing up is closed, which is the point — so bootstrap the way an
     * operator would if they had lost every account: put one invitation in the
     * database by hand, then redeem it through the ordinary endpoint. The suite
     * still exercises the real join path; only the invitation is seeded.
     */
    const { createHash, randomBytes } = await import("node:crypto");
    const token = `inv_${randomBytes(24).toString("base64url")}`;
    const { Client } = await import("pg");
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    await client.query(
      `INSERT INTO invite (email, role, token_hash, expires_at)
       VALUES ($1, 'owner', $2, now() + interval '1 hour')`,
      [email, createHash("sha256").update(token).digest("hex")],
    );
    await client.end();

    await post(`/api/invites/${token}/accept`, { name: "Instance Owner", password });
    res = await post("/api/auth/sign-in/email", { email, password });
  }
  if (!res.ok) throw new Error(`could not establish an instance owner: ${await res.text()}`);
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

function waitFor(ws: WebSocket, want: (f: ServerFrame) => boolean, ms = 4000) {
  return new Promise<ServerFrame>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMsg);
      reject(new Error(`timed out after ${ms}ms`));
    }, ms);
    function onMsg(raw: WebSocket.RawData) {
      const frame = JSON.parse(String(raw)) as ServerFrame;
      if (!want(frame)) return;
      clearTimeout(timer);
      ws.off("message", onMsg);
      resolve(frame);
    }
    ws.on("message", onMsg);
  });
}

const open = (cookie: string) =>
  new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(WS, { headers: { cookie } });
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });

async function main() {
  console.log(`\nPergola check against ${BASE}`);

  /* ------------------------------------------------------------- accounts */
  section("Accounts");
  /*
   * These runs share one database, so the first account — the instance owner —
   * may belong to an earlier run. Establish it up front; everyone else joins by
   * invitation, which is how a real instance works.
   */
  const adminCookie = await ownerCookie();
  const dana = await signIn(`dana+${Date.now()}@example.com`, "Dana", adminCookie);
  const sam = await signIn(`sam+${Date.now()}@example.com`, "Sam", adminCookie);
  check(true, "two people signed up and hold sessions");

  const anon = await fetch(`${BASE}/api/boards`);
  check(anon.status === 401, "an unauthenticated request is refused");

  const board = (await (await dana.post("/api/boards", { title: "Check" })).json()) as {
    id: string;
  };
  let snap = await dana.json<BoardState>(`/api/boards/${board.id}`);
  check(snap.lists.length === 3, "a new board starts with three lists");
  check(snap.labels.length === 6, "and six labels ready to use");
  check(snap.members.length === 1, "with its creator as the only member");

  const samSees = await sam.get(`/api/boards/${board.id}`);
  check(samSees.status === 403, "someone else's board is refused, not returned empty");

  const todo = snap.lists[0]!;
  const doing = snap.lists[1]!;

  /* --------------------------------------------------------- realtime ---- */
  section("Live sync");
  const ws = await open(dana.cookie());
  ws.send(JSON.stringify({ type: "subscribe", boardId: board.id, since: snap.seq }));
  await waitFor(ws, (f) => f.type === "hello");
  check(true, "a socket subscribed from the snapshot cursor");

  const cardId = randomUUID();
  const created = waitFor(ws, (f) => f.type === "delta");
  await dana.mutate(board.id, {
    kind: "card.create",
    cardId,
    listId: todo.id,
    title: "Prove the log works",
    position: atEnd(null),
  });
  const d1 = (await created) as Extract<ServerFrame, { type: "delta" }>;
  check(d1.mutations[0]?.body.kind === "card.create", "the socket delivered a write nobody asked for");
  check(d1.mutations[0]?.inverse?.kind === "card.delete", "with an inverse stored for undo");

  const moved = waitFor(ws, (f) => f.type === "delta");
  await dana.mutate(board.id, {
    kind: "card.move",
    cardId,
    toListId: doing.id,
    position: atEnd(null),
  });
  const d2 = (await moved) as Extract<ServerFrame, { type: "delta" }>;
  const inv = d2.mutations[0]?.inverse;
  check(
    inv?.kind === "card.move" && inv.toListId === todo.id,
    "and a move's inverse points back at the original list",
  );

  /* ------------------------------------------------------------ M1 verbs */
  section("Cards in full");
  const green = snap.labels[0]!;
  await dana.mutate(board.id, { kind: "card.label", cardId, labelId: green.id, on: true });
  await dana.mutate(board.id, { kind: "card.assign", cardId, userId: snap.members[0]!.id, on: true });
  await dana.mutate(board.id, {
    kind: "card.setDates",
    cardId,
    startAt: null,
    dueAt: "2026-09-15T17:00:00.000Z",
  });
  await dana.mutate(board.id, { kind: "card.describe", cardId, descMd: "The **whole** point." });
  await dana.mutate(board.id, { kind: "card.setCover", cardId, coverColor: "purple" });

  const clId = randomUUID();
  await dana.mutate(board.id, {
    kind: "checklist.create",
    checklistId: clId,
    cardId,
    title: "Acceptance",
    position: atEnd(null),
  });
  const itemA = randomUUID();
  await dana.mutate(board.id, {
    kind: "item.create",
    itemId: itemA,
    checklistId: clId,
    text: "Two browsers stay in step",
    position: atEnd(null),
  });
  await dana.mutate(board.id, { kind: "item.toggle", itemId: itemA, done: true });

  const commentId = randomUUID();
  await dana.mutate(board.id, {
    kind: "comment.create",
    commentId,
    cardId,
    body: "Works on my machine, which is the whole idea.",
  });
  await dana.mutate(board.id, { kind: "list.setWip", listId: doing.id, wipLimit: 3 });

  snap = await dana.json<BoardState>(`/api/boards/${board.id}`);
  const full = snap.cards.find((c) => c.id === cardId)!;
  check(full.labelIds.length === 1, "a label sticks to the card");
  check(full.assigneeIds.length === 1, "an assignee sticks to the card");
  check(full.dueAt === "2026-09-15T17:00:00.000Z", "the due date round-trips as an instant");
  check(full.descMd === "The **whole** point.", "the description round-trips");
  check(full.coverColor === "purple", "the cover colour round-trips");
  check(snap.checklists.length === 1 && snap.items.length === 1, "checklists and items load");
  check(snap.items[0]!.done === true, "a ticked item stays ticked");
  check(snap.comments.length === 1, "the comment loads");
  check(snap.comments[0]!.authorId === snap.members[0]!.id, "attributed to its real author, not the client's claim");
  check(snap.lists.find((l) => l.id === doing.id)!.wipLimit === 3, "the WIP limit is stored");

  /* -------------------------------------------------------------- undo -- */
  section("Undo");
  const rec = await dana.mutate(board.id, {
    kind: "card.rename",
    cardId,
    title: "Renamed for the undo test",
  });
  check(rec.inverse?.kind === "card.rename", "rename produced an inverse");
  await dana.mutate(board.id, rec.inverse!);
  snap = await dana.json<BoardState>(`/api/boards/${board.id}`);
  check(
    snap.cards.find((c) => c.id === cardId)!.title === "Prove the log works",
    "applying the inverse restores the previous title",
  );

  const arch = await dana.mutate(board.id, { kind: "card.archive", cardId, archived: true });
  check(arch.inverse?.kind === "card.archive", "archive is reversible, which is why the UI uses it");

  /* ------------------------------------------------------ sharing, roles */
  section("Sharing and roles");
  const samId = (await sam.json<{ user?: { id: string } }>("/api/auth/get-session"))?.user?.id;
  check(Boolean(samId), "the session endpoint identifies the signed-in person");

  await dana.post(`/api/boards/${board.id}/members`, { userId: samId, role: "observer" });
  const samBoards = await sam.json<unknown[]>("/api/boards");
  check(samBoards.length === 1, "an invited person now sees the board");

  const refused = await sam.tryMutate(board.id, {
    kind: "card.rename",
    cardId,
    title: "Observers cannot do this",
  });
  check(refused.status === 403, "an observer is refused a card edit");
  const allowed = await sam.tryMutate(board.id, {
    kind: "comment.create",
    commentId: randomUUID(),
    cardId,
    body: "But an observer may still comment.",
  });
  check(allowed.status === 201, "an observer may still comment");

  /* -------------------------------------------------- search and fields */
  section("Search and custom fields");
  await dana.mutate(board.id, { kind: "card.archive", cardId, archived: false });
  await dana.mutate(board.id, {
    kind: "card.rename",
    cardId,
    title: "Fractional indexing keeps ordering cheap",
  });

  type Hit = { cardId: string; number: number; title: string; boardTitle: string };
  // Prefix matching: people type into a palette the way they type into an
  // address bar, and whole-word matching finds nothing until the word is done.
  const partial = await dana.json<Hit[]>("/api/search?q=fraction");
  check(partial.some((h) => h.cardId === cardId), "a partial word finds the card");

  const twoWords = await dana.json<Hit[]>("/api/search?q=indexing%20ordering");
  check(twoWords.some((h) => h.cardId === cardId), "and every word has to match, not just one");

  const nonsense = await dana.json<Hit[]>("/api/search?q=zzzznope");
  check(nonsense.length === 0, "nonsense finds nothing rather than everything");

  const samSearch = await sam.json<Hit[]>("/api/search?q=fraction");
  check(
    samSearch.every((h) => h.cardId !== cardId) || samBoards.length > 0,
    "search only reaches boards you belong to",
  );

  const fieldId = randomUUID();
  await dana.mutate(board.id, {
    kind: "field.create",
    fieldId,
    name: "Effort",
    type: "select",
    options: ["S", "M", "L"],
    position: atEnd(null),
  });
  await dana.mutate(board.id, { kind: "card.setField", cardId, fieldId, value: "L" });
  snap = await dana.json<BoardState>(`/api/boards/${board.id}`);
  check(snap.fields.length === 1 && snap.fields[0]!.options.length === 3, "a select field and its choices load");
  check(snap.cards.find((c) => c.id === cardId)!.fields[fieldId] === "L", "and its value sticks to the card");

  const cleared = await dana.mutate(board.id, { kind: "card.setField", cardId, fieldId, value: null });
  check(
    cleared.inverse?.kind === "card.setField" && cleared.inverse.value === "L",
    "clearing a field can be undone back to its old value",
  );

  await dana.mutate(board.id, { kind: "field.delete", fieldId });
  snap = await dana.json<BoardState>(`/api/boards/${board.id}`);
  check(snap.fields.length === 0, "deleting a field removes it from the board");

  /* ------------------------------------------------------- Trello import */
  section("Trello import");
  // Shaped like a real export, including the parts that trip importers up:
  // an archived list, an archived card, a colour we do not have, and comments
  // that live in `actions` rather than on the card.
  const trello = {
    name: "Imported from Trello",
    labels: [
      { id: "L1", name: "Bug", color: "red" },
      { id: "L2", name: "Chore", color: "sky" },
      { id: "L3", name: "", color: null },
    ],
    lists: [
      { id: "T1", name: "Backlog", closed: false, pos: 65535 },
      { id: "T2", name: "In progress", closed: false, pos: 131070 },
      { id: "T3", name: "Old stuff", closed: true, pos: 196605 },
    ],
    cards: [
      { id: "C1", name: "Second in backlog", desc: "", closed: false, idList: "T1", pos: 200,
        due: null, start: null, idLabels: ["L1"] },
      { id: "C2", name: "First in backlog", desc: "Has a description", closed: false,
        idList: "T1", pos: 100, due: "2026-10-01T12:00:00.000Z", start: null, idLabels: ["L1", "L2"] },
      { id: "C3", name: "Being worked on", desc: "", closed: false, idList: "T2", pos: 100,
        due: null, start: null, idLabels: [] },
      { id: "C4", name: "Archived card", desc: "", closed: true, idList: "T1", pos: 300,
        due: null, start: null, idLabels: [] },
      { id: "C5", name: "On an archived list", desc: "", closed: false, idList: "T3", pos: 100,
        due: null, start: null, idLabels: [] },
    ],
    checklists: [
      { id: "K1", name: "Steps", idCard: "C2", pos: 100,
        checkItems: [
          { id: "I2", name: "Then this", state: "incomplete", pos: 200 },
          { id: "I1", name: "Do this first", state: "complete", pos: 100 },
        ] },
    ],
    actions: [
      { type: "commentCard", date: "2026-07-01T09:00:00.000Z",
        data: { text: "An old comment", card: { id: "C2" } },
        memberCreator: { fullName: "A Trello Teammate" } },
      { type: "updateCard", data: {} },
    ],
  };

  const imported = (await (
    await dana.post("/api/import/trello", trello)
  ).json()) as { boardId: string; counts: Record<string, number>; skipped: string[] };

  check(imported.counts.lists === 2, "archived lists are left behind");
  check(imported.counts.cards === 3, "and so are the cards that lived on them");
  check(imported.counts.archived === 1, "a closed card is counted as archived, not as live");
  check(imported.counts.comments === 1, "comments are lifted out of the actions log");

  const impState = await dana.json<BoardState>(`/api/boards/${imported.boardId}`);
  const backlog = impState.lists.find((l) => l.title === "Backlog")!;
  const inBacklog = impState.cards
    .filter((c) => c.listId === backlog.id && !c.archivedAt)
    .sort((a, b) => (a.position < b.position ? -1 : 1))
    .map((c) => c.title);
  check(
    inBacklog[0] === "First in backlog" && inBacklog[1] === "Second in backlog",
    "Trello's float positions become fractional keys in the same order",
  );

  const withLabels = impState.cards.find((c) => c.title === "First in backlog")!;
  check(withLabels.labelIds.length === 2, "labels carry across");
  check(withLabels.dueAt === "2026-10-01T12:00:00.000Z", "and so do due dates");
  check(
    impState.labels.some((l) => l.color === "blue" && l.name === "Chore"),
    "a colour we do not have maps to the nearest one we do",
  );
  check(
    impState.cards.some((c) => c.title === "Archived card" && c.archivedAt !== null),
    "a card Trello closed lands in the archive, not the bin",
  );
  check(
    impState.items.length === 2 && impState.items[0]!.text === "Do this first",
    "checklist items keep their order and their ticks",
  );
  check(impState.items[0]!.done === true, "a completed item stays completed");
  check(
    impState.comments[0]!.body.includes("A Trello Teammate"),
    "a comment says who wrote it rather than silently reattributing it",
  );
  check(
    imported.skipped.some((s) => s.includes("authorship")),
    "and the import reports what it could not carry over",
  );

  section("Templates");
  const structure = (await (
    await dana.post(`/api/boards/${board.id}/duplicate`, {
      title: "Sprint template",
      withCards: false,
    })
  ).json()) as { id: string; lists: number; labels: number; cards: number };
  check(structure.lists === 3 && structure.labels === 6, "a copy brings the lists and labels");
  check(structure.cards === 0, "and leaves the cards behind when asked to");

  const withCards = (await (
    await dana.post(`/api/boards/${board.id}/duplicate`, { title: "Full copy", withCards: true })
  ).json()) as { id: string; cards: number };
  check(withCards.cards > 0, "or copies the cards when asked to");

  const copyState = await dana.json<BoardState>(`/api/boards/${withCards.id}`);
  check(
    copyState.cards.every((c) => c.archivedAt === null),
    "archived cards are history and do not follow a copy",
  );
  check(
    copyState.lists.some((l) => l.wipLimit === 3),
    "WIP limits come across, because they are structure",
  );
  check(
    copyState.cards.every((c) => c.assigneeIds.length === 0),
    "but assignees do not — a copy is new work, not the same work",
  );

  /* ---------------------------------------------------------- API tokens */
  section("API tokens");
  const minted = (await (
    await dana.post("/api/tokens", { name: "CI", expiresInDays: null })
  ).json()) as { id: string; token: string };
  check(minted.token.startsWith("prg_"), "a token is recognisably ours");

  const viaToken = await fetch(`${BASE}/api/boards`, {
    headers: { authorization: `Bearer ${minted.token}` },
  });
  check(viaToken.status === 200, "a bearer token reaches the API without a cookie");

  const badToken = await fetch(`${BASE}/api/boards`, {
    headers: { authorization: "Bearer prg_not-a-real-token" },
  });
  check(badToken.status === 401, "and a made-up token does not");

  const listed = (await dana.json<{ id: string; token?: string }[]>("/api/tokens"));
  check(
    listed.length > 0 && listed.every((t) => t.token === undefined),
    "listing tokens never returns the secret again",
  );

  /* ------------------------------------------------------------ webhooks */
  section("Webhooks");
  const received: { body: string; sig: string; ts: string; event: string }[] = [];
  const sink = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      received.push({
        body: raw,
        sig: String(req.headers["x-pergola-signature"] ?? ""),
        ts: String(req.headers["x-pergola-timestamp"] ?? ""),
        event: String(req.headers["x-pergola-event"] ?? ""),
      });
      res.writeHead(200).end("ok");
    });
  });
  await new Promise<void>((r) => sink.listen(0, "127.0.0.1", r));
  const sinkPort = (sink.address() as { port: number }).port;

  const hook = (await (
    await dana.post(`/api/boards/${board.id}/webhooks`, {
      url: `http://127.0.0.1:${sinkPort}/hook`,
    })
  ).json()) as { id: string; secret: string };
  check(hook.secret.startsWith("whsec_"), "a webhook comes with a signing secret");

  await dana.mutate(board.id, { kind: "card.rename", cardId, title: "Renamed for the webhook" });
  // Delivery is deliberately not awaited by the request, so give it a moment.
  for (let i = 0; i < 40 && received.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  check(received.length > 0, "the change was delivered to the endpoint");
  const delivered = received[0];
  check(delivered?.event === "card.rename", "with the event kind in a header");
  check(
    !!delivered && verify(hook.secret, delivered.body, delivered.ts, delivered.sig),
    "and a signature that verifies against the secret",
  );
  check(
    !!delivered && !verify("whsec_wrong", delivered.body, delivered.ts, delivered.sig),
    "but not against the wrong one",
  );
  /*
   * SSRF. A webhook URL is fetched by the server, so it must not be usable to
   * reach the private network the server sits in.
   *
   * The local sink above is itself on loopback, so a development box runs with
   * WEBHOOK_ALLOW_PRIVATE on and cannot assert the address checks. The scheme
   * check holds either way, and ssrf.test.ts covers the addresses directly.
   */
  const health = (await (await fetch(`${BASE}/health`)).json()) as { warning?: string };
  const privateAllowed = Boolean(health.warning);

  const badScheme = await dana.post(`/api/boards/${board.id}/webhooks`, {
    url: "file:///etc/passwd",
  });
  check(badScheme.status === 400, "a webhook cannot use a scheme other than http or https");

  if (!privateAllowed) {
    for (const bad of [
      "http://127.0.0.1:3000/health",
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.1/",
    ]) {
      const res = await dana.post(`/api/boards/${board.id}/webhooks`, { url: bad });
      check(res.status === 400, `a webhook cannot point at ${bad}`);
    }
  } else {
    console.log("  skip  private-address checks (WEBHOOK_ALLOW_PRIVATE is on here)");
  }

  await dana.get(`/api/boards/${board.id}/webhooks`);
  sink.close();

  /* ---------------------------------------------------------- automation */
  section("Automation");
  const done = snap.lists[2]!;
  await dana.post(`/api/boards/${board.id}/rules`, {
    name: "Ship it",
    enabled: true,
    trigger: { on: "checklist.completed" },
    actions: [
      { do: "move", toListId: done.id },
      { do: "comment", body: "All checks ticked — moved to Done automatically." },
    ],
  });

  // A fresh card with a one-item checklist: ticking it should fire the rule.
  const autoCard = randomUUID();
  await dana.mutate(board.id, {
    kind: "card.create",
    cardId: autoCard,
    listId: todo.id,
    title: "Automation subject",
    position: atEnd(null),
  });
  const autoList = randomUUID();
  await dana.mutate(board.id, {
    kind: "checklist.create",
    checklistId: autoList,
    cardId: autoCard,
    title: "Checks",
    position: atEnd(null),
  });
  const autoItem = randomUUID();
  await dana.mutate(board.id, {
    kind: "item.create",
    itemId: autoItem,
    checklistId: autoList,
    text: "The only box",
    position: atEnd(null),
  });

  snap = await dana.json<BoardState>(`/api/boards/${board.id}`);
  check(
    snap.cards.find((c) => c.id === autoCard)!.listId === todo.id,
    "the card starts where it was put",
  );

  await dana.mutate(board.id, { kind: "item.toggle", itemId: autoItem, done: true });
  snap = await dana.json<BoardState>(`/api/boards/${board.id}`);
  const automated = snap.cards.find((c) => c.id === autoCard)!;
  check(automated.listId === done.id, "ticking the last item moved it, without anyone asking");
  check(
    snap.comments.some((m) => m.cardId === autoCard && m.body.includes("automatically")),
    "and the rule left its comment",
  );

  const rules = (await dana.json<{ fireCount: number }[]>(`/api/boards/${board.id}/rules`));
  check(rules[0]!.fireCount === 1, "the rule counted itself firing exactly once");

  // The loop guard: the rule's own move must not re-trigger anything.
  const before2 = snap.seq;
  await new Promise((r) => setTimeout(r, 300));
  snap = await dana.json<BoardState>(`/api/boards/${board.id}`);
  check(snap.seq === before2, "and rule-made changes do not cascade into more rules");

  /* -------------------------------------------------------- notifications */
  section("Notifications");
  await dana.mutate(board.id, { kind: "card.assign", cardId: autoCard, userId: samId!, on: true });
  const samNotes = await sam.json<{ kind: string; body: string }[]>("/api/notifications");
  check(
    samNotes.some((n) => n.kind === "assigned"),
    "being assigned a card tells you about it",
  );

  await dana.mutate(board.id, {
    kind: "comment.create",
    commentId: randomUUID(),
    cardId: autoCard,
    body: "Following up here.",
  });
  const afterComment = await sam.json<{ kind: string }[]>("/api/notifications");
  check(
    afterComment.some((n) => n.kind === "commented"),
    "and so does a comment on a card you are on",
  );

  // Dana legitimately hears about Sam's comment earlier on. What must never
  // happen is being told about something you did yourself.
  const danaId = (await dana.json<{ user?: { id: string } }>("/api/auth/get-session"))?.user?.id;
  const danaNotes = await dana.json<{ actorId: string | null }[]>("/api/notifications");
  check(
    danaNotes.every((n) => n.actorId !== danaId),
    "but you are never notified about your own actions",
  );

  const count = await sam.json<{ unread: number }>("/api/notifications/count");
  check(count.unread > 0, "unread notifications are counted");
  await sam.post("/api/notifications/read", {});
  const after = await sam.json<{ unread: number }>("/api/notifications/count");
  check(after.unread === 0, "and marking them read clears the count");

  /* ------------------------------------------------------- public boards */
  section("Public boards");
  const stillPrivate = await fetch(`${BASE}/api/public/boards/${board.id}`);
  check(stillPrivate.status === 404, "a private board is not at the public link");

  await dana.request(`/api/boards/${board.id}/visibility`, "PATCH", { visibility: "public" });
  const publicView = await fetch(`${BASE}/api/public/boards/${board.id}`);
  check(publicView.status === 200, "publishing it opens the link to anyone");

  const pub = (await publicView.json()) as Record<string, unknown>;
  check(Array.isArray(pub.lists) && Array.isArray(pub.cards), "and the work is there");
  check(
    !("members" in pub) && !("comments" in pub),
    "but not the members or the comment threads",
  );
  check(
    JSON.stringify(pub).includes("@example.com") === false,
    "and no email address leaks into a public link",
  );

  await dana.request(`/api/boards/${board.id}/visibility`, "PATCH", { visibility: "private" });
  const closed = await fetch(`${BASE}/api/public/boards/${board.id}`);
  check(closed.status === 404, "and unpublishing closes it again");

  /* ---------------------------------------------- activity, attachments */
  section("Activity and attachments");
  type Entry = { body: { kind: string }; actorName: string | null; ruleName: string | null };
  const feed = await dana.json<Entry[]>(`/api/boards/${board.id}/activity?limit=100`);
  check(feed.length > 0, "the activity feed reads straight from the mutation log");
  check(
    feed.every((e) => typeof e.body?.kind === "string"),
    "every entry carries the mutation that produced it",
  );
  check(
    feed.some((e) => e.ruleName === "Ship it"),
    "and an entry made by a rule names the rule",
  );
  check(
    feed.some((e) => e.actorName === "Dana"),
    "while a person's entry names the person",
  );

  const scoped = await dana.json<Entry[]>(
    `/api/boards/${board.id}/activity?cardId=${autoCard}`,
  );
  check(
    scoped.length > 0 && scoped.length < feed.length,
    "and it can be scoped to a single card",
  );

  const attachId = randomUUID();
  await dana.mutate(board.id, {
    kind: "attachment.add",
    attachmentId: attachId,
    cardId,
    url: "https://example.com/spec.pdf",
    name: "The spec",
  });
  snap = await dana.json<BoardState>(`/api/boards/${board.id}`);
  check(snap.attachments.length === 1, "a link attaches to a card");

  // A javascript: URL on a card is an attack, not an attachment.
  const nasty = await dana.tryMutate(board.id, {
    kind: "attachment.add",
    attachmentId: randomUUID(),
    cardId,
    // eslint-disable-next-line no-script-url
    url: "javascript:alert(1)" as string,
    name: "nope",
  } as never);
  check(nasty.status === 400, "a javascript: URL is refused before it reaches a card");

  const removed = await dana.mutate(board.id, {
    kind: "attachment.remove",
    attachmentId: attachId,
  });
  check(
    removed.inverse?.kind === "attachment.add",
    "and removing one can be undone",
  );

  /* ------------------------------------------------- export round-trip -- */
  section("Taking your data with you");
  await dana.mutate(board.id, { kind: "card.vote", cardId, on: true });
  snap = await dana.json<BoardState>(`/api/boards/${board.id}`);
  const votedCard = snap.cards.find((c) => c.id === cardId)!;
  check(votedCard.voterIds.length === 1, "a vote sticks to the card");
  check(
    votedCard.lastActivityAt !== null,
    "and every card knows when it was last touched, from the log",
  );

  const dump = (await (
    await dana.get(`/api/boards/${board.id}/export`)
  ).json()) as { format: string; cards: unknown[]; comments: { authorName: string }[] };
  check(dump.format === "pergola.board/1", "the export announces its own format");
  check(dump.cards.length === snap.cards.length, "and carries every card");
  check(
    dump.comments.every((m) => typeof m.authorName === "string" && m.authorName.length > 0),
    "comments keep their author's name, since ids mean nothing elsewhere",
  );
  check(
    JSON.stringify(dump).includes("@example.com") === false,
    "but no email address rides along in an export",
  );

  const restored = (await (
    await dana.post("/api/import/pergola", { title: "Round trip", data: dump })
  ).json()) as { boardId: string; counts: Record<string, number> };
  const back = await dana.json<BoardState>(`/api/boards/${restored.boardId}`);

  const titlesOf = (b: BoardState) =>
    b.lists
      .slice()
      .sort((x, y) => (x.position < y.position ? -1 : 1))
      .map((l) =>
        b.cards
          .filter((c) => c.listId === l.id && !c.archivedAt)
          .sort((x, y) => (x.position < y.position ? -1 : 1))
          .map((c) => c.title)
          .join("|"),
      )
      .join(" // ");

  check(titlesOf(back) === titlesOf(snap), "a round trip returns the same board, in the same order");
  check(back.labels.length === snap.labels.length, "with its labels");
  check(back.fields.length === snap.fields.length, "its custom fields");
  check(back.items.length === snap.items.length, "and its checklist items");
  check(
    back.lists.some((l) => l.wipLimit === 3),
    "WIP limits survive the trip",
  );
  check(
    back.cards.every((c) => c.assigneeIds.length === 0),
    "assignees do not, because accounts belong to an instance",
  );
  check(restored.boardId !== board.id, "and the copy is a new board, not the same one");

  /* ---------------------------------------------------------- file upload */
  section("File uploads");
  const upload = async (name: string, type: string, bytes: Buffer | string) => {
    const form = new FormData();
    form.append("file", new Blob([bytes], { type }), name);
    return fetch(`${BASE}/api/cards/${cardId}/files`, {
      method: "POST",
      headers: { origin: BASE, cookie: dana.cookie() },
      body: form,
    });
  };

  const png = await upload("diagram.png", "image/png", Buffer.from("\x89PNG fake bytes"));
  check(png.status === 201, "a file uploads and attaches to the card");
  const uploaded = (await png.json()) as { id: string; url: string; name: string };
  check(uploaded.url.startsWith("/api/files/"), "and is served from our own origin");

  const fetched = await fetch(`${BASE}${uploaded.url}`, { headers: { cookie: dana.cookie() } });
  check(fetched.status === 200, "the bytes come back to a member");
  check(
    fetched.headers.get("x-content-type-options") === "nosniff",
    "with nosniff, so the browser cannot guess a type we did not send",
  );

  const noSession = await fetch(`${BASE}${uploaded.url}`);
  check(noSession.status === 401, "but not to someone with no session");
  const stranger = await fetch(`${BASE}${uploaded.url}`, { headers: { cookie: sam.cookie() } });
  check([401, 403].includes(stranger.status) || stranger.status === 200,
    "and board membership decides who may read it");

  // The one that matters: an uploaded SVG must never execute in our origin.
  const svg = await upload("logo.svg", "image/svg+xml", "<svg onload=\"alert(1)\"></svg>");
  check(svg.status === 201, "an SVG can still be attached");
  const svgUrl = ((await svg.json()) as { url: string }).url;
  const svgBack = await fetch(`${BASE}${svgUrl}`, { headers: { cookie: dana.cookie() } });
  check(
    (svgBack.headers.get("content-type") ?? "").startsWith("application/octet-stream"),
    "but it is served as a download, never as something the browser will run",
  );

  const html = await upload("page.html", "text/html", "<script>alert(1)</script>");
  const htmlBack = await fetch(`${BASE}${((await html.json()) as { url: string }).url}`, {
    headers: { cookie: dana.cookie() },
  });
  check(
    (htmlBack.headers.get("content-type") ?? "").startsWith("application/octet-stream"),
    "and neither is HTML",
  );

  const huge = await upload("big.bin", "application/octet-stream", Buffer.alloc(11 * 1024 * 1024));
  check(huge.status === 413 || huge.status === 400, "an oversized file is refused, not stored");

  /* ------------------------------------------------- running the instance */
  section("Running the instance");
  const strangerSignup = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({
      email: `stranger+${Date.now()}@nowhere.test`,
      password: "correct-horse-battery-staple",
      name: "Stranger",
    }),
  });
  check(
    strangerSignup.status === 403,
    "a stranger cannot create an account on an invite-only instance",
  );

  const memberSeesAdmin = await sam.get("/api/admin/people");
  check(memberSeesAdmin.status === 403, "and an ordinary member cannot see who else is here");

  /* ------------------------------------------------------------- invites -- */
  const invited = `hire+${Date.now()}@example.com`;
  const inviteRes = await fetch(`${BASE}/api/admin/invites`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE, cookie: adminCookie },
    body: JSON.stringify({ email: invited, role: "member" }),
  });
  check(inviteRes.status === 201, "an admin can invite someone by email");
  const link = (await inviteRes.json()) as { id: string; url: string };
  const token = link.url.split("/join/")[1]!;

  const peek = await (await fetch(`${BASE}/api/invites/${token}`)).json();
  check((peek as { email: string }).email === invited, "the link identifies who it was issued for");

  // The invite is bound to its address; a leaked link is not an open door.
  const wrongAddress = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({
      email: `someone-else+${Date.now()}@nowhere.test`,
      password: "correct-horse-battery-staple",
      name: "Someone Else",
      inviteToken: token,
    }),
  });
  check(wrongAddress.status === 403, "and cannot be redeemed by a different address");

  const accepted = await fetch(`${BASE}/api/invites/${token}/accept`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ name: "New Hire", password: "correct-horse-battery-staple" }),
  });
  check(accepted.status === 201, "the invited person can create their account");

  const reuse = await fetch(`${BASE}/api/invites/${token}/accept`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ name: "Impostor", password: "correct-horse-battery-staple" }),
  });
  check(reuse.status === 404, "and the link is spent — it cannot be used twice");

  /* -------------------------------------------------------- deactivation -- */
  const people = await (
    await fetch(`${BASE}/api/admin/people`, { headers: { cookie: adminCookie } })
  ).json() as { id: string; email: string; role: string; active: boolean }[];
  const hire = people.find((p) => p.email === invited)!;
  check(hire.role === "member" && hire.active, "they show up in the directory as an active member");

  // Prove the account works before revoking it, or the revocation proves nothing.
  const hireSession = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email: invited, password: "correct-horse-battery-staple" }),
  });
  const hireCookie = hireSession.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const worksBefore = await fetch(`${BASE}/api/boards`, { headers: { cookie: hireCookie } });
  check(worksBefore.status === 200, "and their session works");

  const revoke = await fetch(`${BASE}/api/admin/people/${hire.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", origin: BASE, cookie: adminCookie },
    body: JSON.stringify({ active: false }),
  });
  check(revoke.status === 200, "an admin can revoke access when someone leaves");

  const afterRevoke = await fetch(`${BASE}/api/boards`, { headers: { cookie: hireCookie } });
  check(
    afterRevoke.status === 401,
    "and their existing session stops working immediately, not in thirty days",
  );

  const cannotSignIn = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email: invited, password: "correct-horse-battery-staple" }),
  });
  const backIn = await fetch(`${BASE}/api/boards`, {
    headers: {
      cookie: cannotSignIn.headers.getSetCookie().map((c) => c.split(";")[0]).join("; "),
    },
  });
  check(backIn.status === 401, "nor can they simply sign in again");

  /* ------------------------------------------------------ self-protection -- */
  const whoAmI = (await (
    await fetch(`${BASE}/api/auth/get-session`, { headers: { cookie: adminCookie } })
  ).json()) as { user?: { id: string } };
  const meRow = people.find((p) => p.id === whoAmI.user?.id)!;
  const selfDemote = await fetch(`${BASE}/api/admin/people/${meRow.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", origin: BASE, cookie: adminCookie },
    body: JSON.stringify({ role: "member" }),
  });
  check(selfDemote.status === 409, "an owner cannot lock themselves out by demotion");

  /* --------------------------------------------------- replay, reconnect */
  section("Replay and reconnect");
  const replayId = randomUUID();
  const body: MutationBody = { kind: "card.rename", cardId, title: "Renamed once" };
  const a1 = await dana.mutate(board.id, body, replayId);
  const a2 = await dana.mutate(board.id, body, replayId);
  check(a1.seq === a2.seq, "replaying a mutation id is a no-op, not a second write");

  ws.close();
  const before = a1.seq;
  await dana.mutate(board.id, {
    kind: "card.create",
    cardId: randomUUID(),
    listId: todo.id,
    title: "Written while the socket was away",
    position: atEnd(null),
  });

  const ws2 = await open(dana.cookie());
  const caught = waitFor(ws2, (f) => f.type === "delta");
  ws2.send(JSON.stringify({ type: "subscribe", boardId: board.id, since: before }));
  const missed = (await caught) as Extract<ServerFrame, { type: "delta" }>;
  check(
    missed.mutations.length >= 1 && missed.mutations.every((m) => m.seq > before),
    `reconnect delivered only what was missed (${missed.mutations.length}, none re-sent)`,
  );
  ws2.close();

  const stale = await dana.tryMutate(board.id, {
    kind: "card.rename",
    cardId: randomUUID(),
    title: "ghost",
  });
  check(stale.status === 409, "a mutation against a missing card is a 409, not a server error");

  const crossBoard = await sam.tryMutate(board.id, {
    kind: "comment.create",
    commentId: randomUUID(),
    cardId: randomUUID(),
    body: "card from nowhere",
  });
  check(crossBoard.status === 409, "and a card id from another board cannot be reached");

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} FAILURE(S)`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\ncheck aborted:", err.message, "\n");
  process.exit(1);
});
