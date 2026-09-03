import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Decision trace — Revenue Recovery",
  description: "One payment's full path through the pipeline, reconstructed from the audit trail.",
};

export default function EventLayout({ children }: { children: React.ReactNode }) {
  return children;
}
