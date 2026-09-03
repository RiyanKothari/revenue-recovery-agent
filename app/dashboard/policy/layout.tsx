import type { Metadata } from "next";

/**
 * Per-route titles. A tab reading "Revenue Recovery Agent" on all three
 * screens gives someone with several open no way to tell them apart, and the
 * browser history reads as one page visited repeatedly.
 */
export const metadata: Metadata = {
  title: "Policy Lab — Revenue Recovery",
  description:
    "Replay recorded events under a different recovery policy. No model call, nothing sent, nothing written.",
};

export default function PolicyLayout({ children }: { children: React.ReactNode }) {
  return children;
}
