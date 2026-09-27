import { assessPower, computeLift, type ArmOutcome } from "./experiment";
import { groupBy, isFavourable, type OfferRecord } from "./offer-ledger";

/**
 * The Fairness Auditor — across customers, within one merchant.
 *
 * ## Why per-offer checks cannot find this
 *
 * A platform that validates each agent action in isolation will report a
 * clean record forever, because every single offer can sit inside the
 * merchant's own configured bands while the aggregate pattern discriminates.
 * Nothing is out of policy. There is no offending decision to point at. The
 * discrimination lives in the distribution, and a distribution is not visible
 * from inside any one decision.
 *
 * So this reads the ledger grouped by customer attribute and asks whether
 * comparable people received comparable offers.
 *
 * ## The discipline that makes it usable
 *
 * A fairness tool that reports a disparity every time a small group looks
 * different is worse than no tool, because it produces a queue of findings
 * that are mostly noise, and the first thing anyone does with such a queue is
 * stop reading it. Small groups differ from each other constantly and for no
 * reason at all.
 *
 * So there are three verdicts, not two, and `underpowered` is the one that
 * earns the tool its credibility: it means this comparison could not have
 * detected a disparity of this size even if one existed, so the absence of a
 * finding is a fact about the sample rather than about the merchant.
 *
 * This is the same distinction the recovery dashboard already draws between
 * "not significant because it failed" and "not significant because the
 * sample was too small", and it reuses the same tested machinery —
 * `computeLift` for the interval and `assessPower` for the minimum detectable
 * effect — rather than inventing a second statistical path that nothing has
 * ever checked.
 */

export interface GroupOutcome {
  group: string;
  /** Customers in this group who were considered for an offer. */
  n: number;
  /** How many received a favourable one. */
  favourable: number;
  rate: number;
}

export type FairnessVerdict = "disparity" | "no_disparity" | "underpowered";

export interface FairnessFinding {
  attribute: string;
  reference: GroupOutcome;
  compared: GroupOutcome;
  /** Compared minus reference, in percentage points. Negative is worse off. */
  gapPp: number;
  ci95Pp: [number, number] | null;
  /** The smallest gap this comparison could have detected. */
  minimumDetectableEffectPp: number | null;
  verdict: FairnessVerdict;
  reason: string;
}

/**
 * Below this many observations in either group, the interval is not reported
 * at all.
 *
 * `computeLift` uses a normal approximation, and below roughly thirty per arm
 * that approximation is doing more work than the data supports — which is
 * what its own caveat says. The consequence is sharp here: six customers, one
 * of whom got a good offer, produces an interval that excludes zero and looks
 * exactly like a finding. Accusing a merchant of discrimination on six
 * observations because the arithmetic said so would be the most damaging
 * thing this tool could do.
 */
export const MIN_GROUP_FOR_INTERVAL = 30;

/**
 * The smallest gap worth calling a disparity, in percentage points.
 *
 * Materiality has to be stated, because at large enough n a half-point
 * difference becomes statistically significant while remaining of no interest
 * to anyone. Significance answers "is this real"; it never answers "does this
 * matter", and a fairness tool that conflates the two reports trivia at scale
 * and buries the findings that deserve attention.
 */
export const MATERIAL_GAP_PP = 5;

export interface FairnessReport {
  merchantId: string;
  attribute: string;
  findings: FairnessFinding[];
  summary: string;
}

function outcome(group: string, offers: OfferRecord[], threshold?: number): GroupOutcome {
  const favourable = offers.filter((o) => isFavourable(o, threshold)).length;
  return {
    group,
    n: offers.length,
    favourable,
    rate: offers.length === 0 ? 0 : favourable / offers.length,
  };
}

function toArm(group: GroupOutcome): ArmOutcome {
  // `recoveredPaise` is unused by the two statistics borrowed here; passing
  // zero rather than inventing a money figure keeps it from being read as one.
  return { n: group.n, converted: group.favourable, recoveredPaise: 0 };
}

/**
 * Audits one merchant's offers along one customer attribute.
 *
 * The largest group is the reference, because the comparison has to be
 * against something and the largest group carries the most information about
 * what this merchant's ordinary treatment looks like. Choosing the *best
 * treated* group as the reference instead would guarantee every other group
 * shows a deficit, which is a tool that always finds something.
 */
export function auditFairness(params: {
  merchantId: string;
  attribute: string;
  offers: OfferRecord[];
  favourableThreshold?: number;
  /** Override the gap size treated as material. */
  materialGapPp?: number;
}): FairnessReport {
  const { merchantId, attribute } = params;
  const materialGapPp = params.materialGapPp ?? MATERIAL_GAP_PP;

  const mine = params.offers.filter((o) => o.merchantId === merchantId);

  const groups = [...groupBy(mine, (o) => o.segment[attribute] ?? "unrecorded")]
    .map(([group, offers]) => outcome(group, offers, params.favourableThreshold))
    .sort((a, b) => b.n - a.n);

  if (groups.length < 2) {
    return {
      merchantId,
      attribute,
      findings: [],
      summary: `Nothing to compare: every offer carries the same "${attribute}".`,
    };
  }

  const reference = groups[0];
  const findings: FairnessFinding[] = [];

  for (const compared of groups.slice(1)) {
    const lift = computeLift(toArm(compared), toArm(reference));
    const power = assessPower(toArm(compared), toArm(reference));
    const gapPp = lift.absoluteLiftPp;

    /**
     * Sample floor first, then significance AND materiality, then whether a
     * material gap could have been seen at all.
     *
     * The order is the whole design. Checking significance first would accuse
     * a merchant on six observations, because a tiny sample can and does
     * produce an interval that excludes zero. Skipping materiality would
     * report half a percentage point as a finding once the groups are large
     * enough, which is how a tool trains people to ignore it.
     */
    let verdict: FairnessVerdict;
    let reason: string;

    const tooSmall =
      compared.n < MIN_GROUP_FOR_INTERVAL || reference.n < MIN_GROUP_FOR_INTERVAL;
    const material = Math.abs(gapPp) >= materialGapPp;
    const couldSeeMaterial =
      power.minimumDetectableEffectPp !== null &&
      power.minimumDetectableEffectPp <= materialGapPp;

    if (tooSmall) {
      verdict = "underpowered";
      reason =
        `Too few observations for the interval to mean anything: "${compared.group}" has n=${compared.n} against "${reference.group}" n=${reference.n}, and below ${MIN_GROUP_FOR_INTERVAL} the normal approximation does more work than the data supports. ` +
        "This is a fact about the sample, not about the merchant.";
    } else if (lift.significant && material) {
      verdict = "disparity";
      reason =
        gapPp < 0
          ? `"${compared.group}" receives a favourable offer ${Math.abs(gapPp).toFixed(1)}pp less often than "${reference.group}", and the interval excludes zero.`
          : `"${compared.group}" receives a favourable offer ${gapPp.toFixed(1)}pp more often than "${reference.group}", and the interval excludes zero.`;
    } else if (lift.significant && !material) {
      /**
       * Real but trivial. Reported as no disparity rather than suppressed
       * silently, because the number is still shown and a reader who sees a
       * significant gap described as no disparity deserves the reason.
       */
      verdict = "no_disparity";
      reason = `A statistically detectable gap of ${gapPp.toFixed(1)}pp, below the ${materialGapPp}pp treated as material. Real, but not a disparity worth acting on.`;
    } else if (couldSeeMaterial) {
      verdict = "no_disparity";
      reason = `No disparity detected, and this comparison could have resolved a gap of about ${power.minimumDetectableEffectPp!.toFixed(1)}pp — finer than the ${materialGapPp}pp treated as material, so the absence is informative.`;
    } else {
      verdict = "underpowered";
      reason =
        `No disparity detected, but this comparison could only have resolved a gap of about ${power.minimumDetectableEffectPp?.toFixed(1) ?? "?"}pp, which is coarser than the ${materialGapPp}pp treated as material. ` +
        "A material disparity could be present and invisible here. This is a fact about the sample, not about the merchant.";
    }

    findings.push({
      attribute,
      reference,
      compared,
      gapPp,
      ci95Pp: lift.ci95Pp,
      minimumDetectableEffectPp: power.minimumDetectableEffectPp,
      verdict,
      reason,
    });
  }

  const disparities = findings.filter((f) => f.verdict === "disparity").length;
  const underpowered = findings.filter((f) => f.verdict === "underpowered").length;

  const parts: string[] = [];
  if (disparities > 0) parts.push(`${disparities} disparity finding${disparities === 1 ? "" : "s"}`);
  if (underpowered > 0) parts.push(`${underpowered} too small to tell`);

  return {
    merchantId,
    attribute,
    findings,
    summary:
      parts.length === 0
        ? `No disparity across "${attribute}", on comparisons large enough to have found one.`
        : `${parts.join(", ")} across "${attribute}".`,
  };
}
