"use client";

import { use, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { Shield } from "lucide-react";

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
    billingMode: string;
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
  const { allowed } = useRequireOrgRole(orgId, "ORG_ADMIN");
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
  const [paymentTermsDays, setPaymentTermsDays] = useState("30");
  const [seatsTotal, setSeatsTotal] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (!data) return;
    setName(data.organization?.name ?? "");
    setBillingEmail(data.profile.billingEmail);
    setDescription(data.profile.description ?? "");
    setIndustry(data.profile.industry ?? "");
    setWebsite(data.profile.website ?? "");
    setPaymentTermsDays(String(data.profile.paymentTermsDays));
    setSeatsTotal(
      data.profile.seatsTotal != null ? String(data.profile.seatsTotal) : "",
    );
  }, [data]);

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
          isAtLeast("ORG_OWNER") && (
            <Link href={`/dashboard/organization/${orgId}/settings/sso`}>
              <Button size="sm" variant="outline">
                <Shield className="h-4 w-4 mr-1" /> SSO settings
              </Button>
            </Link>
          )
        }
      />
      <DashboardContent>
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
                    disabled={!isAtLeast("ORG_ADMIN")}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="billing-email">Billing email</Label>
                  <Input
                    id="billing-email"
                    type="email"
                    value={billingEmail}
                    onChange={(e) => setBillingEmail(e.target.value)}
                    disabled={!isAtLeast("ORG_ADMIN")}
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
                  disabled={!isAtLeast("ORG_ADMIN")}
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
                    disabled={!isAtLeast("ORG_ADMIN")}
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
                    disabled={!isAtLeast("ORG_ADMIN")}
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
                    disabled={!isAtLeast("ORG_ADMIN")}
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
                    disabled={!isAtLeast("ORG_ADMIN")}
                  />
                </div>
              </div>

              {error && <p className="text-sm text-red-600">{error}</p>}
              {success && (
                <p className="text-sm text-emerald-600">Settings saved.</p>
              )}

              {isAtLeast("ORG_ADMIN") && (
                <div>
                  <Button type="submit" disabled={mutation.isPending}>
                    {mutation.isPending ? "Saving…" : "Save changes"}
                  </Button>
                </div>
              )}
            </form>
          </CardContent>
        </Card>

        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="text-base">Billing mode</CardTitle>
            <CardDescription>
              Currently <strong>{data?.profile.billingMode}</strong>. Billing
              mode is locked after the first payment to prevent ambiguity in
              the ledger.
            </CardDescription>
          </CardHeader>
        </Card>
      </DashboardContent>
    </>
  );
}
