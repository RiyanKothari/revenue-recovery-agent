import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CARTEL_SCENARIOS,
  FAIRNESS_SCENARIOS,
  NUDGE_FIXTURES,
  NUDGE_SCENARIOS,
  REALITY_SCENARIOS,
  UNLEARNING_SCENARIOS,
  SENTINEL_CLAIMS,
  SENTINEL_CONFIGS,
  SENTINEL_NOW,
  createFixtureVerifierDb,
} from "../lib/attest-scenarios";
import { verifyNudge } from "../lib/nudge-verify-service";
import { screenMessage } from "../lib/message-claims";
import { auditFairness } from "../lib/fairness-audit";
import { watchCategory } from "../lib/cartel-watch";
import { MATERIAL_FIDELITY_GAP_PP, certifyAgent } from "../lib/reality-check";
import { verifyUnlearning } from "../lib/unlearning-verifier";
import { ATTEMPT_CAP, normaliseCode } from "../lib/nudge-verification";

/**
 * Every scenario the console shows, asserted to produce the verdict it
 * claims.
 *
 * A demo that quietly stops demonstrating its point is worse than no demo,
 * because nobody checks a screen that has always worked — and these fixtures
 * are exactly the kind of thing that rots when a threshold moves. If someone
 * changes the materiality constant, this file goes red rather than the
 * console silently showing "no disparity" under a panel captioned "a real
 * disparity".
 */

const NOW = () => new Date("2026-09-27T09:00:00.000Z");
const db = () => createFixtureVerifierDb(NUDGE_FIXTURES);

// --- Verified Nudge

test("the genuine message verifies on the amount the customer really paid", async () => {
  const genuine = NUDGE_SCENARIOS.find((s) => s.id === "genuine")!;

  const outcome = await verifyNudge(
    { code: genuine.code, amount: genuine.trueAmount },
    { db: db(), now: NOW }
  );

  assert.equal(outcome.status, "verified");
  if (outcome.status !== "verified") return;
  assert.equal(outcome.merchantName, "Kettle & Co");
});

test("the phishing message is unrecognised, however well written", async () => {
  const phishing = NUDGE_SCENARIOS.find((s) => s.id === "phishing")!;

  const outcome = await verifyNudge(
    { code: phishing.code, amount: phishing.trueAmount },
    { db: db(), now: NOW }
  );

  assert.deepEqual(outcome, { status: "unknown" });
});

test("the phishing message is the better-written of the two", () => {
  /**
   * Load-bearing, not a joke. The premise of the agent is that copy,
   * branding and a plausible link cannot separate a real recovery message
   * from a fake one. A demo whose fake message looks obviously fake would
   * prove the opposite of what it claims.
   */
  const phishing = NUDGE_SCENARIOS.find((s) => s.id === "phishing")!;
  assert.match(phishing.messageText, /URGENT|cancelled in 30 minutes/);
  // And it carries a real-looking gateway link, same as the genuine one.
  assert.match(phishing.messageText, /rzp\.io\/l\//);
});

test("both scenario codes are well formed, so neither is refused on shape alone", () => {
  // If the phishing code were malformed, the panel would be demonstrating
  // input validation rather than verification.
  for (const scenario of NUDGE_SCENARIOS) {
    assert.notEqual(normaliseCode(scenario.code), null, `${scenario.id} must be a valid code shape`);
  }
});

test("the console's store really does run out of attempts", async () => {
  /**
   * A fixture store that could not refuse would make the attempt cap
   * undemonstrable, and the cap is the only thing standing between the
   * challenge and a guessing game.
   */
  const store = db();
  const code = NUDGE_SCENARIOS[0].code;

  for (let i = 0; i < ATTEMPT_CAP; i++) {
    const wrong = await verifyNudge({ code, amount: String(1000 + i) }, { db: store, now: NOW });
    assert.equal(wrong.status, "mismatch", `guess ${i + 1} is a mismatch`);
  }

  const locked = await verifyNudge({ code, amount: "2499" }, { db: store, now: NOW });
  assert.deepEqual(locked, { status: "locked" }, "right answer, no attempts left");
});

test("a correct answer does not burn the customer's attempts", async () => {
  const store = db();
  const code = NUDGE_SCENARIOS[0].code;

  for (let i = 0; i < 10; i++) {
    const outcome = await verifyNudge({ code, amount: "2499" }, { db: store, now: NOW });
    assert.equal(outcome.status, "verified", `check ${i + 1} still verifies`);
  }
});

// --- Dark Pattern Sentinel

test("one message and one extraction produce opposite verdicts on the two configs", () => {
  /**
   * The argument in a single assertion: the words are not the evidence. The
   * console changes only the offer config, and a tone classifier looking at
   * these two columns sees the same sentence twice.
   */
  const honest = SENTINEL_CONFIGS.find((c) => c.id === "honest")!;
  const dishonest = SENTINEL_CONFIGS.find((c) => c.id === "dishonest")!;

  const passed = screenMessage({
    claims: SENTINEL_CLAIMS,
    facts: honest.facts,
    nowIso: SENTINEL_NOW,
  });
  assert.equal(passed.decision, "send");
  assert.deepEqual(passed.blocking, []);

  const held = screenMessage({
    claims: SENTINEL_CLAIMS,
    facts: dishonest.facts,
    nowIso: SENTINEL_NOW,
  });
  assert.equal(held.decision, "hold");
  assert.equal(held.blocking.length, 2, "the fabricated deadline and the fake exclusivity");
});

test("the discount claim is honest in both configs, so it is never what holds the message", () => {
  // Deliberate: if every claim failed in the bad config, the panel would not
  // show that the screen distinguishes between them.
  for (const config of SENTINEL_CONFIGS) {
    const result = screenMessage({
      claims: SENTINEL_CLAIMS,
      facts: config.facts,
      nowIso: SENTINEL_NOW,
    });
    const discount = result.claims.find((c) => c.claim.type === "discount")!;
    assert.equal(discount.verdict, "supported", `discount is true under ${config.id}`);
  }
});

test("the bad config holds for both reasons, not just one", () => {
  const dishonest = SENTINEL_CONFIGS.find((c) => c.id === "dishonest")!;
  const result = screenMessage({
    claims: SENTINEL_CLAIMS,
    facts: dishonest.facts,
    nowIso: SENTINEL_NOW,
  });

  const verdicts = result.blocking.map((b) => b.verdict).sort();
  // One contradicted (the coupon everyone gets), one unsupported (a deadline
  // with no expiry behind it). The summary has to keep them apart.
  assert.deepEqual(verdicts, ["contradicted", "unsupported"]);
  assert.match(result.summary, /1 contradicted/);
  assert.match(result.summary, /1 with nothing on record/);
});

// --- Fairness Auditor

test("each fairness scenario produces the verdict its caption promises", () => {
  const expected: Record<string, string> = {
    disparity: "disparity",
    underpowered: "underpowered",
    clean: "no_disparity",
  };

  for (const scenario of FAIRNESS_SCENARIOS) {
    const report = auditFairness({
      merchantId: "m_kettle",
      attribute: scenario.attribute,
      offers: scenario.offers,
    });

    assert.equal(report.findings.length, 1, `${scenario.id} compares exactly two groups`);
    assert.equal(
      report.findings[0].verdict,
      expected[scenario.id],
      `${scenario.id} must read as ${expected[scenario.id]}`
    );
  }
});

// --- Cartel Watch

test("each cartel scenario produces the severity its caption promises", () => {
  const expected: Record<string, string> = {
    clear: "clear",
    no_control: "clear",
    signal: "signal",
    proof: "proof",
  };

  for (const scenario of CARTEL_SCENARIOS) {
    const report = watchCategory({
      category: scenario.category,
      offers: scenario.offers,
      cutoverIso: scenario.cutoverIso,
    });

    assert.equal(
      report.severity,
      expected[scenario.id],
      `${scenario.id} must read as ${expected[scenario.id]}`
    );
  }
});

test("the no-control scenario refuses on convergence rather than reporting it", () => {
  /**
   * Its severity is `clear`, which is the honest answer and also the
   * counter-intuitive one: dispersion really did collapse. Without merchants
   * off the agent to compare against, saying so would be an unfalsifiable
   * claim, and the console caption has to carry that.
   */
  const scenario = CARTEL_SCENARIOS.find((s) => s.id === "no_control")!;
  const report = watchCategory({
    category: scenario.category,
    offers: scenario.offers,
    cutoverIso: scenario.cutoverIso,
  });

  assert.equal(report.convergence.verdict, "no_control");
  assert.equal(report.convergence.excessConvergence, null);
});

test("the proof scenario names the rival whose data leaked", () => {
  const scenario = CARTEL_SCENARIOS.find((s) => s.id === "proof")!;
  const report = watchCategory({
    category: scenario.category,
    offers: scenario.offers,
    cutoverIso: scenario.cutoverIso,
  });

  assert.ok(report.isolationViolations.length > 0);
  // Every violation names a competitor other than the merchant it was for.
  for (const violation of report.isolationViolations) {
    assert.ok(violation.foreignMerchantIds.length > 0);
    assert.ok(!violation.foreignMerchantIds.includes(violation.merchantId));
  }
});

// --- Reality Check

test("each reality scenario produces the decision its caption promises", () => {
  const expected: Record<string, string> = {
    refused: "refused",
    certified: "certified",
    insufficient: "insufficient_evidence",
  };

  for (const scenario of REALITY_SCENARIOS) {
    const result = certifyAgent({ agent: scenario.agent, evidence: scenario.evidence });
    assert.equal(
      result.decision,
      expected[scenario.id],
      `${scenario.id} must read as ${expected[scenario.id]}`
    );
  }
});

test("the refused scenario would have passed an aggregate review", () => {
  /**
   * The point of the whole panel. Two large segments track reality almost
   * exactly and one small one is wildly optimistic, so pooling the three
   * hides the finding — the well-modelled segments are also the larger ones,
   * which is precisely the shape the paper describes.
   */
  const scenario = REALITY_SCENARIOS.find((s) => s.id === "refused")!;

  const pooled = scenario.evidence.reduce(
    (acc, e) => ({
      simulated: {
        n: acc.simulated.n + e.simulated.n,
        converted: acc.simulated.converted + e.simulated.converted,
        recoveredPaise: 0,
      },
      measured: {
        n: acc.measured.n + e.measured.n,
        converted: acc.measured.converted + e.measured.converted,
        recoveredPaise: 0,
      },
    }),
    {
      simulated: { n: 0, converted: 0, recoveredPaise: 0 },
      measured: { n: 0, converted: 0, recoveredPaise: 0 },
    }
  );

  const pooledGapPp =
    (pooled.simulated.converted / pooled.simulated.n -
      pooled.measured.converted / pooled.measured.n) *
    100;

  assert.ok(
    pooledGapPp < MATERIAL_FIDELITY_GAP_PP,
    `pooled gap of ${pooledGapPp.toFixed(1)}pp looks acceptable, which is why per-segment matters`
  );

  // Per segment, it is refused.
  assert.equal(
    certifyAgent({ agent: scenario.agent, evidence: scenario.evidence }).decision,
    "refused"
  );
});

// --- Unlearning Verifier

test("each unlearning scenario produces the verdict its caption promises", () => {
  const expected: Record<string, string> = {
    residual: "residual_influence",
    clean: "no_detectable_influence",
    platform_probes: "unverifiable_provenance",
    underpowered: "insufficient",
  };

  for (const scenario of UNLEARNING_SCENARIOS) {
    const report = verifyUnlearning({
      merchantId: scenario.merchantId,
      probes: scenario.probes,
      provenance: scenario.provenance,
    });
    assert.equal(
      report.verdict,
      expected[scenario.id],
      `${scenario.id} must read as ${expected[scenario.id]}`
    );
  }
});

test("the clean and platform scenarios differ only in who chose the probes", () => {
  /**
   * The panel's argument in one assertion: identical numbers, weaker
   * conclusion. If the probe sets differed too, the demonstration would be
   * about the data rather than about provenance.
   */
  const clean = UNLEARNING_SCENARIOS.find((s) => s.id === "clean")!;
  const platform = UNLEARNING_SCENARIOS.find((s) => s.id === "platform_probes")!;

  assert.deepEqual(
    clean.probes.map((p) => [p.cohort, p.confidence]),
    platform.probes.map((p) => [p.cohort, p.confidence]),
    "the evidence is identical"
  );
  assert.notEqual(clean.provenance, platform.provenance);

  const a = verifyUnlearning({ merchantId: "m", probes: clean.probes, provenance: "auditor" });
  const b = verifyUnlearning({ merchantId: "m", probes: platform.probes, provenance: "platform" });

  assert.equal(a.attackerAdvantagePp, b.attackerAdvantagePp, "same measurement");
  assert.notEqual(a.verdict, b.verdict, "different conclusion");
});
