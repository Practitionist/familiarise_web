"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Building2, Plus } from "lucide-react";
import type { FundingSource, MemberRole, OrgStatus } from "@prisma/client";

import {
  DashboardHeader,
  DashboardContent,
} from "@/components/dashboard/DashboardShell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  deriveCapabilityKind,
  CAPABILITY_LABEL,
  CAPABILITY_BADGE_CLASS,
  FUNDING_SOURCE_LABEL,
  FUNDING_SOURCE_BADGE_CLASS,
  MEMBER_ROLE_LABEL,
} from "@/lib/labels/org-labels";

// Row shape comes from GET /api/organizations. Keep this aligned with the
// server's `memberships.map(...)` projection in app/api/organizations/route.ts
// — capability is carried as the two booleans + fundingSource (nested under
// billingAccount), and the UI derives the kind label via
// deriveCapabilityKind() rather than relying on a server-side enum.
interface OrgMembershipRow {
  membershipId: string;
  role: MemberRole;
  status: string;
  organization: {
    id: string;
    name: string;
    slug: string;
    logo: string | null;
    status: OrgStatus;
    canSponsor: boolean;
    canHost: boolean;
    billingAccount: {
      fundingSource: FundingSource;
      walletBalance: number | null;
      currency: string;
    } | null;
  };
}

async function fetchOrgs(): Promise<{ data: OrgMembershipRow[] }> {
  const res = await fetch("/api/organizations");
  if (!res.ok) throw new Error("Failed to load organizations");
  return res.json();
}

export default function OrganizationLandingPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["organizations"],
    queryFn: fetchOrgs,
  });

  const rows = data?.data ?? [];

  return (
    <>
      <DashboardHeader
        title="Organizations"
        subtitle="Schools, corporates, and teams you belong to"
        actions={
          <Link href="/dashboard/organization/create">
            <Button size="sm">
              <Plus className="h-4 w-4 mr-1" /> New organization
            </Button>
          </Link>
        }
      />
      <DashboardContent>
        {isLoading ? (
          <p className="text-sm text-zinc-500">Loading organizations…</p>
        ) : rows.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {rows.map((row) => {
              const org = row.organization;
              const kind = deriveCapabilityKind(org.canSponsor, org.canHost);
              const funding = org.billingAccount?.fundingSource ?? null;
              return (
                <Link
                  key={row.membershipId}
                  href={`/dashboard/organization/${org.id}/home`}
                  className="group"
                >
                  <Card className="h-full hover:border-zinc-400 transition-colors">
                    <CardHeader>
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-lg bg-zinc-100 flex items-center justify-center overflow-hidden">
                          {org.logo ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={org.logo}
                              alt={org.name}
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <Building2 className="w-5 h-5 text-zinc-500" />
                          )}
                        </div>
                        <div className="min-w-0">
                          <CardTitle className="truncate text-base">
                            {org.name}
                          </CardTitle>
                          <CardDescription className="text-xs">
                            {org.slug}
                          </CardDescription>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent className="flex flex-wrap gap-2">
                      <Badge
                        variant="secondary"
                        className={CAPABILITY_BADGE_CLASS[kind]}
                      >
                        {CAPABILITY_LABEL[kind]}
                      </Badge>
                      {funding && (
                        <Badge
                          variant="outline"
                          className={FUNDING_SOURCE_BADGE_CLASS[funding]}
                        >
                          {FUNDING_SOURCE_LABEL[funding]}
                        </Badge>
                      )}
                      <Badge>{MEMBER_ROLE_LABEL[row.role]}</Badge>
                    </CardContent>
                  </Card>
                </Link>
              );
            })}
          </div>
        ) : (
          <Card>
            <CardContent className="py-10 text-center">
              <Building2 className="w-10 h-10 mx-auto mb-3 text-zinc-400" />
              <p className="text-sm text-zinc-600">
                You are not part of any organization yet.
              </p>
              <Link href="/dashboard/organization/create">
                <Button size="sm" className="mt-4">
                  Create your first organization
                </Button>
              </Link>
            </CardContent>
          </Card>
        )}
      </DashboardContent>
    </>
  );
}
