import { test } from "node:test";
import assert from "node:assert/strict";
import {
  claimLinkBudget,
  configuredLinkBudget,
  isLinkQuotaError,
  linkBudgetSpent,
  resetLinkBudget,
} from "../lib/link-budget";

/**
 * Razorpay test mode allows 30 payment links in total. The failure this
 * guards against is not running out — it is running out *silently*, and
 * recording an account quota as hundreds of customers who did not receive
 * their link.
 */

test("the budget is claimed until it is spent, then refused", () => {
  resetLinkBudget();
  const env = { RAZORPAY_MCP_LINK_BUDGET: "3" } as any;

  assert.equal(claimLinkBudget(env), true);
  assert.equal(claimLinkBudget(env), true);
  assert.equal(claimLinkBudget(env), true);
  assert.equal(claimLinkBudget(env), false);
  assert.equal(claimLinkBudget(env), false);
  assert.equal(linkBudgetSpent(), 3);
});

test("the default budget stays under Razorpay's hard cap of 30", () => {
  // Headroom matters: a demo where someone clicks a link still needs quota.
  assert.ok(configuredLinkBudget({} as any) < 30);
  assert.ok(configuredLinkBudget({} as any) > 0);
});

test("a zero budget refuses every link without throwing", () => {
  resetLinkBudget();
  assert.equal(claimLinkBudget({ RAZORPAY_MCP_LINK_BUDGET: "0" } as any), false);
});

test("junk configuration falls back to the default rather than to zero or infinity", () => {
  // A budget of NaN would compare false against every claim and silently
  // allow unlimited live calls against a capped account.
  for (const raw of ["abc", "-5", "1e999x", " "]) {
    const budget = configuredLinkBudget({ RAZORPAY_MCP_LINK_BUDGET: raw } as any);
    assert.ok(Number.isFinite(budget) && budget > 0 && budget < 30, `${raw} -> ${budget}`);
  }
});

test("an unset budget is not treated as zero", () => {
  assert.ok(configuredLinkBudget({} as any) > 0);
  assert.ok(configuredLinkBudget({ RAZORPAY_MCP_LINK_BUDGET: "" } as any) > 0);
});

test("Razorpay's own quota message is recognised", () => {
  // The wording that actually came back from the MCP server.
  assert.equal(
    isLinkQuotaError("creating payment link failed: test mode limit of 30 reached for payment_link"),
    true
  );
  assert.equal(isLinkQuotaError("No JSON payload in MCP tool result (got: test mode limit of 30 reached for payment_link)"), true);
});

test("an ordinary failure is not mistaken for a quota problem", () => {
  // Misreading a real delivery failure as a configuration limit would hide a
  // genuine customer-facing fault.
  assert.equal(isLinkQuotaError("Error POSTing to endpoint: 502"), false);
  assert.equal(isLinkQuotaError("invalid contact number"), false);
});
