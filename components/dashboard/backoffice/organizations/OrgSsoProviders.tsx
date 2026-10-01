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
 * D22 — staff approve or revoke an org's SSO providers. The plugin refuses
 * sign-in through a provider until it is approved; the route re-checks the
 * DNS claim and writes the OpsActionLog row. The page is ADMIN-only
 * (`organizations.manage`), as is the route.
 */
export function OrgSsoProviders({
  orgId,
  providers,
}: Readonly<{ orgId: string; providers: Provider[] }>) {
  const router = useRouter();

  const setApproval = async (p: Provider, approve: boolean, reason = "") => {
    const res = await fetch(
      `/api/admin/organizations/${orgId}/sso-providers/${encodeURIComponent(p.providerId)}/approval`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approve, reason }),
      },
    );
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok)
      throw new Error(json.error ?? "The change did not go through.");
    router.refresh();
  };

  return (
    <Section title="SSO providers" variant="card">
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
