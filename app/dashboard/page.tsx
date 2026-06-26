import { redirect } from "next/navigation";
import { requireOnboarded } from "@/lib/auth-guard";

// Server-side role router. The layout's requireOnboarded() guarantees an
// onboarded session whose user carries role + profile FKs (from auth.ts
// customSession), so we resolve the role-home target and redirect() here —
// no client fetch, no JS-load blank, no artificial delay. redirect() throws
// by design; do not wrap it in a swallowing try/catch.
export default async function Dashboard() {
  const { user } = await requireOnboarded();

  let target: string;
  switch (user.role) {
    case "CONSULTANT":
      target = user.consultantProfileId
        ? `/dashboard/consultant/${user.consultantProfileId}/home`
        : "/";
      break;
    case "CONSULTEE":
      target = user.consulteeProfileId
        ? `/dashboard/consultee/${user.consulteeProfileId}/home`
        : "/";
      break;
    case "ADMIN":
      target = "/dashboard/admin/home";
      break;
    case "STAFF":
      target = user.staffProfileId
        ? `/dashboard/staff/${user.staffProfileId}/home`
        : "/";
      break;
    case "ORG_WORKSPACE":
      // Mirrors /dashboard/organization so a multi-org operator lands on the
      // cross-org portfolio. No profile yet (#724) → the create wizard.
      target = user.orgWorkspaceProfileId
        ? `/dashboard/org-workspace/${user.orgWorkspaceProfileId}/home`
        : "/dashboard/organization";
      break;
    default:
      target = "/dashboard/error";
  }

  redirect(target);
}
