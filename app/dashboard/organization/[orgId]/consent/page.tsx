"use client";

/**
 * /dashboard/organization/[orgId]/consent
 *
 * DPDP (Digital Personal Data Protection Act 2023) consent-artifact
 * dashboard. Lists this org's `ConsentArtifact`s (active + withdrawn
 * history) read-only. Granting and withdrawing are the member's own acts
 * (#1527 decision 5): an operator records a member's withdrawal request,
 * which the member sees in Account settings next to their Withdraw control.
 *
 * Gated via the org permission matrix (consent.read: OWNER, MAINTAINER,
 * MANAGER); requests are consent.requestWithdrawal, the same three roles.
 */

import { use, useEffect, useId, useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
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
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { PURPOSE_CODE_META } from "@/lib/compliance/purpose-codes";
import { useToast } from "@/hooks/use-toast";

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

type RequestVars = { purposeCode: string; reason?: string };

/** #1527 decision 5 — records the member's ask; it withdraws nothing. */
function RecordRequestDialog({
  purposes,
  purposeLabel,
  disabled,
  onRecord,
}: Readonly<{
  purposes: string[];
  purposeLabel: (code: string) => string;
  disabled: boolean;
  onRecord: (vars: RequestVars) => Promise<unknown>;
}>) {
  const [purpose, setPurpose] = useState(purposes[0] ?? "");
  const [reason, setReason] = useState("");
  const reasonId = useId();
  const purposeId = useId();

  return (
    <ConfirmDialog
      title="Record a withdrawal request?"
      description="Only the member can withdraw their consent. This records that they asked the organization to stop, and shows the request in their Account settings next to the Withdraw control. Nothing is withdrawn until they do it."
      confirmLabel="Record request"
      onOpenChange={(open) => {
        if (!open) {
          setPurpose(purposes[0] ?? "");
          setReason("");
        }
      }}
      onConfirm={async () => {
        await onRecord({
          purposeCode: purpose,
          reason: reason.trim() || undefined,
        });
      }}
      trigger={
        <Button size="sm" variant="outline" disabled={disabled}>
          Record withdrawal request
        </Button>
      }
    >
      <div className="space-y-1.5">
        <Label id={purposeId}>Purpose</Label>
        <RadioGroup
          value={purpose}
          onValueChange={setPurpose}
          aria-labelledby={purposeId}
        >
          {purposes.map((p) => (
            <div key={p} className="flex items-center gap-2">
              <RadioGroupItem id={`${purposeId}-${p}`} value={p} />
              <Label htmlFor={`${purposeId}-${p}`} className="font-normal">
                {purposeLabel(p)}
              </Label>
            </div>
          ))}
        </RadioGroup>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={reasonId}>Reason (optional)</Label>
        <Textarea
          id={reasonId}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
          rows={3}
        />
        <p className="text-xs text-muted-foreground">
          The request and its reason are kept in the audit log.
        </p>
      </div>
    </ConfirmDialog>
  );
}

export default function ConsentPage({ params }: Readonly<PageProps>) {
  const { orgId } = use(params);
  const { allowed, isLoading: isGateLoading } = useRequireOrgAccess(orgId, {
    permission: "consent.read",
  });
  const { toast } = useToast();

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

  // Failures show inside the dialog, which rethrows them.
  const requestWithdrawal = useMutation({
    mutationFn: async (vars: RequestVars & { userId: string }) => {
      const res = await fetch(
        `/api/organizations/${orgId}/consent/withdrawal-requests`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(vars),
        },
      );
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        throw new Error(body.error ?? "Couldn't record the request");
      }
    },
    onSuccess: () => toast({ title: "Withdrawal request recorded" }),
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
      key: "request",
      header: "Withdrawal request",
      headClassName: "text-right",
      className: "text-right",
      cell: (row) => (
        <RecordRequestDialog
          purposes={row.purposeCodes}
          purposeLabel={purposeLabel}
          disabled={requestWithdrawal.isPending}
          onRecord={(vars) =>
            requestWithdrawal.mutateAsync({ ...vars, userId: row.userId })
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
        <Card>
          <CardHeader>
            <CardTitle>Active consents</CardTitle>
            <CardDescription>
              Consents members have granted. Only the member can give or
              withdraw their consent, in their Account settings. When a member
              asks the organization to stop, record their withdrawal request: it
              withdraws nothing, and the member sees it next to their Withdraw
              control.
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
