"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Globe, FileText, AlertTriangle, Loader2, Video } from "lucide-react";
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
  MsmeStatus,
  OrgStatus,
} from "@prisma/client";

import { useOrgRole } from "../useOrgRole";
import { CancellationPolicyCard } from "./CancellationPolicyCard";
import { orgDetailsQueryKey } from "@/lib/api/organizations/org-details";
import { PanelHeader } from "@/components/dashboard/PageScaffold";
import { ConfirmDialog } from "@/components/dashboard/ConfirmDialog";
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
import { humanizeEnum } from "@/lib/ui/tone";
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
    // Owner-set cap on org recording retention; null follows the platform schedule.
    streamRecordingRetentionDays: number | null;
    // #779 §A — verification lifecycle (banner + resubmit affordance).
    verificationReason?: string | null;
    verificationRejectedAt?: string | null;
    // #1230 wave-4 — MSME declaration satellite.
    msmeInfo?: {
      msmeStatus: MsmeStatus;
      msmeWrittenAgreementOnFile: boolean;
    } | null;
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
  description?: string | null;
  industry?: string | null;
  website?: string | null;
  isPublic?: boolean;
  canSponsor?: boolean;
  canHost?: boolean;
  // #777 §B — tax identity lives on the OrganizationTaxInfo satellite;
  // the org PATCH route upserts it. OWNER-gated server-side.
  gstin?: string | null;
  gstStateCode?: string | null;
  gstRegStatus?: GstRegStatus;
  pan?: string | null;
  // #1230 wave-4 — MSME declaration rides the same PATCH upsert.
  msmeStatus?: MsmeStatus;
  msmeWrittenAgreementOnFile?: boolean;
  streamRecordingRetentionDays?: number | null;
  expectedVersion?: number;
}

const PatchErrorBodySchema = z.object({
  error: z.string().optional(),
  code: z.string().optional(),
});

/** Carries the API's structured code so VERSION_CONFLICT opens the stale-tab dialog. */
class SettingsPatchError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
  ) {
    super(message);
  }
}

const isVersionConflict = (err: unknown) =>
  err instanceof SettingsPatchError && err.code === "VERSION_CONFLICT";

async function patchSettings(orgId: string, payload: PatchPayload) {
  const res = await fetch(`/api/organizations/${orgId}/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  if (!res.ok) {
    const parsed = PatchErrorBodySchema.safeParse(body);
    const errorBody = parsed.success ? parsed.data : {};
    throw new SettingsPatchError(
      errorBody.error ?? "Failed to update settings",
      errorBody.code,
    );
  }
  return body;
}

function resolveMarketplaceVisibilityCopy(
  status: OrgStatus,
  isPublic: boolean,
): string {
  if (status !== "ACTIVE") {
    return "Organisation must be ACTIVE before enabling public listing.";
  }
  if (isPublic) {
    return "Your organisation appears on the Explore page.";
  }
  return "Your organisation is hidden from the Explore page.";
}

function TaxComplianceCard({
  orgId,
  data,
  onVersionConflict,
  onError,
  onSuccess,
}: Readonly<{
  orgId: string;
  data: SettingsResponse;
  onVersionConflict: () => void;
  onError: (msg: string | null) => void;
  onSuccess: () => void;
}>) {
  const queryClient = useQueryClient();
  const [gstin, setGstin] = useState(data.profile.taxInfo?.gstin ?? "");
  const [gstStateCode, setGstStateCode] = useState(
    data.profile.taxInfo?.gstStateCode ?? "",
  );
  const [gstRegStatus, setGstRegStatus] = useState<GstRegStatus>(
    data.profile.taxInfo?.gstRegStatus ?? "UNREGISTERED",
  );
  const [pan, setPan] = useState("");
  const [taxSaving, setTaxSaving] = useState(false);

  const [msmeStatus, setMsmeStatus] = useState<MsmeStatus>(
    data.profile.msmeInfo?.msmeStatus ?? "NONE",
  );
  const [msmeAgreement, setMsmeAgreement] = useState(
    data.profile.msmeInfo?.msmeWrittenAgreementOnFile ?? false,
  );
  const [msmeSaving, setMsmeSaving] = useState(false);

  useEffect(() => {
    setGstin(data.profile.taxInfo?.gstin ?? "");
    setGstStateCode(data.profile.taxInfo?.gstStateCode ?? "");
    setGstRegStatus(data.profile.taxInfo?.gstRegStatus ?? "UNREGISTERED");
    setMsmeStatus(data.profile.msmeInfo?.msmeStatus ?? "NONE");
    setMsmeAgreement(
      data.profile.msmeInfo?.msmeWrittenAgreementOnFile ?? false,
    );
  }, [data]);

  const msmeDirty =
    msmeStatus !== (data.profile.msmeInfo?.msmeStatus ?? "NONE") ||
    msmeAgreement !==
      (data.profile.msmeInfo?.msmeWrittenAgreementOnFile ?? false);

  const trimmedGstin = gstin.trim().toUpperCase();
  const gstinValid = trimmedGstin.length === 0 || trimmedGstin.length === 15;
  const trimmedStateCode = gstStateCode.trim();
  const stateCodeValid =
    trimmedStateCode.length === 0 || /^\d{2}$/.test(trimmedStateCode);
  const trimmedPan = pan.trim().toUpperCase();
  const panValid =
    trimmedPan.length === 0 || /^[A-Z]{5}\d{4}[A-Z]$/.test(trimmedPan);

  const saveTaxInfo = async () => {
    if (!gstinValid) return;
    if (!stateCodeValid) {
      onError("GST state code must be exactly 2 digits (e.g. 29).");
      return;
    }
    if (!panValid) {
      onError("PAN must be 10 characters (e.g. AAAAA0000A).");
      return;
    }
    onError(null);
    setTaxSaving(true);
    try {
      await patchSettings(orgId, {
        expectedVersion: data.profile.version,
        gstin: trimmedGstin.length === 15 ? trimmedGstin : null,
        gstStateCode: trimmedStateCode.length === 2 ? trimmedStateCode : null,
        gstRegStatus,
        ...(trimmedPan.length === 10 ? { pan: trimmedPan } : {}),
      });
      setPan("");
      await queryClient.invalidateQueries({
        queryKey: ["org-settings", orgId],
      });
      await queryClient.invalidateQueries({
        queryKey: orgDetailsQueryKey(orgId),
      });
      onSuccess();
    } catch (err) {
      if (isVersionConflict(err)) {
        onVersionConflict();
      } else {
        onError(
          err instanceof Error ? err.message : "Failed to save tax details",
        );
      }
    } finally {
      setTaxSaving(false);
    }
  };

  const saveMsme = async () => {
    onError(null);
    setMsmeSaving(true);
    try {
      await patchSettings(orgId, {
        expectedVersion: data.profile.version,
        msmeStatus,
        msmeWrittenAgreementOnFile: msmeAgreement,
      });
      await queryClient.invalidateQueries({
        queryKey: ["org-settings", orgId],
      });
    } catch (err) {
      if (isVersionConflict(err)) {
        onVersionConflict();
      } else {
        onError(
          err instanceof Error
            ? err.message
            : "Failed to save MSME declaration",
        );
      }
    } finally {
      setMsmeSaving(false);
    }
  };

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileText className="w-4 h-4" /> Tax &amp; compliance
        </CardTitle>
        <CardDescription>
          India GST and PAN identity used on invoices, TDS filings, and
          3-way-match reconciliation. Only owners can edit these.
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

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="tax-pan">PAN</Label>
            <Input
              id="tax-pan"
              value={pan}
              onChange={(e) =>
                setPan(e.target.value.toUpperCase().slice(0, 10))
              }
              placeholder={
                data.profile.taxInfo?.panLast4
                  ? `••••••${data.profile.taxInfo.panLast4}`
                  : "AAAAA0000A"
              }
              maxLength={10}
            />
            {data.profile.taxInfo?.panLast4 ? (
              <p className="text-xs text-zinc-500">
                PAN on file ending in {data.profile.taxInfo.panLast4}. Enter a
                new 10-character PAN to replace it, or leave blank to keep the
                existing PAN.
              </p>
            ) : (
              <p className="text-xs text-zinc-500">
                10-character Permanent Account Number (encrypted at rest).
              </p>
            )}
            {!panValid && (
              <p className="text-xs text-red-600">
                PAN must follow format AAAAA0000A.
              </p>
            )}
          </div>
          <div className="space-y-2">
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
        </div>

        <div className="space-y-2 pt-2 border-t">
          <Label htmlFor="msme-status">MSME / Udyam classification</Label>
          <Select
            value={msmeStatus}
            onValueChange={(v) => setMsmeStatus(v as MsmeStatus)}
          >
            <SelectTrigger id="msme-status" className="md:w-1/2">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="NONE">
                Not an MSME / prefer not to say
              </SelectItem>
              <SelectItem value="MICRO">Micro (Udyam registered)</SelectItem>
              <SelectItem value="SMALL">Small (Udyam registered)</SelectItem>
              <SelectItem value="MEDIUM">Medium</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-zinc-500">
            Micro &amp; Small suppliers must be paid within 15 days (45 with a
            signed agreement) under the MSMED Act; declaring accurately lets us
            schedule your payouts to that clock.
          </p>
          {msmeStatus !== "NONE" && (
            <div className="flex items-center gap-2 pt-1">
              <Checkbox
                id="msme-agreement"
                checked={msmeAgreement}
                onCheckedChange={(v) => setMsmeAgreement(v === true)}
              />
              <Label htmlFor="msme-agreement" className="font-normal">
                A written agreement covering payment terms is on file
              </Label>
            </div>
          )}
          {msmeDirty && (
            <Button
              size="sm"
              onClick={() => void saveMsme()}
              disabled={msmeSaving}
            >
              {msmeSaving ? "Saving…" : "Save MSME declaration"}
            </Button>
          )}
        </div>
      </CardContent>
      <CardFooter>
        <Button
          onClick={() => void saveTaxInfo()}
          disabled={taxSaving || !gstinValid || !panValid}
        >
          {taxSaving ? "Saving…" : "Save tax details"}
        </Button>
      </CardFooter>
    </Card>
  );
}

function RecordingRetentionCard({
  orgId,
  data,
  onVersionConflict,
  onError,
  onSuccess,
}: Readonly<{
  orgId: string;
  data: SettingsResponse;
  onVersionConflict: () => void;
  onError: (msg: string | null) => void;
  onSuccess: () => void;
}>) {
  const queryClient = useQueryClient();
  const stored = data.profile.streamRecordingRetentionDays;
  const [days, setDays] = useState(stored === null ? "" : String(stored));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDays(stored === null ? "" : String(stored));
  }, [stored]);

  const trimmed = days.trim();
  const parsed = trimmed === "" ? null : Number(trimmed);
  const valid =
    parsed === null ||
    (Number.isInteger(parsed) && parsed >= 7 && parsed <= 3650);

  const save = async () => {
    if (!valid) {
      onError(
        "Enter a whole number of days between 7 and 3650, or leave it empty.",
      );
      return;
    }
    onError(null);
    setSaving(true);
    try {
      await patchSettings(orgId, {
        expectedVersion: data.profile.version,
        streamRecordingRetentionDays: parsed,
      });
      await queryClient.invalidateQueries({
        queryKey: ["org-settings", orgId],
      });
      onSuccess();
    } catch (err) {
      if (isVersionConflict(err)) {
        onVersionConflict();
      } else {
        onError(
          err instanceof Error
            ? err.message
            : "Failed to save recording retention",
        );
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Video className="w-4 h-4" /> Session recordings
        </CardTitle>
        <CardDescription>
          Sold or published replays are never deleted automatically.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <Label htmlFor="recording-retention-days">
          Delete org session recordings after N days (leave empty to follow the
          platform schedule)
        </Label>
        <Input
          id="recording-retention-days"
          type="number"
          inputMode="numeric"
          min={7}
          max={3650}
          step={1}
          value={days}
          onChange={(e) => setDays(e.target.value)}
          placeholder="Platform schedule"
          className="max-w-[12rem]"
        />
      </CardContent>
      <CardFooter>
        <Button onClick={() => void save()} disabled={saving || !valid}>
          {saving ? "Saving…" : "Save retention"}
        </Button>
      </CardFooter>
    </Card>
  );
}

export function GeneralPanel({ orgId }: { orgId: string }) {
  const { can, isLoading: roleLoading } = useOrgRole(orgId);
  const canManage = can("settings.manage");
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["org-settings", orgId],
    queryFn: () => fetchSettings(orgId),
    enabled: canManage,
  });

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [industry, setIndustry] = useState("");
  const [website, setWebsite] = useState("");
  const [isPublic, setIsPublic] = useState(false);
  const [resubmitting, setResubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [pendingDisable, setPendingDisable] = useState<
    null | "canSponsor" | "canHost"
  >(null);
  const [conflictOpen, setConflictOpen] = useState(false);

  useEffect(() => {
    if (!data) return;
    setName(data.organization?.name ?? "");
    setSlug(data.organization?.slug ?? "");
    setDescription(data.profile.description ?? "");
    setIndustry(data.profile.industry ?? "");
    setWebsite(data.profile.website ?? "");
    setIsPublic(data.profile.isPublic ?? false);
  }, [data]);

  const mutation = useMutation({
    mutationFn: (overrides?: PatchPayload) =>
      patchSettings(orgId, {
        name: name.trim(),
        description: description.trim() || null,
        industry: industry.trim() || null,
        website: website.trim() || null,
        ...(data && { expectedVersion: data.profile.version }),
        ...(can("settings.ownerFields") && {
          slug: slug.trim() || undefined,
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
    onError: (err: Error) => {
      if (isVersionConflict(err)) {
        setConflictOpen(true);
        setSuccess(false);
        return;
      }
      setError(err.message);
      setSuccess(false);
    },
  });

  const handleCapabilityToggle = (
    field: "canSponsor" | "canHost",
    nextValue: boolean,
  ) => {
    if (!data) return;
    const current =
      field === "canSponsor" ? data.profile.canSponsor : data.profile.canHost;
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

  if (roleLoading) {
    return (
      <div className="space-y-6">
        <p className="text-sm text-zinc-500">Loading…</p>
      </div>
    );
  }

  if (!canManage) {
    return (
      <div className="space-y-6">
        <PanelHeader description="Organization membership and access" />
        <DangerZoneCard
          orgId={orgId}
          orgName="this organization"
          orgSlug=""
          orgStatus="ACTIVE"
          canDeleteOrg={false}
        />
      </div>
    );
  }

  if (isLoading || !data) {
    return (
      <div className="space-y-6">
        <p className="text-sm text-zinc-500">Loading…</p>
      </div>
    );
  }

  const capabilityKind = deriveCapabilityKind(
    data.profile.canSponsor,
    data.profile.canHost,
  );
  const fundingSource = data.profile.billingAccount?.fundingSource;

  const rejectedPending =
    data.profile.status === ("PENDING_VERIFICATION" as OrgStatus) &&
    !!data.profile.verificationRejectedAt;

  const resubmitVerification = async () => {
    setResubmitting(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/organizations/${orgId}/verification/resubmit`,
        {
          method: "POST",
        },
      );
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error((b as { error?: string }).error ?? "Resubmit failed");
      }
      await queryClient.invalidateQueries({
        queryKey: ["org-settings", orgId],
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Resubmit failed");
    } finally {
      setResubmitting(false);
    }
  };

  return (
    <>
      {rejectedPending && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-4 space-y-2">
          <p className="text-sm font-semibold text-amber-900">
            Verification was declined
          </p>
          {data.profile.verificationReason && (
            <p className="text-sm text-amber-800">
              Reason: {data.profile.verificationReason}
            </p>
          )}
          <p className="text-xs text-amber-800">
            Fix the issue and resubmit — a platform admin will re-review.
          </p>
          <Button
            size="sm"
            onClick={resubmitVerification}
            disabled={resubmitting}
          >
            {resubmitting ? "Resubmitting…" : "Resubmit for verification"}
          </Button>
        </div>
      )}
      <PanelHeader description="Organization profile, shape and tax details" />
      <div className="space-y-6">
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
              <Badge variant="outline">
                Status: {humanizeEnum(data.profile.status)}
              </Badge>
            </div>

            {can("settings.ownerFields") && (
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
                    <p className="text-sm font-medium">Host experts</p>
                    <p className="text-xs text-zinc-500">
                      The organization hosts experts who deliver sessions.
                      Enables the payout account, rate cards, and the Catalog
                      and Payouts sidebar entries.
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
                    disabled={!can("settings.manage")}
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
                    disabled={!can("settings.ownerFields")}
                    className="border-0 bg-transparent px-1 py-0 h-auto shadow-none focus-visible:ring-0"
                    placeholder="acme-school"
                  />
                </div>
                <p className="text-xs text-zinc-500">
                  Public discovery URL for the org. Changing the slug breaks any
                  inbound links pointing to the old URL — only owners can edit.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="description">Description</Label>
                <Input
                  id="description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Short description of the organization"
                  disabled={!can("settings.manage")}
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
                    disabled={!can("settings.manage")}
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
                    disabled={!can("settings.manage")}
                  />
                </div>
              </div>

              {error && <p className="text-sm text-red-600">{error}</p>}
              {success && (
                <p className="text-sm text-emerald-600">Settings saved.</p>
              )}

              {can("settings.manage") && (
                <div>
                  <Button type="submit" disabled={mutation.isPending}>
                    {mutation.isPending ? "Saving…" : "Save changes"}
                  </Button>
                </div>
              )}
            </form>
          </CardContent>
        </Card>

        {can("settings.ownerFields") && (
          <TaxComplianceCard
            orgId={orgId}
            data={data}
            onVersionConflict={() => setConflictOpen(true)}
            onError={setError}
            onSuccess={() => {
              setSuccess(true);
              setTimeout(() => setSuccess(false), 2500);
            }}
          />
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
                    {resolveMarketplaceVisibilityCopy(
                      data.profile.status,
                      isPublic,
                    )}
                  </p>
                </div>
                <Switch
                  checked={isPublic}
                  onCheckedChange={setIsPublic}
                  disabled={
                    data.profile.status !== "ACTIVE" ||
                    !can("settings.ownerFields") ||
                    mutation.isPending
                  }
                />
              </div>
            </CardContent>
            {can("settings.ownerFields") && (
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

        {can("settings.ownerFields") && (
          <RecordingRetentionCard
            orgId={orgId}
            data={data}
            onVersionConflict={() => setConflictOpen(true)}
            onError={setError}
            onSuccess={() => {
              setSuccess(true);
              setTimeout(() => setSuccess(false), 2500);
            }}
          />
        )}

        {can("settings.cancellationPolicy.publish") && (
          <CancellationPolicyCard orgId={orgId} />
        )}

        <DangerZoneCard
          orgId={orgId}
          orgName={data.organization?.name ?? "this organization"}
          orgSlug={data.organization?.slug ?? ""}
          orgStatus={data.profile.status}
          canDeleteOrg={can("org.delete")}
        />

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
                  : "External experts will stop earning through this organization. The Experts and Payouts surfaces will be hidden. Existing earnings remain payable."}
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
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// #1844 — Danger Zone (OWNER-only):
//   1. Transfer Ownership (promote an active MAINTAINER / staff member to OWNER)
//   2. Deactivate / Close Organization (DELETE /api/organizations/[orgId] after
//      typed confirmation of the organization slug)
// ---------------------------------------------------------------------------

interface ActiveMemberCandidate {
  id: string;
  role: string;
  status: string;
  user: {
    id: string;
    name: string | null;
    email: string | null;
  };
}

async function fetchActiveMembers(
  orgId: string,
): Promise<{ data: ActiveMemberCandidate[] }> {
  const perPage = 100;
  const maxPages = 1000;
  const allMembers: ActiveMemberCandidate[] = [];

  for (let page = 1; page <= maxPages; page += 1) {
    const res = await fetch(
      `/api/organizations/${orgId}/members?status=ACTIVE&page=${page}&perPage=${perPage}`,
    );
    if (!res.ok) throw new Error("Failed to load active members");
    const json = (await res.json()) as {
      data?: ActiveMemberCandidate[];
      meta?: { total?: number; page?: number; perPage?: number };
    };
    const batch = json.data ?? [];
    allMembers.push(...batch);
    const total = json.meta?.total ?? allMembers.length;
    if (batch.length < perPage || allMembers.length >= total) {
      break;
    }
  }

  return { data: allMembers };
}

function DangerZoneCard({
  orgId,
  orgName,
  orgSlug,
  orgStatus,
  canDeleteOrg,
}: Readonly<{
  orgId: string;
  orgName: string;
  orgSlug: string;
  orgStatus: OrgStatus;
  canDeleteOrg: boolean;
}>) {
  const router = useRouter();
  const queryClient = useQueryClient();

  const membersQuery = useQuery({
    queryKey: ["org-danger-zone-members", orgId],
    queryFn: () => fetchActiveMembers(orgId),
    enabled: canDeleteOrg,
  });

  // Eligible candidates: active MAINTAINERs first, followed by other non-OWNER
  // administrative roles (BILLING_ADMIN, MANAGER, SUPPORT).
  const eligibleMembers = (membersQuery.data?.data ?? []).filter(
    (m) =>
      m.status === "ACTIVE" &&
      ["MAINTAINER", "BILLING_ADMIN", "MANAGER", "SUPPORT"].includes(m.role),
  );

  const [selectedMemberId, setSelectedMemberId] = useState("");
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferConfirmText, setTransferConfirmText] = useState("");
  const [transferError, setTransferError] = useState<string | null>(null);
  const [transferSuccess, setTransferSuccess] = useState<string | null>(null);

  const [deactivateOpen, setDeactivateOpen] = useState(false);
  const [deactivateConfirmSlug, setDeactivateConfirmSlug] = useState("");
  const [deactivateError, setDeactivateError] = useState<string | null>(null);

  const transferMutation = useMutation({
    mutationFn: async (memberId: string) => {
      const res = await fetch(
        `/api/organizations/${orgId}/members/${memberId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ role: "OWNER" }),
        },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          (json as { error?: string }).error ??
            "Failed to transfer ownership to member",
        );
      }
      return json;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["org-danger-zone-members", orgId],
      });
      queryClient.invalidateQueries({ queryKey: ["org-members", orgId] });
      setTransferOpen(false);
      setTransferConfirmText("");
      setSelectedMemberId("");
      setTransferError(null);
      setTransferSuccess(
        "Selected member has been promoted to OWNER. You may now step down from the People tab if desired.",
      );
    },
    onError: (err: Error) => {
      setTransferError(err.message);
    },
  });

  const deactivateMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/organizations/${orgId}`, {
        method: "DELETE",
      });
      if (res.status === 204) {
        return { hardDeleted: true };
      }
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          (json as { error?: string }).error ??
            "Failed to deactivate organization",
        );
      }
      return json as { softDeleted?: boolean };
    },
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: ["org-settings", orgId] });
      queryClient.removeQueries({ queryKey: orgDetailsQueryKey(orgId) });
      setDeactivateOpen(false);
      setDeactivateConfirmSlug("");
      setDeactivateError(null);
      router.push("/dashboard");
    },
    onError: (err: Error) => {
      setDeactivateError(err.message);
    },
  });

  const handleLeaveOrganization = async () => {
    const res = await fetch(`/api/organizations/${orgId}/members/leave`, {
      method: "POST",
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      throw new Error(json.error ?? "Failed to leave organization");
    }
    queryClient.removeQueries({ queryKey: ["org-settings", orgId] });
    queryClient.removeQueries({ queryKey: orgDetailsQueryKey(orgId) });
    router.push("/dashboard");
  };

  const selectedCandidate = eligibleMembers.find(
    (m) => m.id === selectedMemberId,
  );
  const expectedTransferToken = orgSlug || "TRANSFER";

  return (
    <Card className="mt-6 border-red-200 dark:border-red-900/60">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-red-700 dark:text-red-400">
          <AlertTriangle className="h-4 w-4" /> Danger Zone
        </CardTitle>
        <CardDescription>
          {canDeleteOrg
            ? "High-impact ownership, membership, and organization lifecycle actions."
            : "Leave this organization if you no longer need operator or member access."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Leave Organization */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 rounded-md border border-red-100 bg-red-50/40 p-4 dark:border-red-950 dark:bg-red-950/20">
          <div className="space-y-1">
            <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              Leave organization
            </p>
            <p className="text-xs text-zinc-600 dark:text-zinc-400">
              Relinquish your membership in <strong>{orgName}</strong>. Active
              sponsored program entitlements will be released immediately.
              {canDeleteOrg
                ? " As an owner, another active owner must exist before you can leave."
                : ""}
            </p>
          </div>
          <ConfirmDialog
            trigger={
              <Button
                type="button"
                variant="outline"
                className="border-red-300 text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-400"
              >
                Leave organization
              </Button>
            }
            title={`Leave ${orgName}?`}
            description="You will lose access to this organization's dashboard and any active sponsored program benefits."
            confirmLabel="Leave organization"
            tone="destructive"
            requireTyped={orgSlug || orgName}
            onConfirm={handleLeaveOrganization}
          />
        </div>

        {canDeleteOrg && (
          <>
            {/* 1. Transfer Ownership */}
            <div className="flex flex-col gap-3 rounded-md border border-red-100 bg-red-50/40 p-4 dark:border-red-950 dark:bg-red-950/20">
              <div>
                <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                  Transfer ownership / add co-owner
                </p>
                <p className="text-xs text-zinc-600 dark:text-zinc-400 mt-0.5">
                  Promote an active maintainer or operator to{" "}
                  <strong>OWNER</strong>. Promoting a successor owner is
                  required before the last owner can leave or be demoted.
                </p>
              </div>

              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                <select
                  aria-label="Select member to promote to owner"
                  className="flex h-9 flex-1 rounded-md border border-zinc-300 bg-white px-3 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                  value={selectedMemberId}
                  onChange={(e) => {
                    setSelectedMemberId(e.target.value);
                    setTransferError(null);
                    setTransferSuccess(null);
                  }}
                >
                  <option value="">Select an active member…</option>
                  {eligibleMembers.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.user.name ?? m.user.email ?? m.id} ({m.role})
                    </option>
                  ))}
                </select>
                <Button
                  type="button"
                  variant="outline"
                  className="border-red-300 text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-400"
                  disabled={!selectedMemberId}
                  onClick={() => {
                    setTransferConfirmText("");
                    setTransferError(null);
                    setTransferOpen(true);
                  }}
                >
                  Transfer ownership
                </Button>
              </div>
              {eligibleMembers.length === 0 && !membersQuery.isLoading && (
                <p className="text-xs text-zinc-500">
                  No eligible active maintainers or staff members found. Invite
                  a maintainer from the People page first.
                </p>
              )}
              {transferSuccess && (
                <p className="text-xs text-emerald-600">{transferSuccess}</p>
              )}
            </div>

            {/* 2. Deactivate / Close Organization */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 rounded-md border border-red-200 bg-red-50/60 p-4 dark:border-red-900 dark:bg-red-950/30">
              <div className="space-y-1">
                <p className="text-sm font-semibold text-red-900 dark:text-red-300">
                  Deactivate / close organization
                </p>
                <p className="text-xs text-red-800/90 dark:text-red-300/80">
                  Permanently closes this organization. Active or draft
                  contracts, unpaid invoices, open purchase orders, unsettled
                  earnings, in-flight payouts, and non-zero wallet balances must
                  be wound down first. If financial history exists, statutory
                  invoice records are retained while contact PII is scrubbed.
                </p>
              </div>
              <Button
                type="button"
                variant="destructive"
                disabled={orgStatus === "DEACTIVATED"}
                onClick={() => {
                  setDeactivateConfirmSlug("");
                  setDeactivateError(null);
                  setDeactivateOpen(true);
                }}
              >
                {orgStatus === "DEACTIVATED"
                  ? "Already deactivated"
                  : "Deactivate organization"}
              </Button>
            </div>
          </>
        )}
      </CardContent>

      {/* Transfer ownership confirmation dialog */}
      <AlertDialog open={transferOpen} onOpenChange={setTransferOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Promote member to Owner?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-sm text-zinc-600 dark:text-zinc-400">
                <p>
                  You are granting full <strong>OWNER</strong> privileges
                  (including billing, tax identity, contract termination, and
                  organization closure) to{" "}
                  <strong>
                    {selectedCandidate?.user.name ??
                      selectedCandidate?.user.email ??
                      "this member"}
                  </strong>
                  {"."}
                </p>
                <div className="space-y-1.5">
                  <Label htmlFor="confirm-transfer-slug">
                    Type <code>{expectedTransferToken}</code> to confirm
                  </Label>
                  <Input
                    id="confirm-transfer-slug"
                    value={transferConfirmText}
                    onChange={(e) => setTransferConfirmText(e.target.value)}
                    placeholder={expectedTransferToken}
                  />
                </div>
                {transferError && (
                  <p className="text-xs text-red-600">{transferError}</p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={
                transferConfirmText.trim() !== expectedTransferToken ||
                transferMutation.isPending ||
                !selectedMemberId
              }
              onClick={() => transferMutation.mutate(selectedMemberId)}
            >
              {transferMutation.isPending ? (
                <>
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" /> Promoting…
                </>
              ) : (
                "Confirm ownership grant"
              )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Deactivate organization confirmation dialog */}
      <AlertDialog open={deactivateOpen} onOpenChange={setDeactivateOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Deactivate / close organization?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-sm text-zinc-600 dark:text-zinc-400">
                <p>Closing this organization has the following impact:</p>
                <ul className="list-disc pl-5 space-y-1 text-xs">
                  <li>
                    <strong>Members &amp; bookings:</strong> Members lose
                    sponsored booking access; any active programs or live
                    contracts must be terminated first.
                  </li>
                  <li>
                    <strong>Wallet balance &amp; invoices:</strong> Wallet
                    balance must be ₹0 and all open invoices, purchase orders,
                    and overage accruals must be settled before closure.
                  </li>
                  <li>
                    <strong>Statutory retention:</strong> Organizations with
                    prior financial history are soft-deleted (`DEACTIVATED`) to
                    preserve tax invoices while scrubbing contact details.
                  </li>
                </ul>
                <div className="space-y-1.5 pt-1">
                  <Label htmlFor="confirm-deactivate-slug">
                    Type the organization slug <code>{orgSlug}</code> to confirm
                  </Label>
                  <Input
                    id="confirm-deactivate-slug"
                    value={deactivateConfirmSlug}
                    onChange={(e) => setDeactivateConfirmSlug(e.target.value)}
                    placeholder={orgSlug}
                  />
                </div>
                {deactivateError && (
                  <p className="text-xs text-red-600">{deactivateError}</p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={
                !orgSlug ||
                deactivateConfirmSlug.trim() !== orgSlug ||
                deactivateMutation.isPending
              }
              onClick={() => deactivateMutation.mutate()}
            >
              {deactivateMutation.isPending ? (
                <>
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" /> Closing…
                </>
              ) : (
                "Deactivate organization"
              )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
