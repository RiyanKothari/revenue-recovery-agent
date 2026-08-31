/**
 * Proves the safety rules actually held over the whole batch.
 *
 * Run with: npm run verify
 *
 * Exits non-zero on any violation, so it can gate a demo or a deploy. This is
 * the difference between "we have guardrails" and "here is a mechanical check
 * over all 800 events showing they were never breached".
 */

import { loadEnv } from "./load-env";

loadEnv();

function rupees(paise: number): string {
  return `₹${Math.round(paise / 100).toLocaleString("en-IN")}`;
}

async function main() {
  const { runConformance } = await import("../lib/conformance-store");
  const { conformance, complianceCost } = await runConformance();

  console.log("Conformance verification\n" + "=".repeat(52));

  for (const result of conformance.results) {
    const icon = result.violations.length === 0 ? "PASS" : "FAIL";
    console.log(`  [${icon}] ${result.id}  ${result.description}`);
    console.log(`         checked ${result.checked}`);

    for (const violation of result.violations.slice(0, 5)) {
      console.log(`         ! ${violation.detail}`);
    }
    if (result.violations.length > 5) {
      console.log(`         ! ...and ${result.violations.length - 5} more`);
    }
  }

  console.log("\n" + "=".repeat(52));
  console.log(
    conformance.passed
      ? `All invariants held across ${conformance.totalChecked} checks.`
      : `${conformance.totalViolations} violation(s) across ${conformance.totalChecked} checks.`
  );

  // What the rules cost. Estimated, and labelled as such — a blocked event
  // has no outcome to measure against.
  console.log("\nCost of the stopping rules (estimated)\n" + "=".repeat(52));

  const categories = Object.entries(complianceCost.byCategory).filter(
    ([, line]) => line.count > 0
  );

  if (categories.length === 0) {
    console.log("  Nothing was stopped.");
  } else {
    for (const [category, line] of categories) {
      console.log(
        `  ${category.padEnd(14)} ${String(line.count).padStart(5)} events   ` +
          `${rupees(line.atRiskPaise).padStart(12)} at risk   ` +
          `${rupees(line.foregonePaise).padStart(12)} est. foregone`
      );
    }
    console.log(
      `\n  Headline: ${rupees(complianceCost.totalForegonePaise)} of recovery foregone to keep the rules.`
    );
    console.log(`  ${complianceCost.note}`);
  }

  process.exit(conformance.passed ? 0 : 1);
}

main().catch((err) => {
  console.error("\nVerification could not run:", err?.message ?? err);
  process.exit(1);
});
