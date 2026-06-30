import { Suspense } from "react";
import { notFound } from "next/navigation";
import {
  getConsultantDetail,
  getConsultantReviews,
} from "@/lib/data/consultant-detail";
import { TUserWithProfessionalBackground } from "@/types/user";
import { ExpertProfileClient } from "./ExpertProfileClient";
import { ConsultantSkeletonLoader } from "./components/ConsultantSkeletonLoader";
import { ConsultantUnavailable } from "./components/ConsultantUnavailable";
import { isTransientDbError, reportTransient } from "@/lib/data/fail-open";

// Per-visitor detail page: stream behind the static layout's instant skeleton,
// never prerender at build (#932).
export const dynamic = "force-dynamic";

type Params = Promise<{ consultantId: string }>;

export default async function ExpertProfile({
  params,
}: Readonly<{ params: Params }>) {
  const { consultantId } = await params;

  try {
    // Parallel fetch — eliminates the previous waterfall
    const [consultant, reviews] = await Promise.all([
      getConsultantDetail(consultantId),
      getConsultantReviews(consultantId),
    ]);

    if (!consultant || !consultant.user) {
      notFound();
    }

    return (
      <Suspense fallback={<ConsultantSkeletonLoader />}>
        <ExpertProfileClient
          consultantDetails={consultant}
          userDetails={consultant.user as TUserWithProfessionalBackground}
          reviews={reviews}
        />
      </Suspense>
    );
  } catch (error) {
    // notFound()'s control-flow signal and any real defect rethrow to error.tsx;
    // only the known cross-region cold-connect transient (#932) degrades here, so
    // it never escapes render to be captured by onRequestError. (FAMILIARISE_WEB-A)
    if (!isTransientDbError(error)) throw error;
    reportTransient("consultant detail page", error, { consultantId });
    return <ConsultantUnavailable />;
  }
}
