"use client";

import { use, useMemo } from "react";
import type { User } from "@prisma/client";

import { BreadcrumbOverrideProvider } from "@/components/dashboard/breadcrumb-override";
import {
  PersonalDashboardLayoutCore,
  type PersonalDashboardUser,
} from "@/components/dashboard/PersonalDashboardLayoutCore";
import {
  buildConsulteeNav,
  CONSULTEE_PAGE_LABELS,
} from "@/lib/dashboard/nav/consultee";
import { usePersonalNavBadges } from "@/hooks/usePersonalNavBadges";
import { fetchConsulteeDetails, fetchUserDetails } from "@/lib/user";
import { UserProvider } from "./UserContext";

const PREFETCH_SUFFIXES = ["home"];

// Module-level so it is not a nested component definition: the shell must
// not remount the provider subtree on every layout render.
// Boundary cast: the core's structural user carries the Prisma User payload
// at runtime; UserProvider types it as Prisma User.
function wrapConsulteeShell(
  shell: React.ReactNode,
  user: PersonalDashboardUser,
) {
  return <UserProvider userDetails={user as User}>{shell}</UserProvider>;
}

interface PageProps {
  children: React.ReactNode;
  params: Promise<{ consulteeId: string }>;
}

export default function ConsulteeLayout(props: Readonly<PageProps>) {
  return (
    <BreadcrumbOverrideProvider>
      <ConsulteeLayoutInner {...props} />
    </BreadcrumbOverrideProvider>
  );
}

function ConsulteeLayoutInner({ children, params }: Readonly<PageProps>) {
  const { consulteeId } = use(params);
  const nav = useMemo(() => buildConsulteeNav(consulteeId), [consulteeId]);
  const badges = usePersonalNavBadges({});

  return (
    <PersonalDashboardLayoutCore
      routeParam={consulteeId}
      nav={nav}
      badges={badges}
      chipRole="Client"
      identityFallbackName="Client"
      pageLabels={CONSULTEE_PAGE_LABELS}
      fetchUser={(userId) => fetchUserDetails(userId)}
      profileQueryKey={["consultee-profile", consulteeId]}
      fetchProfile={() => fetchConsulteeDetails(consulteeId)}
      profileGatesOnUser={false}
      hasAccess={(user) =>
        !!user &&
        (user.role === "ADMIN" ||
          user.role === "STAFF" ||
          user.consulteeProfileId === consulteeId)
      }
      resolveRedirectTarget={(user) =>
        user.consulteeProfileId && user.consulteeProfileId !== consulteeId
          ? `/dashboard/consultee/${user.consulteeProfileId}/home`
          : "/dashboard"
      }
      prefetchSuffixes={PREFETCH_SUFFIXES}
      requireUserDetails
      includeUserError
      wrapShell={wrapConsulteeShell}
    >
      {children}
    </PersonalDashboardLayoutCore>
  );
}
