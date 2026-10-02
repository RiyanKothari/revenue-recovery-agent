import { redirect } from "next/navigation";

// The dashboard is the operator's front door, and every other surface
// (Policy Lab, Red Team, Attest) is one click from its header, so "/" lands
// there rather than 404.
export default function Home() {
  redirect("/dashboard");
}
