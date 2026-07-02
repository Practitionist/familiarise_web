"use client";

import { use, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { Globe, Shield, FileText } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  FundingSource,
  GstRegStatus,
  OrgStatus,
} from "@prisma/client";

import { useOrgRole, useRequireOrgRole } from "../useOrgRole";
import { orgDetailsQueryKey } from "@/lib/api/organizations/org-details";
import {
  DashboardHeader,
  DashboardContent,
} from "@/components/dashboard/PageScaffold";
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
    // Optimistic-lock clock — echoed back as expectedVersion on PATCH.
    version: number;
    canSponsor: boolean;
    canHost: boolean;
    billingEmail: string | null;
    description: string | null;
    industry: string | null;
    website: string | null;
    paymentTermsDays: number;
    isPublic: boolean;
    billingAccount?: { fundingSource: FundingSource } | null;
    // #777 §B — OrganizationTaxInfo satellite, non-secret fields only.
    // null when the org has no taxInfo row yet.
    taxInfo?: {
      gstin: string | null;
      gstStateCode: string | null;
      gstRegStatus: GstRegStatus;
      panLast4: string | null;
    } | null;
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
  // #777 §B — tax identity lives on the OrganizationTaxInfo satellite;
  // the org PATCH route upserts it. OWNER-gated server-side.
  gstin?: string | null;
  gstStateCode?: string | null;
  gstRegStatus?: GstRegStatus;
  expectedVersion?: number;
}

async function patchSettings(orgId: string, payload: PatchPayload) {
  const res = await fetch(`/api/organizations/${orgId}/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  if (!res.ok) {
    // Carry the structured code so onError can branch (VERSION_CONFLICT →
    // stale-tab dialog instead of the generic error banner).
    throw Object.assign(new Error(body.error || "Failed to update settings"), {
      code: body.code as string | undefined,
      currentVersion: body.currentVersion as number | undefined,
    });
  }
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
  // #777 §B — Tax & compliance (OrganizationTaxInfo). UNREGISTERED is the
  // schema default, so an org with no taxInfo row reads as UNREGISTERED.
  const [gstin, setGstin] = useState("");
  const [gstStateCode, setGstStateCode] = useState("");
  const [gstRegStatus, setGstRegStatus] =
    useState<GstRegStatus>("UNREGISTERED");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [pendingDisable, setPendingDisable] = useState<
    null | "canSponsor" | "canHost"
  >(null);
  // Stale-tab write rejected by the server's version CAS (409
  // VERSION_CONFLICT) — the dialog offers a reload instead of silently
  // letting last-write-wins eat the other session's changes.
  const [conflictOpen, setConflictOpen] = useState(false);

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
    setGstin(data.profile.taxInfo?.gstin ?? "");
    setGstStateCode(data.profile.taxInfo?.gstStateCode ?? "");
    setGstRegStatus(data.profile.taxInfo?.gstRegStatus ?? "UNREGISTERED");
  }, [data]);

  const mutation = useMutation({
    // #779 §A — the API enforces field-level RBAC: descriptive fields are
    // MAINTAINER+, slug/isPublic OWNER-only, billingEmail/paymentTermsDays
    // BILLING_ADMIN-or-OWNER. Send only what this role may touch so a
    // maintainer's rename doesn't 403 on fields they never edited.
    mutationFn: (overrides?: PatchPayload) =>
      patchSettings(orgId, {
        name: name.trim(),
        description: description.trim() || null,
        industry: industry.trim() || null,
        website: website.trim() || null,
        // Optimistic lock — the server CASes on this and 409s a stale tab.
        ...(data && { expectedVersion: data.profile.version }),
        ...(isAtLeast("OWNER") && {
          slug: slug.trim() || undefined,
          billingEmail: billingEmail.trim() || null,
          paymentTermsDays: parseInt(paymentTermsDays, 10),
          isPublic,
        }),
        ...overrides,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["org-settings", orgId] });
      queryClient.invalidateQueries({ queryKey: orgDetailsQueryKey(orgId) });
      setSuccess(true);
      setError(null);
      setTimeout(() => setSuccess(false), 2500);
    },
    onError: (err: Error & { code?: string }) => {
      if (err.code === "VERSION_CONFLICT") {
        setConflictOpen(true);
        setSuccess(false);
        return;
      }
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

  // #777 §B — narrow tax-only PATCH so saving GSTIN doesn't drag every
  // Profile field along. GSTIN is exactly 15 chars (API rejects partials
  // with a 400); empty → null clears the satellite field. The API gates
  // the whole taxInfo upsert OWNER-only, matching the UI gate below.
  const trimmedGstin = gstin.trim().toUpperCase();
  const gstinValid = trimmedGstin.length === 0 || trimmedGstin.length === 15;
  // GST state code is exactly 2 digits (e.g. "29"); empty clears it. An
  // invalid value blocks the save with an error instead of silently saving
  // null while the input still shows the bad value.
  const trimmedStateCode = gstStateCode.trim();
  const stateCodeValid =
    trimmedStateCode.length === 0 || /^\d{2}$/.test(trimmedStateCode);
  const saveTaxInfo = () => {
    if (!gstinValid) return;
    if (!stateCodeValid) {
      setError("GST state code must be exactly 2 digits (e.g. 29).");
      return;
    }
    setError(null);
    mutation.mutate({
      gstin: trimmedGstin.length === 15 ? trimmedGstin : null,
      gstStateCode: trimmedStateCode.length === 2 ? trimmedStateCode : null,
      gstRegStatus,
    });
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
            {/* #779 TODO: these fields are MAINTAINER-enabled in the UI but
                the org PATCH route is requireOrgOwner — a MAINTAINER save
                gets a silent 403. RBAC redistribution (widen the API to
                MAINTAINER for the profile subset, or disable here for
                non-OWNER) is deferred to v4; not broadening API auth in
                this PR. */}
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
                    // #779 §A — finance remit: BILLING_ADMIN edits this via the
                    // billing page; on THIS page only OWNER may change it.
                    disabled={!isAtLeast("OWNER")}
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
                    // #779 §A — finance remit (BILLING_ADMIN edits via billing;
                    // OWNER here).
                    disabled={!isAtLeast("OWNER")}
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

        {/* #777 §B — Tax & compliance (GSTIN / GST state / reg status).
            Writes to the OrganizationTaxInfo satellite via the org PATCH
            upsert, which gates the whole tax block OWNER-only — so the
            section is hidden for non-owners (read or edit) to avoid a
            silent 403. PAN capture is intentionally out of scope here
            (encrypted-at-rest; managed via the dedicated tax surface). */}
        {isAtLeast("OWNER") && (
          <Card className="mt-6">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FileText className="w-4 h-4" /> Tax &amp; compliance
              </CardTitle>
              <CardDescription>
                India GST identity used on invoices and for 3-way-match
                reconciliation. Only owners can edit these.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="gstin">GSTIN</Label>
                  <Input
                    id="gstin"
                    value={gstin}
                    onChange={(e) =>
                      setGstin(e.target.value.toUpperCase().slice(0, 15))
                    }
                    placeholder="22AAAAA0000A1Z5"
                    maxLength={15}
                  />
                  {!gstinValid && (
                    <p className="text-xs text-red-600">
                      GSTIN must be exactly 15 characters.
                    </p>
                  )}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="gst-state-code">GST state code</Label>
                  <Input
                    id="gst-state-code"
                    value={gstStateCode}
                    onChange={(e) =>
                      setGstStateCode(
                        e.target.value.replace(/[^0-9]/g, "").slice(0, 2),
                      )
                    }
                    placeholder="e.g. 22"
                    maxLength={2}
                  />
                  <p className="text-xs text-zinc-500">
                    First two digits of the GSTIN — the state of registration.
                  </p>
                </div>
              </div>

              <div className="space-y-2 md:w-1/2">
                <Label htmlFor="gst-reg-status">GST registration status</Label>
                <Select
                  value={gstRegStatus}
                  onValueChange={(v) => setGstRegStatus(v as GstRegStatus)}
                >
                  <SelectTrigger id="gst-reg-status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="REGULAR">Regular</SelectItem>
                    <SelectItem value="COMPOSITION">Composition</SelectItem>
                    <SelectItem value="UNREGISTERED">Unregistered</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {data.profile.taxInfo?.panLast4 && (
                <p className="text-xs text-zinc-500">
                  PAN on file ending in {data.profile.taxInfo.panLast4}.
                </p>
              )}
            </CardContent>
            <CardFooter>
              <Button
                onClick={saveTaxInfo}
                disabled={mutation.isPending || !gstinValid}
              >
                {mutation.isPending ? "Saving…" : "Save tax details"}
              </Button>
            </CardFooter>
          </Card>
        )}

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

        <AlertDialog open={conflictOpen} onOpenChange={setConflictOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Settings changed elsewhere</AlertDialogTitle>
              <AlertDialogDescription>
                Another session (a second tab, or a teammate) saved these
                settings after you loaded this page. Your change was not
                applied. Reload to see the latest values, then make your edit
                again.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogAction
                onClick={() => {
                  setConflictOpen(false);
                  // Refetch resets every form field via the data-sync effect.
                  queryClient.invalidateQueries({
                    queryKey: ["org-settings", orgId],
                  });
                }}
              >
                Reload settings
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DashboardContent>
    </>
  );
}
