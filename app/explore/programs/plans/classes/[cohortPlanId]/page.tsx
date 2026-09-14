import { notFound } from "next/navigation";
import { canViewPlanDetail } from "@/lib/data/plan-viewable";
import { getCohortPlanDetail } from "@/lib/data/plan-details";
import { CohortDetails } from "./components/CohortDetails";
import { generateProgramImageUrl } from "@/lib/explore/programs";

// Stream behind the static layout's instant skeleton; don't prerender at build (#932).
export const dynamic = "force-dynamic";

export default async function CohortDetailsPage({
  params,
}: Readonly<{
  params: Promise<{ cohortPlanId: string }>;
}>) {
  const { cohortPlanId } = await params;
  const cohortPlan = await getCohortPlanDetail(cohortPlanId);

  if (!cohortPlan) {
    notFound();
  }

  // #726 — a detail page is reachable by id, so it needs the same
  // gate the list surfaces get: ORG_ONLY stays inside the owning org, and an
  // archived plan is not a live page.
  if (!(await canViewPlanDetail(cohortPlan))) {
    notFound();
  }

  const planWithDefaults = {
    ...cohortPlan,
    type: "class" as const,
    imageUrl: generateProgramImageUrl(
      cohortPlan.id,
      1200,
      400,
      cohortPlan.imageUrl,
    ),
  };

  return <CohortDetails plan={planWithDefaults} />;
}
