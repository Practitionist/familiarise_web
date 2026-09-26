"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { useSearchParams } from "next/navigation";
import { useState } from "react";

import { ConfirmDialog } from "@/components/dashboard/ConfirmDialog";
import { FilterBar } from "@/components/dashboard/FilterBar";
import { PageHeader } from "@/components/dashboard/PageScaffold";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { UrlTabs } from "@/components/dashboard/UrlTabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { BREACH_REPORTING_DEADLINE_HOURS } from "@/lib/backoffice/queue-predicates";
import { humanizeEnum, type Tone } from "@/lib/ui/tone";

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to load");
  return ((await res.json()) as { data: T }).data;
}

async function postJson(url: string, body?: Record<string, unknown>) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(json.error ?? "That did not go through.");
}

const ago = (iso: string) =>
  formatDistanceToNow(new Date(iso), { addSuffix: true });

function useInvalidate() {
  const queryClient = useQueryClient();
  return (key: string) => {
    void queryClient.invalidateQueries({ queryKey: [key] });
    void queryClient.invalidateQueries({ queryKey: ["backoffice-nav-counts"] });
  };
}

// ── Erasure requests ────────────────────────────────────────────────────

interface Erasure {
  id: string;
  status: string;
  requestedAt: string;
  reason: string | null;
  user: { id: string; name: string | null; email: string };
}

const ERASURE_TONE: Record<string, Tone> = {
  PENDING: "warning",
  IN_PROGRESS: "info",
  COMPLETED: "success",
  REJECTED: "neutral",
};

function ErasureTab() {
  const invalidate = useInvalidate();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["compliance-erasure"],
    queryFn: () => getJson<Erasure[]>("/api/admin/erasure-requests"),
  });
  const open = (e: Erasure) =>
    e.status === "PENDING" || e.status === "IN_PROGRESS";
  const columns: ResponsiveColumn<Erasure>[] = [
    {
      key: "user",
      header: "Person",
      primary: true,
      cell: (e) => (
        <div>
          <p className="font-medium">{e.user.name ?? "Unnamed"}</p>
          <p className="text-xs text-muted-foreground">{e.user.email}</p>
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (e) => (
        <StatusBadge
          label={humanizeEnum(e.status)}
          tone={ERASURE_TONE[e.status] ?? "neutral"}
        />
      ),
    },
    // No statutory erasure deadline is encoded anywhere yet, so the page
    // shows how long a request has been open instead of inventing one.
    { key: "age", header: "Requested", cell: (e) => ago(e.requestedAt) },
  ];
  return (
    <ResponsiveTable<Erasure>
      columns={columns}
      rows={data ?? []}
      getRowId={(e) => e.id}
      isLoading={isLoading && !data}
      error={error && !data ? error : undefined}
      onRetry={() => void refetch()}
      rowActions={(e) =>
        open(e) ? (
          <div className="flex gap-2">
            <ConfirmDialog
              trigger={<Button size="sm">Process</Button>}
              title={`Erase ${e.user.email}?`}
              description="Their personal data is scrubbed for good. Refused while money is still moving for them."
              confirmLabel="Erase"
              tone="destructive"
              requireTyped="ERASE"
              onConfirm={async () => {
                await postJson(`/api/admin/erasure-requests/${e.id}/process`);
                invalidate("compliance-erasure");
              }}
            />
            <ConfirmDialog
              trigger={
                <Button size="sm" variant="outline">
                  Reject
                </Button>
              }
              title="Reject this erasure request?"
              description="The reason is stored on the request; the law allows a refusal only on a lawful ground."
              confirmLabel="Reject"
              requireReason={{ label: "Lawful ground for refusing" }}
              onConfirm={async ({ reason }) => {
                await postJson(`/api/admin/erasure-requests/${e.id}/reject`, {
                  reason,
                });
                invalidate("compliance-erasure");
              }}
            />
          </div>
        ) : null
      }
      empty={
        <p className="py-10 text-center text-sm text-muted-foreground">
          No erasure requests.
        </p>
      }
    />
  );
}

// ── Data breaches ───────────────────────────────────────────────────────

interface Breach {
  id: string;
  detectedAt: string;
  reportedAt: string | null;
  rootCause: string;
  dpbReference: string | null;
  principalsNotifiedAt: string | null;
  affectedCount: number;
}

const HOUR_MS = 3_600_000;

function breachDeadline(b: Breach) {
  if (b.reportedAt) return <StatusBadge label="Board told" tone="success" />;
  const due =
    new Date(b.detectedAt).getTime() +
    BREACH_REPORTING_DEADLINE_HOURS * HOUR_MS;
  const when = formatDistanceToNow(due, { addSuffix: true });
  return due < Date.now() ? (
    <StatusBadge label={`Overdue, was due ${when}`} tone="critical" />
  ) : (
    <StatusBadge label={`Board due ${when}`} tone="warning" />
  );
}

function BreachesTab() {
  const invalidate = useInvalidate();
  // The breach alert email links `?tab=breaches&id=…`; that row is marked.
  const highlight = useSearchParams().get("id");
  const [affected, setAffected] = useState("");
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["compliance-breaches"],
    queryFn: () => getJson<Breach[]>("/api/admin/data-breaches"),
  });
  const columns: ResponsiveColumn<Breach>[] = [
    {
      key: "cause",
      header: "Breach",
      primary: true,
      cell: (b) => (
        <div>
          <p className={b.id === highlight ? "font-semibold" : "font-medium"}>
            {b.rootCause.slice(0, 80)}
          </p>
          <p className="text-xs text-muted-foreground">
            Detected {ago(b.detectedAt)} · {b.affectedCount} people
          </p>
        </div>
      ),
    },
    { key: "board", header: "Board (72 h)", cell: breachDeadline },
    {
      key: "people",
      header: "People told",
      cell: (b) =>
        b.principalsNotifiedAt ? ago(b.principalsNotifiedAt) : "Not yet",
    },
    {
      key: "ref",
      header: "Board reference",
      cell: (b) => b.dpbReference ?? "—",
    },
  ];
  return (
    <div className="space-y-4">
      <ConfirmDialog
        trigger={<Button variant="outline">Report a breach</Button>}
        title="Report a personal-data breach"
        description={`This starts the ${BREACH_REPORTING_DEADLINE_HOURS}-hour clock to tell the Data Protection Board.`}
        confirmLabel="Record breach"
        tone="destructive"
        requireReason={{ label: "Root cause", minLength: 10 }}
        onConfirm={async ({ reason }) => {
          const ids = affected
            .split(/[\s,]+/)
            .map((v) => v.trim())
            .filter(Boolean);
          if (ids.length === 0) {
            throw new Error("List at least one affected user id.");
          }
          await postJson("/api/admin/data-breaches", {
            affectedUserIds: ids,
            rootCause: reason,
          });
          setAffected("");
          invalidate("compliance-breaches");
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="breach-users">Affected user ids</Label>
          <Input
            id="breach-users"
            value={affected}
            onChange={(e) => setAffected(e.target.value)}
            placeholder="Comma or space separated"
          />
        </div>
      </ConfirmDialog>
      <ResponsiveTable<Breach>
        columns={columns}
        rows={data ?? []}
        getRowId={(b) => b.id}
        isLoading={isLoading && !data}
        error={error && !data ? error : undefined}
        onRetry={() => void refetch()}
        empty={
          <p className="py-10 text-center text-sm text-muted-foreground">
            No breaches recorded.
          </p>
        }
      />
    </div>
  );
}

// ── Failed emails ───────────────────────────────────────────────────────

interface FailedEmail {
  id: string;
  recipient: string;
  subject: string;
  emailType: string;
  status: string;
  attempts: number;
  lastError: string | null;
  createdAt: string;
}

const EMAIL_STATUSES = ["DEAD_LETTER", "RETRY", "PENDING", "SENT"];
const EMAIL_TONE: Record<string, Tone> = {
  DEAD_LETTER: "critical",
  RETRY: "caution",
  PENDING: "info",
  SENT: "success",
};

function FailedEmailsTab() {
  const invalidate = useInvalidate();
  const [status, setStatus] = useState<string | null>("DEAD_LETTER");
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["compliance-emails", status],
    queryFn: () =>
      getJson<FailedEmail[]>(
        `/api/admin/failed-emails?limit=100${status ? `&status=${status}` : ""}`,
      ),
  });
  const columns: ResponsiveColumn<FailedEmail>[] = [
    {
      key: "subject",
      header: "Email",
      primary: true,
      cell: (m) => (
        <div>
          <p className="font-medium">{m.subject}</p>
          <p className="text-xs text-muted-foreground">
            {m.recipient} · {m.emailType}
          </p>
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (m) => (
        <StatusBadge
          label={humanizeEnum(m.status)}
          tone={EMAIL_TONE[m.status] ?? "neutral"}
        />
      ),
    },
    { key: "attempts", header: "Attempts", cell: (m) => `${m.attempts}` },
    {
      key: "error",
      header: "Last error",
      cell: (m) => (
        <span className="line-clamp-2 text-sm text-muted-foreground">
          {m.lastError ?? "—"}
        </span>
      ),
    },
  ];
  return (
    <ResponsiveTable<FailedEmail>
      columns={columns}
      rows={data ?? []}
      getRowId={(m) => m.id}
      isLoading={isLoading && !data}
      error={error && !data ? error : undefined}
      onRetry={() => void refetch()}
      toolbar={
        <FilterBar
          chips={{
            label: "Status",
            options: EMAIL_STATUSES.map((value) => ({
              value,
              label: humanizeEnum(value),
            })),
            value: status,
            onChange: setStatus,
            clearable: true,
          }}
        />
      }
      rowActions={(m) =>
        m.status === "DEAD_LETTER" ? (
          <ConfirmDialog
            trigger={
              <Button size="sm" variant="outline">
                Replay
              </Button>
            }
            title="Send this email again?"
            description={`"${m.subject}" to ${m.recipient}, exactly as it was rendered.`}
            confirmLabel="Replay"
            onConfirm={async () => {
              await postJson("/api/admin/failed-emails", { ids: [m.id] });
              invalidate("compliance-emails");
            }}
          />
        ) : null
      }
      empty={
        <p className="py-10 text-center text-sm text-muted-foreground">
          No emails in this state.
        </p>
      }
    />
  );
}

/**
 * #1527 Q5 — the compliance queues that only had APIs: DPDP erasure
 * requests, data breaches (72-hour Board clock) and the failed-email
 * dead-letter queue.
 */
export function CompliancePageClient() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Compliance"
        description="Erasure requests, data breaches and emails that never arrived."
      />
      <UrlTabs
        tabs={[
          {
            value: "erasure",
            label: "Erasure requests",
            content: <ErasureTab />,
          },
          {
            value: "breaches",
            label: "Data breaches",
            content: <BreachesTab />,
          },
          {
            value: "emails",
            label: "Failed emails",
            content: <FailedEmailsTab />,
          },
        ]}
      />
    </div>
  );
}
