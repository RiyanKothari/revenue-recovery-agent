import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Red Team — Revenue Recovery",
  description: "Real hostile inputs run against the live safety rules.",
};

export default function RedTeamLayout({ children }: { children: React.ReactNode }) {
  return children;
}
