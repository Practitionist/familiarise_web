"use client";

import { use, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { Globe, Shield } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
  slug?: string;
  billingEmail?: string | null;
  description?: string | null;
  industry?: string | null;
  website?: string | null;
  paymentTermsDays?: number;
  isPublic?: boolean;
  canSponsor?: boolean;
  canHost?: boolean;
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
  const [slug, setSlug] = useState("");
  const [billingEmail, setBillingEmail] = useState("");
  const [description, setDescription] = useState("");
  const [industry, setIndustry] = useState("");
  const [website, setWebsite] = useState("");
  const [paymentTermsDays, setPaymentTermsDays] = useState("60");
  const [isPublic, setIsPublic] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [pendingDisable, setPendingDisable] = useState<
    null | "canSponsor" | "canHost"
  >(null);

  useEffect(() => {
    if (!data) return;
    setName(data.organization?.name ?? "");
    setSlug(data.organization?.slug ?? "");
    setBillingEmail(data.profile.billingEmail ?? "");
    setDescription(data.profile.description ?? "");
    setIndustry(data.profile.industry ?? "");
    setWebsite(data.profile.website ?? "");
    setPaymentTermsDays(String(data.profile.paymentTermsDays));
    setIsPublic(data.profile.isPublic ?? false);
  }, [data]);

  const mutation = useMutation({
    mutationFn: (overrides?: PatchPayload) =>
      patchSettings(orgId, {
        name: name.trim(),
        slug: slug.trim() || undefined,
        billingEmail: billingEmail.trim() || null,
        description: description.trim() || null,
        industry: industry.trim() || null,
        website: website.trim() || null,
        paymentTermsDays: parseInt(paymentTermsDays, 10),
        isPublic,
        ...overrides,
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

  // Capability toggle is a narrow single-field PATCH so flipping a
  // capability doesn't accidentally save every Profile field. Server
  // enforces guards (disable-both, wallet>0) — surfaced inline via
  // `error` from onError. Source of truth stays on `data.profile.*`,
  // so a 409 leaves the checkbox at its true value with no manual rollback.
  const handleCapabilityToggle = (
    field: "canSponsor" | "canHost",
    nextValue: boolean,
  ) => {
    if (!data) return;
    const current = field === "canSponsor" ? data.profile.canSponsor : data.profile.canHost;
    if (nextValue === current) return;
    if (nextValue === false) {
      setPendingDisable(field);
      return;
    }
    mutation.mutate({ [field]: nextValue });
  };

  const confirmCapabilityDisable = () => {
    if (!pendingDisable) return;
    mutation.mutate({ [pendingDisable]: false });
    setPendingDisable(null);
  };

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
        {/* Capability + funding summary. Owners can flip canSponsor /
            canHost in-place; non-owners see the read-only badge.
            Funding source changes still go through the billing-account
            route since they cascade to wallet / contract state. */}
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="text-base">Organization shape</CardTitle>
            <CardDescription>
              Capability + funding source determine what checkout does when
              members book.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-3">
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
            </div>

            {isAtLeast("OWNER") && (
              <div className="space-y-3 border-t border-zinc-200 pt-4">
                <p className="text-xs font-medium uppercase text-zinc-500">
                  Capability
                </p>
                <label className="flex items-start gap-3 rounded-md border border-zinc-200 p-3 cursor-pointer hover:border-zinc-300">
                  <Checkbox
                    checked={data.profile.canSponsor}
                    disabled={mutation.isPending}
                    onCheckedChange={(v) =>
                      handleCapabilityToggle("canSponsor", v === true)
                    }
                    className="mt-0.5"
                  />
                  <div>
                    <p className="text-sm font-medium">Sponsor members</p>
                    <p className="text-xs text-zinc-500">
                      The organization pays for its members&apos; sessions via
                      its billing account. Disabling requires a zero wallet
                      balance.
                    </p>
                  </div>
                </label>
                <label className="flex items-start gap-3 rounded-md border border-zinc-200 p-3 cursor-pointer hover:border-zinc-300">
                  <Checkbox
                    checked={data.profile.canHost}
                    disabled={mutation.isPending}
                    onCheckedChange={(v) =>
                      handleCapabilityToggle("canHost", v === true)
                    }
                    className="mt-0.5"
                  />
                  <div>
                    <p className="text-sm font-medium">Host consultants</p>
                    <p className="text-xs text-zinc-500">
                      The organization hosts consultants who deliver sessions.
                      Enables the payout account, rate cards, and the Experts +
                      Payouts sidebar entries.
                    </p>
                  </div>
                </label>
              </div>
            )}
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
                mutation.mutate(undefined);
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
                <Label htmlFor="slug">URL slug</Label>
                <div className="flex items-center gap-2 rounded-md border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm">
                  <span className="text-zinc-500">
                    /explore/enterprise/organisations/
                  </span>
                  <Input
                    id="slug"
                    value={slug}
                    onChange={(e) =>
                      setSlug(
                        e.target.value
                          .toLowerCase()
                          .replace(/[^a-z0-9-]/g, "-"),
                      )
                    }
                    disabled={!isAtLeast("OWNER")}
                    className="border-0 bg-transparent px-1 py-0 h-auto shadow-none focus-visible:ring-0"
                    placeholder="acme-school"
                  />
                </div>
                <p className="text-xs text-zinc-500">
                  Public discovery URL for the org. Changing the slug breaks
                  any inbound links pointing to the old URL — only owners can
                  edit.
                </p>
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
                  onClick={() => mutation.mutate(undefined)}
                  disabled={mutation.isPending}
                >
                  {mutation.isPending ? "Saving…" : "Save visibility"}
                </Button>
              </CardFooter>
            )}
          </Card>
        )}

        <AlertDialog
          open={pendingDisable !== null}
          onOpenChange={(open) => !open && setPendingDisable(null)}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {pendingDisable === "canSponsor"
                  ? "Disable sponsor capability?"
                  : "Disable host capability?"}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {pendingDisable === "canSponsor"
                  ? "Members will no longer be able to bill the organization for new sessions. The Billing surface and any active programs will be hidden. The wallet must already be at ₹0 — the server will reject the change otherwise."
                  : "External consultants will stop earning through this organization. The Experts and Payouts surfaces will be hidden. Existing earnings remain payable."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={confirmCapabilityDisable}>
                Disable
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DashboardContent>
    </>
  );
}
