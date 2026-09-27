import { DashboardHeader } from "@/components/dashboard/PageScaffold";
import { requirePersonalProfileAccess } from "@/lib/auth/personal-dashboard-access";

import { ReviewsInbox } from "./ReviewsInbox";

type PageProps = {
  params: Promise<{ consultantId: string }>;
};

/**
 * /dashboard/consultant/[consultantId]/reviews — what learners say, and the
 * right of reply (#1527 Q5, #1300). The read is session-derived and
 * owner-only; the guard here keeps the route itself to its owner.
 */
export default async function ReviewsPage({ params }: Readonly<PageProps>) {
  const { consultantId } = await params;
  await requirePersonalProfileAccess("consultant", consultantId);
  return (
    <>
      <DashboardHeader
        title="Reviews"
        description="What learners say about your sessions, and your replies"
      />
      <ReviewsInbox consultantId={consultantId} />
    </>
  );
}
