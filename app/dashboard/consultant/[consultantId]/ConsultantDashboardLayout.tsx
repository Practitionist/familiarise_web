"use client";

import { use, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { BreadcrumbOverrideProvider } from "@/components/dashboard/breadcrumb-override";
import {
  PersonalDashboardLayoutCore,
  type PersonalDashboardExtras,
  type PersonalDashboardExtrasCtx,
} from "@/components/dashboard/PersonalDashboardLayoutCore";
import { consultantFetchers } from "@/lib/dashboard-queries";
import {
  consultantNavWithPublicPage,
  CONSULTANT_OFFERING_TYPE_SEGMENTS,
  CONSULTANT_PAGE_LABELS,
  CONSULTANT_PATHLESS_SEGMENTS,
  consultantOfferingsRootLabel,
} from "@/lib/dashboard/nav/consultant";
import { sellHomePath } from "@/lib/dashboard/sell-pages";
import { usePersonalNavBadges } from "@/hooks/usePersonalNavBadges";
import { useExpertShareHref } from "@/hooks/useExpertShareHref";
import { verificationStatusBadge } from "@/lib/labels/session-labels";
import { PERSONAL_SIDE_LABEL } from "@/lib/labels/personal-dashboard";
import {
  VerificationPendingOverlay,
  VerificationBanner,
} from "@/components/verification/VerificationPendingOverlay";
import type { VerificationStatus } from "@/components/verification/VerificationStatusBadge";
import { useVerificationStatus } from "@/hooks/useVerificationStatus";
import {
  settingsSectionGroups,
  settingsSectionHref,
} from "./(features)/settings/settings";

const PREFETCH_SUFFIXES = ["home", "appointments", "requests"];

// An editor's `offerings/<type>` crumbs have no page; they open the type's list.
const OFFERINGS_CRUMBS = {
  typeSegments: CONSULTANT_OFFERING_TYPE_SEGMENTS,
  listingPath: sellHomePath,
  rootLabel: consultantOfferingsRootLabel,
};

interface PageProps {
  children: React.ReactNode;
  params: Promise<{ consultantId: string }>;
}

// Profile payload as the layout consumes it: the composed consultant record
// (user identity + verification status). The fetcher returns the API shape;
// the accessors below read it structurally.
interface ConsultantDetails {
  user?: {
    id?: string;
    name?: string | null;
    image?: string | null;
  } | null;
  verificationStatus?: VerificationStatus;
}

// Verification state + reviewer feedback as shell extras. The consultant-data
// payload carries the coarse status; the verification query adds the latest
// submission's rejectionReason / feedbackDetails / per-document feedback so
// the REJECTED gate can finally show WHY. ADMIN/STAFF inspecting someone's
// dashboard are never gated (and /api/verification/status reads the signed-in
// user, which would be the admin's own — mismatched — record).
function useConsultantExtras({
  profile,
  userDetails,
  userId,
  routeParam,
  basePath,
  pathname,
}: PersonalDashboardExtrasCtx<ConsultantDetails>): PersonalDashboardExtras {
  const verificationStatus = profile?.verificationStatus ?? undefined;
  const isOwnDashboard = userDetails?.consultantProfileId === routeParam;
  const { data: verification } = useVerificationStatus(
    userId,
    !!verificationStatus &&
      verificationStatus !== "VERIFIED" &&
      !!isOwnDashboard,
  );

  const verificationHref = `${basePath}/settings/verification`;
  // Gating policy: waiting states get a browsable dashboard + banner;
  // REJECTED gets the full-screen gate with the reviewer feedback threaded
  // in. Settings stays reachable in every state (it hosts the fix).
  const isSettingsPage =
    pathname.includes("/settings") || pathname.includes("/support");
  const showRejectedGate =
    verificationStatus === "REJECTED" && !isSettingsPage && !!isOwnDashboard;
  const showVerificationBanner =
    (verificationStatus === "PENDING_VERIFICATION" ||
      verificationStatus === "UNDER_REVIEW") &&
    !isSettingsPage &&
    !!isOwnDashboard;

  return {
    overlay: showRejectedGate ? (
      <VerificationPendingOverlay
        status="REJECTED"
        rejectionReason={
          verification?.latestRequest?.rejectionReason ?? undefined
        }
        feedbackDetails={
          verification?.latestRequest?.feedbackDetails ?? undefined
        }
        documentFeedback={verification?.latestRequest?.documentFeedback}
        resubmitUrl={verificationHref}
      />
    ) : undefined,
    banner:
      showVerificationBanner && verificationStatus ? (
        <VerificationBanner
          status={verificationStatus}
          resubmitUrl={verificationHref}
        />
      ) : undefined,
    badges: verificationStatus
      ? [
          {
            label: verificationStatusBadge(verificationStatus).label,
            className: verificationStatusBadge(verificationStatus).className,
          },
        ]
      : [],
  };
}

export default function ConsultantDashboardLayout(props: Readonly<PageProps>) {
  return (
    <BreadcrumbOverrideProvider>
      <ConsultantLayoutInner {...props} />
    </BreadcrumbOverrideProvider>
  );
}

function ConsultantLayoutInner({ children, params }: Readonly<PageProps>) {
  const { consultantId } = use(params);
  const shareHref = useExpertShareHref(consultantId);
  // The layout core reads this key too; the public page is live only once verified.
  const { data: profile } = useQuery({
    queryKey: ["consultant-data", consultantId],
    queryFn: () => consultantFetchers.details(consultantId),
    staleTime: 5 * 60 * 1000,
  });
  const verificationStatus = profile?.verificationStatus;
  const nav = useMemo(
    () =>
      consultantNavWithPublicPage(consultantId, shareHref, verificationStatus),
    [consultantId, shareHref, verificationStatus],
  );
  const settingsGroups = useMemo(
    () =>
      settingsSectionGroups().map((group) => ({
        title: group.title,
        sections: group.sections.map((section) => ({
          label: section.label,
          href: settingsSectionHref(
            `/dashboard/consultant/${consultantId}`,
            section,
          ),
        })),
      })),
    [consultantId],
  );

  const badges = usePersonalNavBadges({
    requestsForConsultantId: consultantId,
  });

  return (
    <PersonalDashboardLayoutCore<ConsultantDetails>
      routeParam={consultantId}
      nav={nav}
      settingsGroups={settingsGroups}
      badges={badges}
      chipRole={PERSONAL_SIDE_LABEL.consultant}
      identityFallbackName={PERSONAL_SIDE_LABEL.consultant}
      pageLabels={CONSULTANT_PAGE_LABELS}
      pathlessSegments={CONSULTANT_PATHLESS_SEGMENTS}
      offeringsConfig={OFFERINGS_CRUMBS}
      profileQueryKey={["consultant-data", consultantId]}
      fetchProfile={() =>
        consultantFetchers.details(
          consultantId,
        ) as Promise<ConsultantDetails | null>
      }
      profileDisplayName={(profile) => profile?.user?.name}
      profileOwnerName={(profile) => profile?.user?.name}
      profileDisplayImage={(profile) => profile?.user?.image}
      hasAccess={(user) =>
        !!user &&
        (user.role === "ADMIN" ||
          user.role === "STAFF" ||
          user.consultantProfileId === consultantId)
      }
      resolveRedirectTarget={(user) => {
        if (user.consultantProfileId) {
          return `/dashboard/consultant/${user.consultantProfileId}/home`;
        }
        if (user.consulteeProfileId) {
          return `/dashboard/consultee/${user.consulteeProfileId}/home`;
        }
        return "/dashboard";
      }}
      prefetchSuffixes={PREFETCH_SUFFIXES}
      useExtras={useConsultantExtras}
    >
      {children}
    </PersonalDashboardLayoutCore>
  );
}
