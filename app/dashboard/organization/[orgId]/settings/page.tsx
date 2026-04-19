"use client";

import { use, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import Image from "next/image";
import { Shield, Upload, X } from "lucide-react";

import { useOrgRole, useRequireOrgRole } from "../useOrgRole";
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
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

interface OrgSettings {
  organization: {
    id: string;
    name: string;
    slug: string;
    logo: string | null;
  } | null;
  profile: {
    id: string;
    kind: string;
    status: string;
    billingMode: string | null;
    billingEmail: string;
    description: string | null;
    industry: string | null;
    website: string | null;
    paymentTermsDays: number;
    seatsTotal: number | null;
  };
}

async function fetchSettings(orgId: string): Promise<OrgSettings> {
  const res = await fetch(`/api/organizations/${orgId}/settings`);
  if (!res.ok) throw new Error("Failed to load settings");
  return res.json();
}

interface PatchPayload {
  name?: string;
  billingEmail?: string;
  description?: string | null;
  industry?: string | null;
  website?: string | null;
  paymentTermsDays?: number;
  seatsTotal?: number | null;
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
  });

  const [name, setName] = useState("");
  const [billingEmail, setBillingEmail] = useState("");
  const [description, setDescription] = useState("");
  const [industry, setIndustry] = useState("");
  const [website, setWebsite] = useState("");
  const [paymentTermsDays, setPaymentTermsDays] = useState("60");
  const [seatsTotal, setSeatsTotal] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Logo upload state
  const logoInputRef = useRef<HTMLInputElement>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);

  useEffect(() => {
    if (!data) return;
    setName(data.organization?.name ?? "");
    setBillingEmail(data.profile.billingEmail);
    setDescription(data.profile.description ?? "");
    setIndustry(data.profile.industry ?? "");
    setWebsite(data.profile.website ?? "");
    setPaymentTermsDays(String(data.profile.paymentTermsDays));
    setSeatsTotal(
      data.profile.seatsTotal !== null && data.profile.seatsTotal !== undefined
        ? String(data.profile.seatsTotal)
        : "",
    );
    // Seed logo preview from existing org logo
    if (data.organization?.logo) setLogoPreview(data.organization.logo);
  }, [data]);

  const handleLogoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setLogoError(null);
    const objectUrl = URL.createObjectURL(file);
    setLogoPreview(objectUrl);
    uploadLogo(file);
  };

  const uploadLogo = async (file: File) => {
    setUploadingLogo(true);
    setLogoError(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("type", "logo");
      const res = await fetch(`/api/organizations/${orgId}/images`, {
        method: "POST",
        body: formData,
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Upload failed");
      queryClient.invalidateQueries({ queryKey: ["org-settings", orgId] });
      queryClient.invalidateQueries({ queryKey: ["organization", orgId] });
    } catch (err) {
      setLogoError((err as Error).message);
    } finally {
      setUploadingLogo(false);
    }
  };

  const mutation = useMutation({
    mutationFn: () =>
      patchSettings(orgId, {
        name: name.trim(),
        billingEmail: billingEmail.trim(),
        description: description.trim() || null,
        industry: industry.trim() || null,
        website: website.trim() || null,
        paymentTermsDays: parseInt(paymentTermsDays, 10),
        seatsTotal: seatsTotal ? parseInt(seatsTotal, 10) : null,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["org-settings", orgId] });
      queryClient.invalidateQueries({ queryKey: ["organization", orgId] });
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

  if (isLoading) {
    return (
      <>
        <DashboardHeader title="Settings" />
        <DashboardContent>
          <p className="text-sm text-zinc-500">Loading…</p>
        </DashboardContent>
      </>
    );
  }

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
        {/* Logo upload */}
        {isAtLeast("MAINTAINER") && (
          <Card className="mb-6">
            <CardHeader>
              <CardTitle>Organization logo</CardTitle>
              <CardDescription>
                Shown in the sidebar and on invoices. JPG, PNG, or WebP — max 4 MB.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-5">
                {/* Preview */}
                <div className="w-20 h-20 rounded-xl bg-zinc-100 border border-zinc-200 flex items-center justify-center overflow-hidden shrink-0">
                  {logoPreview ? (
                    <Image
                      src={logoPreview}
                      alt="Org logo"
                      width={80}
                      height={80}
                      className="object-cover w-full h-full"
                    />
                  ) : (
                    <Upload className="w-6 h-6 text-zinc-400" />
                  )}
                </div>

                <div className="space-y-2">
                  <input
                    ref={logoInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    className="hidden"
                    onChange={handleLogoChange}
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => logoInputRef.current?.click()}
                    disabled={uploadingLogo}
                  >
                    {uploadingLogo ? "Uploading…" : "Upload logo"}
                  </Button>
                  {logoPreview && !uploadingLogo && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="text-zinc-500 ml-2"
                      onClick={() => {
                        setLogoPreview(null);
                        if (logoInputRef.current) logoInputRef.current.value = "";
                      }}
                    >
                      <X className="w-3.5 h-3.5 mr-1" />
                      Clear
                    </Button>
                  )}
                  {logoError && (
                    <p className="text-xs text-red-600">{logoError}</p>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        )}

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
                </div>
                <div className="space-y-2">
                  <Label htmlFor="seats">Seat budget (optional)</Label>
                  <Input
                    id="seats"
                    type="number"
                    min="0"
                    value={seatsTotal}
                    onChange={(e) => setSeatsTotal(e.target.value)}
                    placeholder="Leave blank for unlimited"
                    disabled={!isAtLeast("MAINTAINER")}
                  />
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

        {data?.profile.kind !== "PROVIDER" && (
          <Card className="mt-6">
            <CardHeader>
              <CardTitle className="text-base">Billing mode</CardTitle>
              <CardDescription>
                Currently <strong>{data?.profile.billingMode ?? "—"}</strong>.
                Billing mode is locked after the first payment to prevent
                ambiguity in the ledger.
              </CardDescription>
            </CardHeader>
          </Card>
        )}
      </DashboardContent>
    </>
  );
}
