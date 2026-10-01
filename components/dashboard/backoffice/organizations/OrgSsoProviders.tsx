"use client";

import { useRouter } from "next/navigation";

import { ConfirmDialog } from "@/components/dashboard/ConfirmDialog";
import { Section } from "@/components/dashboard/Section";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { Button } from "@/components/ui/button";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import type { OrgDetail } from "@/lib/backoffice/org-detail";

type Provider = OrgDetail["ssoProviders"][number];

const yesNo = (ok: boolean, yes: string, no: string) => (
  <StatusBadge label={ok ? yes : no} tone={ok ? "success" : "caution"} />
);

const columns: ResponsiveColumn<Provider>[] = [
  {
    key: "provider",
    header: "Provider",
    primary: true,
    cell: (p) => (
      <div>
        <p className="font-medium">{p.providerId}</p>
        <p className="text-xs text-muted-foreground">{p.issuer}</p>
      </div>
    ),
  },
  { key: "domain", header: "Domain", cell: (p) => p.domain },
  {
    key: "claim",
    header: "DNS claim",
    cell: (p) => yesNo(p.claimVerified, "Verified", "Not verified"),
  },
  {
    key: "approved",
    header: "Sign-in",
    cell: (p) => yesNo(p.domainVerified, "Approved", "Pending approval"),
  },
];

/**
 * D22 — staff approve or revoke an org's SSO providers, and turn the org's SSO
 * enforcement on or off. The plugin refuses sign-in through a provider until
 * it is approved; the route re-checks the DNS claim and writes the
 * OpsActionLog row. Turning enforcement off is the recovery path when the
 * org's IdP breaks. The page is ADMIN-only (`organizations.manage`), as are
 * both routes.
 */
export function OrgSsoProviders({
  orgId,
  providers,
  enforced,
}: Readonly<{ orgId: string; providers: Provider[]; enforced: boolean }>) {
  const router = useRouter();

  const post = async (path: string, body: object) => {
    const res = await fetch(`/api/admin/organizations/${orgId}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok)
      throw new Error(json.error ?? "The change did not go through.");
    router.refresh();
  };

  const setApproval = (p: Provider, approve: boolean, reason = "") =>
    post(`sso-providers/${encodeURIComponent(p.providerId)}/approval`, {
      approve,
      reason,
    });

  return (
    <Section
      title="SSO providers"
      variant="card"
      actions={
        <ConfirmDialog
          trigger={
            <Button variant="outline" size="sm">
              {enforced ? "Stop enforcing SSO" : "Enforce SSO"}
            </Button>
          }
          title={enforced ? "Stop enforcing SSO?" : "Enforce SSO?"}
          description={
            enforced
              ? "Members can sign in with a password or Google again. Use this when the organisation's identity provider is broken."
              : "Members on the organisation's verified domains will only be able to sign in through an approved provider."
          }
          confirmLabel={enforced ? "Stop enforcing" : "Enforce"}
          tone={enforced ? "destructive" : "default"}
          requireReason={{ label: "Reason" }}
          onConfirm={({ reason }) =>
            post("sso-enforcement", { enforce: !enforced, reason })
          }
        />
      }
    >
      <p className="mb-3 text-sm text-muted-foreground">
        SSO enforcement: {enforced ? "on" : "off"}
      </p>
      <ResponsiveTable<Provider>
        columns={columns}
        rows={providers}
        getRowId={(p) => p.providerId}
        rowActions={(p) => (
          <ConfirmDialog
            trigger={
              <Button variant="outline" size="sm">
                {p.domainVerified ? "Revoke" : "Approve"}
              </Button>
            }
            title={
              p.domainVerified
                ? `Revoke ${p.providerId}?`
                : `Approve ${p.providerId}?`
            }
            description={
              p.domainVerified
                ? "Sign-in through this provider stops immediately."
                : `Users at ${p.domain} will be able to sign in through ${p.issuer}.`
            }
            confirmLabel={p.domainVerified ? "Revoke" : "Approve"}
            tone={p.domainVerified ? "destructive" : "default"}
            requireReason={{ label: "Reason" }}
            onConfirm={({ reason }) =>
              setApproval(p, !p.domainVerified, reason)
            }
          />
        )}
        empty={
          <p className="py-6 text-center text-sm text-muted-foreground">
            No SSO provider registered.
          </p>
        }
      />
    </Section>
  );
}
