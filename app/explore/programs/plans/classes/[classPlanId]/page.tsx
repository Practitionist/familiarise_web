import { notFound } from "next/navigation";
import { getClassPlanDetail } from "@/lib/data/plan-details";
import { ClassDetails } from "./components/ClassDetails";
import { generateProgramImageUrl } from "@/lib/explore/programs";

// Stream behind the static layout's instant skeleton; don't prerender at build (#932).
export const dynamic = "force-dynamic";

export default async function ClassDetailsPage({
  params,
}: Readonly<{
  params: Promise<{ classPlanId: string }>;
}>) {
  const { classPlanId } = await params;
  const classPlan = await getClassPlanDetail(classPlanId);

  if (!classPlan) {
    notFound();
  }

  const planWithDefaults = {
    ...classPlan,
    type: "class" as const,
    imageUrl: generateProgramImageUrl(
      classPlan.id,
      1200,
      400,
      classPlan.imageUrl,
    ),
  };

  return <ClassDetails plan={planWithDefaults} />;
}
