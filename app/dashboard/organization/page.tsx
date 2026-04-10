"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, Plus } from "lucide-react";

import {
  DashboardHeader,
  DashboardContent,
} from "@/components/dashboard/DashboardShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

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

interface CreateOrgPayload {
  name: string;
  billingEmail: string;
  kind: "BUYER";
  billingMode: "TAG_ONLY" | "SEAT_PACK" | "INVOICED_MONTHLY";
}

async function createOrg(payload: CreateOrgPayload) {
  const res = await fetch("/api/organizations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || "Failed to create organization");
  return body as {
    organization: { id: string; name: string };
    profile: { id: string };
  };
}

export default function OrganizationLandingPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["organizations"],
    queryFn: fetchOrgs,
  });

  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [billingEmail, setBillingEmail] = useState("");
  const [billingMode, setBillingMode] =
    useState<CreateOrgPayload["billingMode"]>("TAG_ONLY");
  const [formError, setFormError] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: createOrg,
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["organizations"] });
      router.push(`/dashboard/organization/${result.organization.id}/home`);
    },
    onError: (err: Error) => setFormError(err.message),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    createMutation.mutate({
      name: name.trim(),
      billingEmail: billingEmail.trim(),
      kind: "BUYER",
      billingMode,
    });
  };

  return (
    <>
      <DashboardHeader
        title="Organizations"
        subtitle="Schools, corporates, and teams you belong to"
        actions={
          !showCreate && (
            <Button onClick={() => setShowCreate(true)} size="sm">
              <Plus className="h-4 w-4 mr-1" /> New organization
            </Button>
          )
        }
      />
      <DashboardContent>
        {showCreate && (
          <Card className="mb-6">
            <CardHeader>
              <CardTitle>Create a new organization</CardTitle>
              <CardDescription>
                You will be its first owner. Settings can be changed later.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="org-name">Name</Label>
                  <Input
                    id="org-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Acme School"
                    required
                    minLength={2}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="org-email">Billing email</Label>
                  <Input
                    id="org-email"
                    type="email"
                    value={billingEmail}
                    onChange={(e) => setBillingEmail(e.target.value)}
                    placeholder="billing@acme.edu"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="org-billing">Billing mode</Label>
                  <Select
                    value={billingMode}
                    onValueChange={(v) =>
                      setBillingMode(v as CreateOrgPayload["billingMode"])
                    }
                  >
                    <SelectTrigger id="org-billing">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="TAG_ONLY">
                        Tag-only — learners pay individually
                      </SelectItem>
                      <SelectItem value="SEAT_PACK">
                        Seat pack — pre-buy credits, learners draw down
                      </SelectItem>
                      <SelectItem value="INVOICED_MONTHLY">
                        Invoiced monthly — pay once a month
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {formError && (
                  <p className="text-sm text-red-600">{formError}</p>
                )}

                <div className="flex items-center gap-2">
                  <Button type="submit" disabled={createMutation.isPending}>
                    {createMutation.isPending ? "Creating…" : "Create"}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setShowCreate(false);
                      setFormError(null);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        )}

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
              <Button
                size="sm"
                className="mt-4"
                onClick={() => setShowCreate(true)}
              >
                Create your first organization
              </Button>
            </CardContent>
          </Card>
        )}
      </DashboardContent>
    </>
  );
}
