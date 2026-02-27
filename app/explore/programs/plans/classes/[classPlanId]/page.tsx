import { notFound } from "next/navigation";
import { getClassPlanDetail } from "@/lib/data/plan-details";
import { ClassDetails } from "./components/ClassDetails";
import { generateProgramImageUrl } from "@/app/explore/programs/utils";

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
