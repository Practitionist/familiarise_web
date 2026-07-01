import { Suspense } from "react";
import { notFound, unstable_rethrow } from "next/navigation";
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
    // Re-throw Next.js internal control-flow signals (notFound/redirect) FIRST via
    // the official guard, so the timeout regex can never accidentally swallow one.
    // Then degrade the known cross-region cold-connect transient (#932) inside
    // render so it never escapes to onRequestError; any real defect rethrows to
    // error.tsx. (FAMILIARISE_WEB-A, #945 review)
    unstable_rethrow(error);
    if (!isTransientDbError(error)) throw error;
    reportTransient("consultant detail page", error, { consultantId });
    return <ConsultantUnavailable />;
  }
}
