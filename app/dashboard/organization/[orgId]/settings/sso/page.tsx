"use client";

import { use, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, ArrowLeft } from "lucide-react";
import Link from "next/link";

import {
  DashboardHeader,
  DashboardContent,
} from "@/components/dashboard/DashboardShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface Provider {
  id: string;
  providerId: string;
  issuer: string;
  domain: string;
}

interface SsoResponse {
  settings: {
    allowedEmailDomains: string[];
    enforceSSO: boolean;
    defaultRoleForAutoJoin: string;
  };
  providers: Provider[];
}

async function fetchSso(orgId: string): Promise<SsoResponse> {
  const res = await fetch(`/api/organizations/${orgId}/sso`);
  if (!res.ok) throw new Error("Failed to load SSO settings");
  return res.json();
}

interface PatchPayload {
  allowedEmailDomains?: string[];
  enforceSSO?: boolean;
  defaultRoleForAutoJoin?: string;
}

async function patchSso(orgId: string, payload: PatchPayload) {
  const res = await fetch(`/api/organizations/${orgId}/sso`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || "Failed to update SSO settings");
  return body;
}

interface ProviderPayload {
  providerId: string;
  domain: string;
  issuer: string;
  samlConfig?: string;
  oidcConfig?: string;
}

async function createProvider(orgId: string, payload: ProviderPayload) {
  const res = await fetch(`/api/organizations/${orgId}/sso/providers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || "Failed to register provider");
  return body;
}

async function deleteProvider(orgId: string, providerId: string) {
  const res = await fetch(
    `/api/organizations/${orgId}/sso/providers/${providerId}`,
    { method: "DELETE" },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to delete provider");
  }
}

const ROLE_OPTIONS = [
  { value: "ORG_LEARNER", label: "Learner" },
  { value: "ORG_MANAGER", label: "Manager" },
  { value: "ORG_ADMIN", label: "Admin" },
];

export default function OrgSsoPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = use(params);
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["org-sso", orgId],
    queryFn: () => fetchSso(orgId),
  });

  const [domains, setDomains] = useState("");
  const [enforce, setEnforce] = useState(false);
  const [defaultRole, setDefaultRole] = useState("ORG_LEARNER");

  useEffect(() => {
    if (!data) return;
    setDomains(data.settings.allowedEmailDomains.join(", "));
    setEnforce(data.settings.enforceSSO);
    setDefaultRole(data.settings.defaultRoleForAutoJoin);
  }, [data]);

  const settingsMutation = useMutation({
    mutationFn: () =>
      patchSso(orgId, {
        allowedEmailDomains: domains
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        enforceSSO: enforce,
        defaultRoleForAutoJoin: defaultRole,
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["org-sso", orgId] }),
  });

  const [showAdd, setShowAdd] = useState(false);
  const [providerId, setProviderId] = useState("");
  const [domain, setDomain] = useState("");
  const [issuer, setIssuer] = useState("");
  const [samlConfig, setSamlConfig] = useState("");
  const [providerError, setProviderError] = useState<string | null>(null);

  const createProviderMutation = useMutation({
    mutationFn: () =>
      createProvider(orgId, {
        providerId: providerId.trim(),
        domain: domain.trim(),
        issuer: issuer.trim(),
        samlConfig: samlConfig.trim() || undefined,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["org-sso", orgId] });
      setShowAdd(false);
      setProviderId("");
      setDomain("");
      setIssuer("");
      setSamlConfig("");
      setProviderError(null);
    },
    onError: (err: Error) => setProviderError(err.message),
  });

  const deleteProviderMutation = useMutation({
    mutationFn: (id: string) => deleteProvider(orgId, id),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["org-sso", orgId] }),
  });

  if (isLoading) {
    return (
      <>
        <DashboardHeader title="SSO settings" />
        <DashboardContent>
          <p className="text-sm text-zinc-500">Loading…</p>
        </DashboardContent>
      </>
    );
  }

  return (
    <>
      <DashboardHeader
        title="SSO settings"
        subtitle="Configure SAML / OIDC sign-in for this organization"
        actions={
          <Link href={`/dashboard/organization/${orgId}/settings`}>
            <Button size="sm" variant="outline">
              <ArrowLeft className="h-4 w-4 mr-1" /> Back to settings
            </Button>
          </Link>
        }
      />
      <DashboardContent>
        <Card>
          <CardHeader>
            <CardTitle>Domain policy</CardTitle>
            <CardDescription>
              Users signing up with these email domains can be auto-joined to
              this organization.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                settingsMutation.mutate();
              }}
            >
              <div className="space-y-2">
                <Label htmlFor="domains">Allowed email domains</Label>
                <Input
                  id="domains"
                  value={domains}
                  onChange={(e) => setDomains(e.target.value)}
                  placeholder="acme.com, acme.edu"
                />
                <p className="text-xs text-zinc-500">
                  Comma-separated list of domains.
                </p>
              </div>

              <div className="flex items-center justify-between rounded-lg border border-zinc-200 p-3">
                <div>
                  <p className="text-sm font-medium">Enforce SSO</p>
                  <p className="text-xs text-zinc-500">
                    Reject password and personal OAuth sign-ins for these
                    domains.
                  </p>
                </div>
                <Switch checked={enforce} onCheckedChange={setEnforce} />
              </div>

              <div className="space-y-2">
                <Label htmlFor="default-role">
                  Default role for auto-joined users
                </Label>
                <Select value={defaultRole} onValueChange={setDefaultRole}>
                  <SelectTrigger id="default-role">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ROLE_OPTIONS.map((r) => (
                      <SelectItem key={r.value} value={r.value}>
                        {r.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Button type="submit" disabled={settingsMutation.isPending}>
                  {settingsMutation.isPending ? "Saving…" : "Save policy"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        <Card className="mt-6">
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle className="text-base">SSO providers</CardTitle>
              <CardDescription>
                SAML and OIDC providers registered for this organization.
              </CardDescription>
            </div>
            <Button size="sm" onClick={() => setShowAdd(true)}>
              <Plus className="h-4 w-4 mr-1" /> Add provider
            </Button>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Provider ID</TableHead>
                  <TableHead>Domain</TableHead>
                  <TableHead>Issuer</TableHead>
                  <TableHead className="w-12"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.providers.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>
                      <Badge variant="secondary">{p.providerId}</Badge>
                    </TableCell>
                    <TableCell>{p.domain}</TableCell>
                    <TableCell className="text-xs text-zinc-500 max-w-xs truncate">
                      {p.issuer}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Delete provider"
                        onClick={() => deleteProviderMutation.mutate(p.id)}
                      >
                        <Trash2 className="h-4 w-4 text-red-500" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {data?.providers && data.providers.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={4}
                      className="text-center text-sm text-zinc-500 py-6"
                    >
                      No providers configured yet.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </DashboardContent>

      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add SSO provider</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="prov-id">Provider ID</Label>
              <Input
                id="prov-id"
                value={providerId}
                onChange={(e) => setProviderId(e.target.value)}
                placeholder="acme-okta"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="prov-domain">Domain</Label>
              <Input
                id="prov-domain"
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                placeholder="acme.com"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="prov-issuer">Issuer</Label>
              <Input
                id="prov-issuer"
                value={issuer}
                onChange={(e) => setIssuer(e.target.value)}
                placeholder="https://idp.acme.com"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="prov-saml">SAML metadata XML</Label>
              <textarea
                id="prov-saml"
                value={samlConfig}
                onChange={(e) => setSamlConfig(e.target.value)}
                className="w-full min-h-24 rounded-md border border-zinc-300 px-3 py-2 text-sm font-mono"
                placeholder="<EntityDescriptor …>"
              />
            </div>
            {providerError && (
              <p className="text-sm text-red-600">{providerError}</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAdd(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => createProviderMutation.mutate()}
              disabled={createProviderMutation.isPending}
            >
              {createProviderMutation.isPending ? "Adding…" : "Add provider"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
