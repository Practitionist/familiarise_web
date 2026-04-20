"use client";

import { use, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { Globe, Shield } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import type { FundingSource, OrgStatus } from "@prisma/client";

import { useOrgRole, useRequireOrgRole } from "../useOrgRole";
import { orgDetailsQueryKey } from "@/lib/api/organizations/org-details";
import {
  DashboardHeader,
  DashboardContent,
} from "@/components/dashboard/DashboardShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  FUNDING_SOURCE_LABEL,
  CAPABILITY_BADGE_CLASS,
  CAPABILITY_LABEL,
  deriveCapabilityKind,
} from "@/lib/labels/org-labels";

// ---------------------------------------------------------------------------
// Types — GET /api/organizations/[orgId]/settings returns
//   { organization: { id, name, slug, logo }, profile: Organization }
// where `profile` is the Prisma Organization row (Arch 4 shape).
// ---------------------------------------------------------------------------

interface SettingsResponse {
  organization: {
    id: string;
    name: string;
    slug: string;
    logo: string | null;
  } | null;
  profile: {
    id: string;
    status: OrgStatus;
    canSponsor: boolean;
    canHost: boolean;
    billingEmail: string | null;
    description: string | null;
    industry: string | null;
    website: string | null;
    paymentTermsDays: number;
    isPublic: boolean;
    billingAccount?: { fundingSource: FundingSource } | null;
  };
}

async function fetchSettings(orgId: string): Promise<SettingsResponse> {
  const res = await fetch(`/api/organizations/${orgId}/settings`);
  if (!res.ok) throw new Error("Failed to load settings");
  return res.json();
}

interface PatchPayload {
  name?: string;
  billingEmail?: string | null;
  description?: string | null;
  industry?: string | null;
  website?: string | null;
  paymentTermsDays?: number;
  isPublic?: boolean;
}

async function patchSettings(orgId: string, payload: PatchPayload) {
  const res = await fetch(`/api/organizations/${orgId}/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || "Failed to update settings");
  return body;
}

export default function OrgSettingsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = use(params);
  const { isAtLeast } = useOrgRole(orgId);
  const { allowed } = useRequireOrgRole(orgId, "MAINTAINER");
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["org-settings", orgId],
    queryFn: () => fetchSettings(orgId),
    enabled: allowed,
  });

  const [name, setName] = useState("");
  const [billingEmail, setBillingEmail] = useState("");
  const [description, setDescription] = useState("");
  const [industry, setIndustry] = useState("");
  const [website, setWebsite] = useState("");
  const [paymentTermsDays, setPaymentTermsDays] = useState("60");
  const [isPublic, setIsPublic] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (!data) return;
    setName(data.organization?.name ?? "");
    setBillingEmail(data.profile.billingEmail ?? "");
    setDescription(data.profile.description ?? "");
    setIndustry(data.profile.industry ?? "");
    setWebsite(data.profile.website ?? "");
    setPaymentTermsDays(String(data.profile.paymentTermsDays));
    setIsPublic(data.profile.isPublic ?? false);
  }, [data]);

  const mutation = useMutation({
    mutationFn: () =>
      patchSettings(orgId, {
        name: name.trim(),
        billingEmail: billingEmail.trim() || null,
        description: description.trim() || null,
        industry: industry.trim() || null,
        website: website.trim() || null,
        paymentTermsDays: parseInt(paymentTermsDays, 10),
        isPublic,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["org-settings", orgId] });
      queryClient.invalidateQueries({ queryKey: orgDetailsQueryKey(orgId) });
      setSuccess(true);
      setError(null);
      setTimeout(() => setSuccess(false), 2500);
    },
    onError: (err: Error) => {
      setError(err.message);
      setSuccess(false);
    },
  });

  if (!allowed) return null;

  if (isLoading || !data) {
    return (
      <>
        <DashboardHeader title="Settings" />
        <DashboardContent>
          <p className="text-sm text-zinc-500">Loading…</p>
        </DashboardContent>
      </>
    );
  }

  const capabilityKind = deriveCapabilityKind(
    data.profile.canSponsor,
    data.profile.canHost,
  );
  const fundingSource = data.profile.billingAccount?.fundingSource;

  return (
    <>
      <DashboardHeader
        title="Settings"
        subtitle="Organization profile, billing email, and limits"
        actions={
          isAtLeast("OWNER") && (
            <Link href={`/dashboard/organization/${orgId}/settings/sso`}>
              <Button size="sm" variant="outline">
                <Shield className="h-4 w-4 mr-1" /> SSO settings
              </Button>
            </Link>
          )
        }
      />
      <DashboardContent>
        {/* Capability + funding summary — read-only snapshot so admins
            can see the org's shape without having to dig through docs.
            Capability changes happen via PATCH to the org resource;
            funding source changes go through the billing-account route. */}
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="text-base">Organization shape</CardTitle>
            <CardDescription>
              Capability + funding source determine what checkout does when
              members book. Change them via the billing or capability flows.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-3">
            <Badge
              variant="secondary"
              className={CAPABILITY_BADGE_CLASS[capabilityKind]}
            >
              {CAPABILITY_LABEL[capabilityKind]}
            </Badge>
            {fundingSource && (
              <Badge variant="outline">
                Funding: {FUNDING_SOURCE_LABEL[fundingSource]}
              </Badge>
            )}
            <Badge variant="outline">Status: {data.profile.status}</Badge>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Profile</CardTitle>
            <CardDescription>
              These details are visible to your members and used on invoices.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                mutation.mutate();
              }}
              className="space-y-4"
            >
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="name">Name</Label>
                  <Input
                    id="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    disabled={!isAtLeast("MAINTAINER")}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="billing-email">Billing email</Label>
                  <Input
                    id="billing-email"
                    type="email"
                    value={billingEmail}
                    onChange={(e) => setBillingEmail(e.target.value)}
                    disabled={!isAtLeast("MAINTAINER")}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="description">Description</Label>
                <Input
                  id="description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Short description of the organization"
                  disabled={!isAtLeast("MAINTAINER")}
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="industry">Industry</Label>
                  <Input
                    id="industry"
                    value={industry}
                    onChange={(e) => setIndustry(e.target.value)}
                    placeholder="e.g. Education, Software"
                    disabled={!isAtLeast("MAINTAINER")}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="website">Website</Label>
                  <Input
                    id="website"
                    type="url"
                    value={website}
                    onChange={(e) => setWebsite(e.target.value)}
                    placeholder="https://example.com"
                    disabled={!isAtLeast("MAINTAINER")}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="terms">Payment terms (days)</Label>
                  <Input
                    id="terms"
                    type="number"
                    min="1"
                    max="120"
                    value={paymentTermsDays}
                    onChange={(e) => setPaymentTermsDays(e.target.value)}
                    disabled={!isAtLeast("MAINTAINER")}
                  />
                  <p className="text-xs text-zinc-500">
                    India default is NET-60. Only applies when funding
                    source is INVOICE.
                  </p>
                </div>
              </div>

              {error && <p className="text-sm text-red-600">{error}</p>}
              {success && (
                <p className="text-sm text-emerald-600">Settings saved.</p>
              )}

              {isAtLeast("MAINTAINER") && (
                <div>
                  <Button type="submit" disabled={mutation.isPending}>
                    {mutation.isPending ? "Saving…" : "Save changes"}
                  </Button>
                </div>
              )}
            </form>
          </CardContent>
        </Card>

        {/* Marketplace Visibility — only HOST/HYBRID orgs can opt in */}
        {data.profile.canHost && (
          <Card className="mt-6">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Globe className="w-4 h-4" /> Marketplace Visibility
              </CardTitle>
              <CardDescription>
                Allow learners and companies to discover this organisation on{" "}
                <Link
                  href="/explore/enterprise/organisations"
                  className="underline hover:text-zinc-700"
                >
                  Explore Organisations
                </Link>
                . Your experts and programs will be visible to anonymous
                visitors.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium">Public listing</p>
                  <p className="text-xs text-zinc-500 mt-0.5">
                    {data.profile.status !== "ACTIVE"
                      ? "Organisation must be ACTIVE before enabling public listing."
                      : isPublic
                        ? "Your organisation appears on the Explore page."
                        : "Your organisation is hidden from the Explore page."}
                  </p>
                </div>
                <Switch
                  checked={isPublic}
                  onCheckedChange={setIsPublic}
                  disabled={
                    data.profile.status !== "ACTIVE" ||
                    !isAtLeast("OWNER") ||
                    mutation.isPending
                  }
                />
              </div>
            </CardContent>
            {isAtLeast("OWNER") && (
              <CardFooter>
                <Button
                  onClick={() => mutation.mutate()}
                  disabled={mutation.isPending}
                >
                  {mutation.isPending ? "Saving…" : "Save visibility"}
                </Button>
              </CardFooter>
            )}
          </Card>
        )}
      </DashboardContent>
    </>
  );
}
