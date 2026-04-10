"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Building2, Plus } from "lucide-react";

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

interface OrgListItem {
  id: string;
  profileId: string;
  name: string;
  slug: string;
  logo: string | null;
  kind: "BUYER" | "PROVIDER" | "HYBRID";
  status: string;
  billingMode: "TAG_ONLY" | "SEAT_PACK" | "INVOICED_MONTHLY";
  role: string;
  isPlatformAdmin?: boolean;
}

async function fetchOrgs(): Promise<{ organizations: OrgListItem[] }> {
  const res = await fetch("/api/organizations");
  if (!res.ok) throw new Error("Failed to load organizations");
  return res.json();
}

export default function OrganizationLandingPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["organizations"],
    queryFn: fetchOrgs,
  });

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
        ) : data && data.organizations.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {data.organizations.map((org) => (
              <Link
                key={org.id}
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
                    <Badge variant="secondary">{org.kind}</Badge>
                    <Badge variant="outline">{org.billingMode}</Badge>
                    <Badge>{org.role}</Badge>
                  </CardContent>
                </Card>
              </Link>
            ))}
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
