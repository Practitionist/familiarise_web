import { redirect } from "next/navigation";
import { requireOnboarded } from "@/lib/auth-guard";
import {
  readWorkspaceLandingOrgId,
  resolveDashboardLanding,
} from "@/lib/dashboard/landing";

// Server-side dashboard router. requireOnboarded() guarantees an onboarded
// session carrying role + profile FKs + organizationMemberships (auth.ts
// customSession), so the landing resolves here — no client fetch. The rules
// live in lib/dashboard/landing.ts (#1527). redirect() throws by design; do
// not wrap it in a swallowing try/catch. This page takes no callbackUrl
// today: sign-in honours it before ever reaching /dashboard.
export default async function Dashboard() {
  const { user } = await requireOnboarded();
  // One extra read, ORG_WORKSPACE only (the workspace's default org).
  const workspaceLandingOrgId = await readWorkspaceLandingOrgId(user);
  redirect(resolveDashboardLanding(user, { workspaceLandingOrgId }));
}
