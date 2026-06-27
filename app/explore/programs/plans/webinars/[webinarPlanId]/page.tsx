import { notFound } from "next/navigation";
import { getWebinarPlanDetail } from "@/lib/data/plan-details";
import { WebinarDetails } from "./components/WebinarDetails";

// Stream behind the static layout's instant skeleton; don't prerender at build (#932).
export const dynamic = "force-dynamic";

export default async function WebinarDetailsPage({
  params,
}: Readonly<{
  params: Promise<{ webinarPlanId: string }>;
}>) {
  const { webinarPlanId } = await params;
  const webinarData = await getWebinarPlanDetail(webinarPlanId);

  if (!webinarData) {
    notFound();
  }

  const firstWebinarInstance = webinarData.webinars?.[0];
  const nextSession =
    firstWebinarInstance?.appointment?.slotsOfAppointment?.[0]?.startsAt;

  return (
    <WebinarDetails
      plan={webinarData}
      nextSession={nextSession}
      webinarId={firstWebinarInstance?.id}
    />
  );
}
