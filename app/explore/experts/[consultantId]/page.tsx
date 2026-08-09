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

// ISR per consultantId, not force-dynamic. The cache key is the expert being
// viewed, never the viewer: this page reads no session, and the layout above it
// reads none either. Real-time bookability is NOT in this HTML — the client
// fetches /api/slots/availability-with-allocation on mount, so a cached
// document can't show a stale "free" slot.
//
// 5 minutes, and the read underneath is uncached (lib/data/consultant-detail.ts
// is React.cache, i.e. per-request only), so this is the largest saving in the
// change. An expert's own edits purge this path on demand at the write site, so
// they don't watch their changes sit stale.
export const revalidate = 300;

// Required for `revalidate` above to be anything other than dead config: Next
// renders a dynamic segment dynamically unless generateStaticParams exists, and
// silently ignores the interval. The empty array is the documented "all paths at
// runtime" shape — nothing is prerendered during `next build`, which is what we
// want here twice over: consultant cardinality is unbounded (prerendering every
// profile would bloat the build) and it keeps these reads off the build-time
// cross-region pooler connect (#932). dynamicParams defaults to true, so a slug
// not in the array still renders on demand rather than 404ing.
// https://nextjs.org/docs/15/app/api-reference/functions/generate-static-params
export function generateStaticParams() {
  return [];
}

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
