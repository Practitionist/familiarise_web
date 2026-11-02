import { permanentRedirect } from "next/navigation";

import { consultantLegacyHref } from "@/lib/dashboard/personal-legacy-routes";

/** The old webinar and class planner; it 308s to Group programs with its query kept. */
export default async function PlannerRedirectPage({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ consultantId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const { consultantId } = await params;
  permanentRedirect(
    consultantLegacyHref(consultantId, "planner", await searchParams),
  );
}
