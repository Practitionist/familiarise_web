"use client";

import Link from "next/link";
import type { MemberRole } from "@prisma/client";

import {
  DashboardHeader,
  DashboardContent,
} from "@/components/dashboard/PageScaffold";
import { Section } from "@/components/dashboard/Section";
import { StatRow, StatSkeleton } from "@/components/dashboard/Stat";
import { Button } from "@/components/ui/button";
import { useOrgRole } from "../useOrgRole";
import { FinanceLeadViewCard } from "./FinanceLeadViewCard";
import { OperatorHome } from "./OperatorHome";
import { SupportHome } from "./SupportHome";

const OPERATOR_ROLES: ReadonlySet<MemberRole> = new Set([
  "OWNER",
  "MAINTAINER",
  "MANAGER",
]);

function MemberHome({
  orgId,
  role,
  canSponsor,
  canHost,
}: Readonly<{
  orgId: string;
  role: MemberRole;
  canSponsor: boolean;
  canHost: boolean;
}>) {
  const base = `/dashboard/organization/${orgId}`;
  let primary = {
    title: "Your sessions under this organization",
    body: "Sessions you attend or deliver under this organization are listed in Appointments.",
    ctaLabel: "Open Appointments",
    ctaHref: `${base}/appointments`,
  };
  if (role === "LEARNER" && canSponsor) {
    primary = {
      title: "Your sponsored sessions live here",
      body: "This organization covers your sessions through one or more programs. My Program shows your current allowance and recent activity.",
      ctaLabel: "Open My Program",
      ctaHref: `${base}/my-program`,
    };
  } else if (role === "EXPERT" && canHost) {
    primary = {
      title: "Your arrangement with this organization",
      body: "Compensation shows the split this organization pays on your sessions and what you have earned under it.",
      ctaLabel: "Open Compensation",
      ctaHref: `${base}/compensation`,
    };
  }
  return (
    <Section title={primary.title} description={primary.body} variant="card">
      <div className="flex flex-wrap items-center gap-3">
        <Button asChild>
          <Link href={primary.ctaHref}>{primary.ctaLabel}</Link>
        </Button>
        <Link
          href="/dashboard"
          className="text-sm text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          Or go to my personal dashboard
        </Link>
      </div>
    </Section>
  );
}

/**
 * Org Overview, shaped by role (#1527 §7.3): operators get the action centre
 * and checklist, BILLING_ADMIN a finance overview from billing/payout reads
 * (analytics 403s for them), SUPPORT the support-queue summary, and members
 * the door to My Program, Compensation or Appointments.
 */
export function HomePageClient({ orgId }: { orgId: string }) {
  const { role, canSponsor, canHost, isLoading } = useOrgRole(orgId);

  // Role resolves LEARNER while the org payload is in flight (fail-closed in
  // useOrgRole); a neutral skeleton avoids painting the wrong home first.
  if (isLoading) {
    return (
      <>
        <DashboardHeader title="Overview" />
        <DashboardContent>
          <StatRow columns={4}>
            <StatSkeleton />
            <StatSkeleton />
            <StatSkeleton />
            <StatSkeleton />
          </StatRow>
        </DashboardContent>
      </>
    );
  }

  let title = "Overview";
  let description = "Your membership on this organization.";
  let body: React.ReactNode;
  if (OPERATOR_ROLES.has(role)) {
    description = "What needs doing on this organization.";
    body = <OperatorHome orgId={orgId} />;
  } else if (role === "BILLING_ADMIN") {
    title = "Finance overview";
    description = "Invoices, balances and payouts on this organization.";
    body = (
      <FinanceLeadViewCard
        orgId={orgId}
        canSponsor={canSponsor}
        canHost={canHost}
      />
    );
  } else if (role === "SUPPORT") {
    description = "Member support on this organization.";
    body = <SupportHome orgId={orgId} />;
  } else {
    body = (
      <MemberHome
        orgId={orgId}
        role={role}
        canSponsor={canSponsor}
        canHost={canHost}
      />
    );
  }

  return (
    <>
      <DashboardHeader title={title} description={description} />
      <DashboardContent>{body}</DashboardContent>
    </>
  );
}
