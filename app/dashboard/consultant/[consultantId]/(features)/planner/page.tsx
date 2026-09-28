import { permanentRedirect } from "next/navigation";

/**
 * #1527 §9 — the Event Planner is "Offerings" now, at `/offerings`. The old
 * URL answers a 308 so bookmarks, emails and onboarding links keep working.
 */
export default async function PlannerRedirectPage({
  params,
}: Readonly<{ params: Promise<{ consultantId: string }> }>) {
  const { consultantId } = await params;
  permanentRedirect(`/dashboard/consultant/${consultantId}/offerings`);
}
