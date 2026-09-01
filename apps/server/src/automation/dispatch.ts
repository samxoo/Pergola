import { randomUUID } from "node:crypto";
import type { MutationEnvelope, MutationRecord } from "@pergola/shared";
import { commit } from "../mutations/commit.js";
import { runRules } from "./engine.js";
import { notifyFor } from "./notify.js";
import { deliver } from "./webhooks.js";
import { background } from "../runtime.js";

/**
 * Everything that happens *because* a mutation happened.
 *
 * Kept out of the transaction on purpose: a slow webhook or a broken rule must
 * not hold a row lock or roll back the change a person just made. Rules and
 * notifications are awaited because they are local and fast, and because tests
 * and the UI both want them settled before the response returns. Webhook
 * delivery is not — an unreachable endpoint is the endpoint's problem.
 *
 * That last part is the one thing that cannot simply be fired off and forgotten:
 * a serverless host freezes the instance the moment the response is sent, which
 * would turn "delivered eventually" into "delivered sometimes". background()
 * hands the work to the platform's keep-alive where there is one, and otherwise
 * waits for it — see runtime.ts.
 */
export async function commitAndDispatch(
  env: MutationEnvelope,
  actorId: string | null,
  ruleId: string | null = null,
): Promise<MutationRecord> {
  const record = await commit(env, actorId, ruleId);

  const [rules, notes] = await Promise.allSettled([
    runRules(record, (body, onBehalfOf, firedRuleId) =>
      commitAndDispatch(
        { id: randomUUID(), boardId: record.boardId, body },
        onBehalfOf,
        firedRuleId,
      ),
    ),
    notifyFor(record),
  ]);
  if (rules.status === "rejected") console.error("[dispatch] rules failed:", rules.reason);
  if (notes.status === "rejected") console.error("[dispatch] notifications failed:", notes.reason);

  await background(deliver(record), "dispatch: webhook delivery");

  return record;
}
