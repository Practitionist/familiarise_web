import { permanentRedirect } from "next/navigation";

import { consultantLegacyHref } from "@/lib/dashboard/personal-legacy-routes";

/** The old webinar and class planner; it answers a 308 to Group programs. */
export default async function PlannerRedirectPage({
  params,
}: Readonly<{ params: Promise<{ consultantId: string }> }>) {
  const { consultantId } = await params;
  permanentRedirect(consultantLegacyHref(consultantId, "planner"));
}
