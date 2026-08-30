import { redirect } from "next/navigation";

// The dashboard is the only user-facing surface in this project, so "/"
// should land there rather than 404.
export default function Home() {
  redirect("/dashboard");
}
