import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { apiError, rateLimited } from "@/lib/api-errors";
import { enforceRateLimit } from "@/lib/rate-limit";
import { auditFairness } from "@/lib/fairness-audit";
import { watchCategory } from "@/lib/cartel-watch";
import {
  AUDITABLE_ATTRIBUTES,
  resolveIdentity,
  toOfferRecord,
  type AuditableAttribute,
} from "@/lib/ledger-writer";

export const dynamic = "force-dynamic";

/**
 * Runs the Fairness Auditor and Cartel Watch over this deployment's OWN
 * decisions.
 *
 * Until this route existed, both agents were correct, tested libraries
 * reasoning about a ledger nothing produced — which is a fair thing to hold
 * against them. The rows here are derived from `revenue_events`,
 * `agent_decisions` and `recovery_actions`: the same tables the dashboard and
 * the conformance verifier read, so this cannot describe a system other than
 * the one running.
 *
 * The audited question is who the agent decides to *help*, because this agent
 * has no discount to give. An agent that chases card failures and gives up on
 * UPI failures is discriminating just as surely as one that offers some
 * customers less money — see lib/ledger-writer.ts.
 */

function safeDb() {
  try {
    return getDb();
  } catch {
    return null;
  }
}

function isAuditable(value: string | null): value is AuditableAttribute {
  return value !== null && (AUDITABLE_ATTRIBUTES as readonly string[]).includes(value);
}

export async function GET(request: Request) {
  const db = safeDb();

  const limit = await enforceRateLimit("fairness", 20, 60_000, db);
  if (!limit.allowed) return rateLimited(limit.retryAfterSeconds);

  if (!db) return apiError("database_unavailable", 503);

  const requested = new URL(request.url).searchParams.get("attribute");
  if (requested !== null && !isAuditable(requested)) {
    /**
     * Refused rather than defaulted. An audit on an attribute the ledger does
     * not record would compare one group against itself and report no
     * disparity — a clean result produced by asking the wrong question, which
     * is the most dangerous output this endpoint could return.
     */
    return apiError("unknown_attribute", 400);
  }

  try {
    const identity = resolveIdentity();
    const facts = await db.listDecisionFacts();

    const ledger = facts.map((fact) =>
      toOfferRecord(
        {
          revenueEventId: fact.revenue_event_id,
          customerId: fact.customer_id,
          amountPaise: fact.amount_paise,
          paymentMethod: fact.payment_method,
          rootCause: fact.root_cause,
          decidedAtIso: fact.decided_at,
          contacted: fact.contacted,
          policyVersion: fact.policy_version ?? "unversioned",
        },
        identity
      )
    );

    const attributes = requested ? [requested] : [...AUDITABLE_ATTRIBUTES];

    const fairness = attributes.map((attribute) =>
      auditFairness({ merchantId: identity.merchantId, attribute, offers: ledger })
    );

    /**
     * Cartel Watch runs too, and on one merchant it will honestly report that
     * it has nothing to compare against. That is worth showing rather than
     * hiding: the refusal is the feature. A collusion detector that produced a
     * confident number from a single merchant's data would be exactly the
     * unfalsifiable claim the module was built to avoid.
     *
     * The cutover is the first decision this deployment ever made, so every
     * row sits after it — which is itself why there is no before-period to
     * measure convergence against.
     */
    const cutoverIso = facts[0]?.decided_at ?? new Date().toISOString();
    const cartel = watchCategory({ category: identity.category, offers: ledger, cutoverIso });

    return NextResponse.json({
      merchant: identity,
      decisions_audited: ledger.length,
      contacted: ledger.filter((o) => o.favourable).length,
      // Stated, because every attribute here is a proxy and none is a
      // protected characteristic. A reader should know what was and was not
      // examined without reading the source.
      attributes_available: AUDITABLE_ATTRIBUTES,
      fairness,
      cartel,
    });
  } catch (err) {
    return apiError("fairness_audit_failed", 500, err);
  }
}
