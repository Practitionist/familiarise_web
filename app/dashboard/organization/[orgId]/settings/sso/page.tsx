"use client";

import { use, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, ArrowLeft, Copy, Check } from "lucide-react";
import Link from "next/link";
import { useRequireOrgRole } from "../../useOrgRole";
import { useToast } from "@/hooks/use-toast";
import { deriveAcsUrl, deriveMetadataUrl } from "@/lib/sso/derive-urls";
import type { MemberRole } from "@prisma/client";
import {
  MEMBER_ROLE_LABEL,
  MemberRoleSchema,
} from "@/lib/labels/org-labels";

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
  providerType: "saml" | "oidc" | null;
}

function CopyableUrl({ label, value }: { label: string; value: string }) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast({ title: "Copied", description: label });
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast({ title: "Copy failed", variant: "destructive" });
    }
  };
  return (
    <div className="space-y-1">
      <p className="text-xs uppercase tracking-wide text-zinc-500">{label}</p>
      <div className="flex items-center gap-2 rounded-md bg-white border border-zinc-200 px-2 py-1">
        <code className="flex-1 text-xs font-mono text-zinc-700 break-all select-all">
          {value}
        </code>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label={`Copy ${label}`}
          onClick={handleCopy}
          className="h-6 w-6 flex-shrink-0"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-green-600" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>
    </div>
  );
}

interface SsoResponse {
  settings: {
    allowedEmailDomains: string[];
    enforceSSO: boolean;
    defaultRoleForAutoJoin: MemberRole;
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
  defaultRoleForAutoJoin?: MemberRole;
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
  providerType: "saml" | "oidc";
  samlConfig?: { issuer: string; entryPoint: string; cert: string };
  oidcConfig?: {
    issuer: string;
    clientId: string;
    clientSecret: string;
    discoveryEndpoint: string;
    pkce: boolean;
  };
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

// Auto-join via SSO grants one of the non-privileged MemberRoles. OWNER +
// SUPPORT + EXPERT are deliberately excluded: OWNER is destructive to
// grant automatically, SUPPORT is an operator role assigned manually,
// and EXPERT requires the consultant application workflow.
const AUTO_JOIN_ROLES = ["LEARNER", "MANAGER", "MAINTAINER"] as const;
const ROLE_OPTIONS = AUTO_JOIN_ROLES.map((value) => ({
  value,
  label: MEMBER_ROLE_LABEL[value],
}));

export default function OrgSsoPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = use(params);
  const { allowed } = useRequireOrgRole(orgId, "OWNER");
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["org-sso", orgId],
    queryFn: () => fetchSso(orgId),
  });

  const [domains, setDomains] = useState("");
  const [enforce, setEnforce] = useState(false);
  const [defaultRole, setDefaultRole] = useState<MemberRole>("LEARNER");

  useEffect(() => {
    if (!data) return;
    setDomains(data.settings.allowedEmailDomains.join(", "));
    setEnforce(data.settings.enforceSSO);
    setDefaultRole(data.settings.defaultRoleForAutoJoin);
  }, [data]);

  // shadcn's Select hands onValueChange a bare string. Narrow via Zod
  // so downstream state + the PATCH body are always a valid MemberRole.
  const handleRoleChange = (v: string) => {
    const parsed = MemberRoleSchema.safeParse(v);
    if (parsed.success) setDefaultRole(parsed.data);
  };

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
  const [providerType, setProviderType] = useState<"saml" | "oidc">("saml");
  const [providerId, setProviderId] = useState("");
  const [domain, setDomain] = useState("");
  const [issuer, setIssuer] = useState("");
  // SAML fields
  const [samlEntryPoint, setSamlEntryPoint] = useState("");
  const [samlCert, setSamlCert] = useState("");
  // OIDC fields
  const [oidcClientId, setOidcClientId] = useState("");
  const [oidcClientSecret, setOidcClientSecret] = useState("");
  const [oidcDiscoveryUrl, setOidcDiscoveryUrl] = useState("");
  const [providerError, setProviderError] = useState<string | null>(null);

  const createProviderMutation = useMutation({
    mutationFn: () =>
      createProvider(orgId, {
        providerId: providerId.trim(),
        domain: domain.trim(),
        issuer: issuer.trim(),
        providerType,
        ...(providerType === "saml"
          ? {
              samlConfig: {
                issuer: issuer.trim(),
                entryPoint: samlEntryPoint.trim(),
                cert: samlCert.trim(),
              },
            }
          : {
              oidcConfig: {
                issuer: issuer.trim(),
                clientId: oidcClientId.trim(),
                clientSecret: oidcClientSecret.trim(),
                discoveryEndpoint: oidcDiscoveryUrl.trim(),
                pkce: true,
              },
            }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["org-sso", orgId] });
      setShowAdd(false);
      setProviderId("");
      setDomain("");
      setIssuer("");
      setSamlEntryPoint("");
      setSamlCert("");
      setOidcClientId("");
      setOidcClientSecret("");
      setOidcDiscoveryUrl("");
      setProviderError(null);
    },
    onError: (err: Error) => setProviderError(err.message),
  });

  const deleteProviderMutation = useMutation({
    mutationFn: (id: string) => deleteProvider(orgId, id),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["org-sso", orgId] }),
  });

  if (!allowed) return null;

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
        subtitle="Configure SAML or OIDC sign-in for this organization"
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
                <Select value={defaultRole} onValueChange={handleRoleChange}>
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
                  <TableHead>Type</TableHead>
                  <TableHead>Domain</TableHead>
                  <TableHead>IdP setup URLs</TableHead>
                  <TableHead className="w-12"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.providers.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>
                      <Badge variant="secondary">{p.providerId}</Badge>
                    </TableCell>
                    <TableCell className="text-xs uppercase text-zinc-500">
                      {p.providerType ?? "—"}
                    </TableCell>
                    <TableCell>{p.domain}</TableCell>
                    <TableCell className="space-y-1.5 py-3">
                      <CopyableUrl
                        label={
                          p.providerType === "oidc"
                            ? "Redirect URI"
                            : "ACS URL"
                        }
                        value={deriveAcsUrl(p.providerId, p.providerType)}
                      />
                      {p.providerType === "saml" && (
                        <CopyableUrl
                          label="SP Metadata URL"
                          value={deriveMetadataUrl(p.providerId)}
                        />
                      )}
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
                      colSpan={5}
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
              <Label>Provider type</Label>
              <Select value={providerType} onValueChange={(v) => setProviderType(v as "saml" | "oidc")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="saml">SAML</SelectItem>
                  <SelectItem value="oidc">OIDC</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="rounded-md bg-zinc-50 border border-zinc-200 p-3 space-y-3">
              <p className="text-sm font-medium text-zinc-700">
                Configure these values in your IdP
              </p>
              <CopyableUrl
                label={
                  providerType === "saml" ? "ACS / Callback URL" : "Redirect URI"
                }
                value={deriveAcsUrl(providerId, providerType)}
              />
              {providerType === "saml" && (
                <CopyableUrl
                  label="SP Metadata URL (Entity ID)"
                  value={deriveMetadataUrl(providerId)}
                />
              )}
              <p className="text-xs text-zinc-500">
                Paste these into your IdP app configuration (Okta, Auth0, Azure
                AD, Google Workspace). URLs update when you change the Provider
                ID above.
              </p>
            </div>
            {providerType === "saml" ? (
              <>
                <div className="space-y-2">
                  <Label htmlFor="saml-entry">SSO entry point URL</Label>
                  <Input
                    id="saml-entry"
                    value={samlEntryPoint}
                    onChange={(e) => setSamlEntryPoint(e.target.value)}
                    placeholder="https://idp.acme.com/sso/saml"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="saml-cert">X.509 certificate</Label>
                  <textarea
                    id="saml-cert"
                    value={samlCert}
                    onChange={(e) => setSamlCert(e.target.value)}
                    className="w-full min-h-20 rounded-md border border-zinc-300 px-3 py-2 text-sm font-mono"
                    placeholder="MIICpDCCAYwCCQC..."
                  />
                </div>
              </>
            ) : (
              <>
                <div className="space-y-2">
                  <Label htmlFor="oidc-client-id">Client ID</Label>
                  <Input
                    id="oidc-client-id"
                    value={oidcClientId}
                    onChange={(e) => setOidcClientId(e.target.value)}
                    placeholder="abc123..."
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="oidc-secret">Client secret</Label>
                  <Input
                    id="oidc-secret"
                    type="password"
                    value={oidcClientSecret}
                    onChange={(e) => setOidcClientSecret(e.target.value)}
                    placeholder="secret..."
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="oidc-discovery">Discovery URL</Label>
                  <Input
                    id="oidc-discovery"
                    value={oidcDiscoveryUrl}
                    onChange={(e) => setOidcDiscoveryUrl(e.target.value)}
                    placeholder="https://idp.acme.com/.well-known/openid-configuration"
                  />
                </div>
              </>
            )}
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
