/**
 * Razorpay test mode allows only 30 payment links, total.
 *
 * That is a hard account limit, not a rate limit, and it does not reset. A
 * demonstration batch of four hundred events cannot create four hundred
 * links — so the interesting question is not how to get around the cap but
 * what the pipeline should do when it runs out of them.
 *
 * The wrong answer, which is what the code did before this module existed,
 * is to let each attempt fail and record it against the customer. The
 * dashboard then showed 295 "delivery failed" rows, every one of them
 * implying a person who did not receive their payment link, when the truth
 * was that our test account had run out of quota after the thirtieth. That
 * is the same class of mistake as reading an expired WhatsApp token as
 * hundreds of failed sends: a configuration limit wearing a customer
 * outcome's clothes.
 *
 * So the budget is explicit and checked BEFORE the call. Under budget, the
 * link is real, created through Razorpay's own MCP server. Over budget, the
 * action is recorded as `simulated` and says so — in the audit trail, in the
 * database, and on screen. The pipeline still runs end to end, the guardrails
 * still count the attempt, and nobody is misled about which links exist.
 *
 * Mirrors the WHATSAPP_DRY_RUN pattern already in this codebase: state the
 * limitation in the record rather than letting it masquerade as a result.
 */

/** Kept under Razorpay's 30 so a demo has headroom for live clicks. */
const DEFAULT_BUDGET = 25;

export function configuredLinkBudget(env = process.env): number {
  // Trimmed first: Number(" ") is 0, so a whitespace-only value would
  // otherwise mean "never create a link" when it plainly means "unset".
  // An explicit "0" still means zero — that distinction is the point.
  const raw = env.RAZORPAY_MCP_LINK_BUDGET?.trim();
  if (!raw) return DEFAULT_BUDGET;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_BUDGET;
  return Math.floor(parsed);
}

/**
 * Counts real links created so far.
 *
 * This was process-scoped, and that was wrong in a way worth recording: a
 * Next dev server re-evaluates route modules, which reset the counter
 * mid-batch. A budget of 25 spent 69 live calls across one run — the guard
 * silently stopped guarding, and the only visible symptom was Razorpay rate-
 * limiting us. Any budget held in module state is really a budget per module
 * instantiation, which is not a quantity anyone means.
 *
 * The count is now seeded from the database, which is the only place that
 * survives a reload, and kept in memory between calls so the common path
 * does not pay for a query. `seedLinkBudget` is called once per batch.
 */
let spent = 0;

export function seedLinkBudget(alreadyCreated: number): void {
  spent = Math.max(spent, alreadyCreated);
}

export function claimLinkBudget(env = process.env): boolean {
  if (spent >= configuredLinkBudget(env)) return false;
  spent += 1;
  return true;
}

export function linkBudgetSpent(): number {
  return spent;
}

/** Test seam. Never called by the pipeline. */
export function resetLinkBudget(): void {
  spent = 0;
}

/**
 * Recognises the cap being reported by Razorpay itself.
 *
 * The budget above should mean we never hit it, but a shared or partly-used
 * test account can exhaust the quota before this process starts. When that
 * happens the failure must still read as "our account is out of links"
 * rather than as a delivery failure, so the message is detected rather than
 * passed through as an opaque tool error.
 */
export function isLinkQuotaError(message: string): boolean {
  return /test mode limit .* reached|limit of \d+ reached for payment_link/i.test(message);
}

/**
 * Rate limiting, which is a different problem with the same tell.
 *
 * Razorpay throttles a burst of link creations, and the resulting "Too many
 * requests" reached the dashboard as a per-customer delivery failure exactly
 * like the quota error did. It is our traffic shape, not the customer's
 * outcome, so it is named as such.
 */
export function isRateLimitError(message: string): boolean {
  return /too many requests|rate limit|429/i.test(message);
}
