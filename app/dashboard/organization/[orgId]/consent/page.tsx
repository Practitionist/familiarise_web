"use client";

/**
 * /dashboard/organization/[orgId]/consent
 *
 * DPDP (Digital Personal Data Protection Act 2023) consent-artifact
 * dashboard. Lists this org's `ConsentArtifact`s (active + withdrawn
 * history) and lets an operator record a member's withdrawal request.
 * Granting is the member's own act (#1527 decision 5): the API refuses an
 * operator grant on someone else's behalf, so this page offers none.
 *
 * Gated via the org permission matrix (consent.read: OWNER, MAINTAINER,
 * MANAGER); withdrawals are consent.withdraw, the same three roles.
 *
 * Withdrawal is irreversible in our model: a re-grant goes through POST
 * and mints a NEW artifact with a fresh hash, keeping chain-of-custody
 * intact for auditors.
 */

import { use, useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRequireOrgAccess } from "../useOrgRole";
import {
  DashboardHeader,
  DashboardContent,
} from "@/components/dashboard/PageScaffold";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/dashboard/ConfirmDialog";
import { Badge } from "@/components/ui/badge";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { PURPOSE_CODE_META } from "@/lib/compliance/purpose-codes";

type ConsentArtifact = {
  id: string;
  userId: string;
  dataFiduciary: string;
  purposeCodes: string[];
  grantedAt: string;
  withdrawnAt: string | null;
  language: string;
  consentManager: string | null;
  version: number;
  hash: string;
};

type Member = {
  user: { id: string; name: string | null; email: string };
  role: string;
};

type PageProps = { params: Promise<{ orgId: string }> };

// Client-only locale date — toLocaleString() differs between the SSR (server
// TZ/locale) and client render, which trips React hydration. Render after mount
// so the formatted value only ever appears client-side.
function LocalDateTime({ value }: { value: string | Date | null | undefined }) {
  const [text, setText] = useState("");
  useEffect(() => {
    setText(value ? new Date(value).toLocaleString() : "—");
  }, [value]);
  return <span suppressHydrationWarning>{text || "—"}</span>;
}

export default function ConsentPage({ params }: Readonly<PageProps>) {
  const { orgId } = use(params);
  const { allowed, isLoading: isGateLoading } = useRequireOrgAccess(orgId, {
    permission: "consent.read",
  });
  const qc = useQueryClient();

  const [actionError, setActionError] = useState<string | null>(null);

  // Names for the artifact table only — there is no grant picker (#1527).
  const members = useQuery<Member[]>({
    queryKey: ["org-members", orgId, "consent-labels"],
    queryFn: async () => {
      const res = await fetch(
        `/api/organizations/${orgId}/members?perPage=100`,
      );
      if (!res.ok) throw new Error("Failed to load members");
      const body = (await res.json()) as { data: Member[] };
      return body.data;
    },
    enabled: allowed,
  });

  const consents = useQuery<ConsentArtifact[]>({
    queryKey: ["org-consents", orgId],
    queryFn: async () => {
      const res = await fetch(`/api/organizations/${orgId}/consent?limit=200`);
      if (!res.ok) throw new Error("Failed to load consent artifacts");
      const body = (await res.json()) as { data: ConsentArtifact[] };
      return body.data;
    },
    enabled: allowed,
  });

  // Map userId → display label so the artifact table can show who the
  // data principal is without spelling out the raw id.
  const memberLabel = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of members.data ?? []) {
      map.set(m.user.id, m.user.name || m.user.email);
    }
    return map;
  }, [members.data]);

  // Withdrawal scopes to a single purposeCode when provided; omitting it
  // is the full DPDP §12 opt-out. The DELETE endpoint is idempotent.
  const withdraw = useMutation({
    mutationFn: async (vars: { userId: string; purposeCode?: string }) => {
      const qs = new URLSearchParams({ userId: vars.userId });
      if (vars.purposeCode) qs.set("purposeCode", vars.purposeCode);
      const res = await fetch(
        `/api/organizations/${orgId}/consent?${qs.toString()}`,
        { method: "DELETE" },
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to withdraw consent");
      return body as { withdrawnCount: number };
    },
    onSuccess: () => {
      setActionError(null);
      qc.invalidateQueries({ queryKey: ["org-consents", orgId] });
    },
    onError: (err) => setActionError(err.message),
  });

  if (isGateLoading || !allowed) return null;

  // Friendly label for a stored code; falls back to the raw value so any
  // legacy/free-form code still renders.
  const purposeLabel = (code: string) =>
    PURPOSE_CODE_META[code as keyof typeof PURPOSE_CODE_META]?.label ?? code;

  const rows = consents.data ?? [];
  const active = rows.filter((r) => r.withdrawnAt === null);
  const history = rows.filter((r) => r.withdrawnAt !== null);

  const memberCell = (row: ConsentArtifact) =>
    memberLabel.get(row.userId) ?? (
      <span className="font-mono text-xs text-muted-foreground">
        {row.userId}
      </span>
    );

  const activeColumns: ResponsiveColumn<ConsentArtifact>[] = [
    {
      key: "member",
      header: "Member",
      primary: true,
      className: "text-sm",
      cell: memberCell,
    },
    {
      key: "purposes",
      header: "Purposes",
      cell: (row) => (
        <div className="flex flex-wrap items-center gap-1">
          {row.purposeCodes.map((p) => (
            <Badge key={p} variant="secondary">
              {purposeLabel(p)}
              {/* #1527 Q10 — a DPDP withdrawal is not a one-click action. */}
              <ConfirmDialog
                title={`Withdraw "${purposeLabel(p)}"?`}
                description="The organization stops processing this member's data for this purpose from now on. The withdrawal is recorded and can't be undone; the member can grant it again."
                confirmLabel="Record withdrawal"
                tone="destructive"
                onConfirm={async () => {
                  await withdraw.mutateAsync({
                    userId: row.userId,
                    purposeCode: p,
                  });
                }}
                trigger={
                  <button
                    type="button"
                    aria-label={`Withdraw "${purposeLabel(p)}"`}
                    className="ml-1 text-muted-foreground hover:text-foreground"
                    disabled={withdraw.isPending}
                  >
                    ×
                  </button>
                }
              />
            </Badge>
          ))}
        </div>
      ),
    },
    {
      key: "language",
      header: "Language",
      className: "text-xs uppercase text-muted-foreground",
      cell: (row) => row.language,
    },
    {
      key: "granted",
      header: "Granted",
      className: "text-xs text-muted-foreground",
      cell: (row) => <LocalDateTime value={row.grantedAt} />,
    },
    {
      key: "withdraw",
      header: "Withdrawal",
      headClassName: "text-right",
      className: "text-right",
      cell: (row) => (
        <ConfirmDialog
          title="Withdraw every purpose?"
          description="This is the member's full DPDP opt-out: the organization stops processing their data for all purposes from now on. It is recorded and can't be undone."
          confirmLabel="Record withdrawal"
          tone="destructive"
          onConfirm={async () => {
            await withdraw.mutateAsync({ userId: row.userId });
          }}
          trigger={
            <Button size="sm" variant="outline" disabled={withdraw.isPending}>
              Record withdrawal
            </Button>
          }
        />
      ),
    },
  ];

  const historyColumns: ResponsiveColumn<ConsentArtifact>[] = [
    {
      key: "member",
      header: "Member",
      primary: true,
      className: "text-sm",
      cell: memberCell,
    },
    {
      key: "purposes",
      header: "Purposes",
      cell: (row) => (
        <div className="flex flex-wrap gap-1">
          {row.purposeCodes.map((p) => (
            <Badge
              key={p}
              variant="secondary"
              className="bg-muted text-muted-foreground"
            >
              {purposeLabel(p)}
            </Badge>
          ))}
        </div>
      ),
    },
    {
      key: "granted",
      header: "Granted",
      className: "text-xs text-muted-foreground",
      cell: (row) => <LocalDateTime value={row.grantedAt} />,
    },
    {
      key: "withdrawn",
      header: "Withdrawn",
      className: "text-xs text-muted-foreground",
      cell: (row) => <LocalDateTime value={row.withdrawnAt} />,
    },
    {
      key: "status",
      header: "Status",
      cell: () => (
        <Badge className="bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-300">
          Withdrawn
        </Badge>
      ),
    },
  ];

  return (
    <>
      <DashboardHeader
        title="DPDP consent"
        subtitle="Tamper-evident consent artifacts per the Digital Personal Data Protection Act 2023. Retained 7 years from grant or withdrawal."
      />
      <DashboardContent>
        {actionError && (
          <p className="mb-4 text-sm text-red-600">{actionError}</p>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Active consents</CardTitle>
            <CardDescription>
              Consents members have granted. Record a member&apos;s withdrawal
              request for one purpose or all of them — it stamps the artifact
              and stops downstream processing. Only the member can grant consent
              again.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0 sm:p-4">
            {consents.isLoading ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                Loading…
              </p>
            ) : (
              <ResponsiveTable<ConsentArtifact>
                columns={activeColumns}
                rows={active}
                getRowId={(row) => row.id}
                empty={
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    No active consent artifacts yet.
                  </p>
                }
              />
            )}
          </CardContent>
        </Card>

        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Withdrawal history</CardTitle>
            <CardDescription>
              Read-only record of withdrawn consents. Retained for the DPDP
              7-year audit window; a daily cron purges rows past retention.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0 sm:p-4">
            {consents.isLoading ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                Loading…
              </p>
            ) : (
              <ResponsiveTable<ConsentArtifact>
                columns={historyColumns}
                rows={history}
                getRowId={(row) => row.id}
                empty={
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    No withdrawn consents.
                  </p>
                }
              />
            )}
          </CardContent>
        </Card>
      </DashboardContent>
    </>
  );
}
