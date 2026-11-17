"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { z } from "zod";

import { useBackofficeCapability } from "@/components/dashboard/backoffice/BackofficeCapabilityProvider";
import { callOpsDoor } from "@/components/dashboard/backoffice/money/ops-door";
import { ConfirmDialog } from "@/components/dashboard/ConfirmDialog";
import {
  DashboardContent,
  PageHeader,
} from "@/components/dashboard/PageScaffold";
import { KeyValueList, Section } from "@/components/dashboard/Section";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { traceHref } from "@/lib/backoffice/entity-trace-types";
import type { User360 } from "@/lib/backoffice/user-360";
import { formatPerson } from "@/lib/backoffice/person";
import {
  moderationReportStatus,
  ticketStatus,
} from "@/lib/labels/backoffice-labels";
import { OperatorTime } from "@/lib/time/operator-time";
import { formatOperatorInstant } from "@/lib/time/operator-zone";
import { gatewayLabel } from "@/lib/labels/money-labels";
import { paymentStatusBadge } from "@/lib/labels/session-labels";
import { humanizeEnum, type Tone } from "@/lib/ui/tone";
import { userRoleLabel } from "@/lib/labels/personal-dashboard";
import { formatCurrencyAmount } from "@/utils/formatting";
import {
  moderationActionBody,
  unbanBody,
} from "@/lib/backoffice/people-door-bodies";

type Row<K extends keyof User360> = User360[K] extends { rows: Array<infer R> }
  ? R
  : never;

const day = (d: Date | string) => <OperatorTime value={d} kind="date" />;

const SECTION_FAILED = new Error("This section could not load.");

// Cases must be `ProfileVerificationStatus` values (a test pins them to the
// schema): an uncovered status would fall to "Not Submitted", a false claim.
const getVerificationStatusBadge = (
  status: string | null,
): { label: string; tone: Tone } => {
  switch (status) {
    case "APPROVED":
      return { label: "Verified", tone: "success" };
    case "PENDING":
      return { label: "Pending", tone: "caution" };
    case "NEEDS_INFO":
      return { label: "Needs info", tone: "warning" };
    case "SUPERSEDED":
      return { label: "Superseded", tone: "neutral" };
    case "REJECTED":
      return { label: "Rejected", tone: "critical" };
    default:
      return { label: "Not Submitted", tone: "neutral" };
  }
};

async function postJson(url: string, body: Record<string, unknown>) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = doorAnswerSchema.safeParse(await res.json().catch(() => ({})));
  const json = parsed.success ? parsed.data : {};
  if (!res.ok) throw new Error(json.error ?? "That did not go through.");
  return json;
}

/** A door's answer as this page reads it: a refusal's copy, or the dashboard link. */
const doorAnswerSchema = z.object({
  error: z.string().optional(),
  href: z.string().optional(),
});

const PAN_STATE: Record<
  NonNullable<User360["pan"]>["state"],
  { label: string; tone: Tone }
> = {
  VERIFIED: { label: "Verified", tone: "success" },
  PENDING: { label: "Pending verification", tone: "caution" },
  NOT_PROVIDED: { label: "Not provided", tone: "neutral" },
};

/** Verify or reject the PAN on file; a name mismatch needs the override ticked. */
function PanDoor({
  userId,
  decision,
  pan,
}: Readonly<{
  userId: string;
  decision: "VERIFY" | "REJECT";
  pan: NonNullable<User360["pan"]>;
}>) {
  const router = useRouter();
  const [override, setOverride] = useState(false);
  const verify = decision === "VERIFY";
  return (
    <ConfirmDialog
      trigger={
        <Button size="sm" variant="outline">
          {verify ? "Verify PAN" : "Reject PAN"}
        </Button>
      }
      title={verify ? "Verify this PAN?" : "Reject this PAN?"}
      description={
        verify
          ? "Payouts then withhold TDS at the with-PAN rate."
          : "Payouts then withhold TDS at the no-PAN rate."
      }
      confirmLabel={verify ? "Verify PAN" : "Reject PAN"}
      tone={verify ? "default" : "destructive"}
      requireReason={{}}
      onConfirm={async ({ reason }) => {
        await callOpsDoor(`/api/admin/users/${userId}/tax-info/verify-pan`, {
          decision,
          reason,
          ...(verify && override ? { overrideNameMismatch: true } : {}),
        });
        router.refresh();
      }}
    >
      {verify && !pan.namesMatch && (
        <div className="flex items-center gap-2">
          <Checkbox
            id={`pan-override-${decision}`}
            checked={override}
            onCheckedChange={(c) => setOverride(c === true)}
          />
          <Label htmlFor={`pan-override-${decision}`}>
            The names differ; verify anyway
          </Label>
        </div>
      )}
    </ConfirmDialog>
  );
}

function Empty({ children }: Readonly<{ children: ReactNode }>) {
  return <p className="py-6 text-sm text-muted-foreground">{children}</p>;
}

/**
 * #1527 Q5 — one person across every queue: profile and roles, bookings,
 * payments, tickets, moderation, verification. Suspend/Ban/Lift are admin's
 * (`users.moderate`) and go through the report doors with a written reason.
 */
export function User360Client({ data }: Readonly<{ data: User360 }>) {
  const { basePath, can } = useBackofficeCapability();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { profile } = data;
  const person = formatPerson(profile);
  const canModerate = can("users.moderate");
  const canManagePayouts = can("payouts.manage");
  const canTrace = can("payments.read");
  const traceLink = (kind: "payment" | "appointment", id: string) => (
    <Button size="sm" variant="outline" asChild>
      <Link href={traceHref(basePath, kind, id)}>Trace</Link>
    </Button>
  );

  const viewDashboard = (facet: "consultant" | "consultee") => (
    <ConfirmDialog
      key={facet}
      trigger={
        <Button variant="outline" size="sm">
          View {facet === "consultant" ? "expert" : "learner"} dashboard
        </Button>
      }
      title={`Open ${person.primary}'s dashboard?`}
      // #1527 QA B6 — nothing enforces read-only, so the copy doesn't promise it.
      description="You see their dashboard as they do. Anything you do there runs as you and is logged, and this visit is recorded in the audit log."
      confirmLabel="Open dashboard"
      requireReason={{ label: "Why are you opening it?" }}
      onConfirm={async ({ reason }) => {
        const { href } = await postJson(
          `/api/admin/users/${profile.id}/view-dashboard`,
          { facet, reason },
        );
        if (href) router.push(href);
      }}
    />
  );

  const reportAction = (
    report: Row<"reports">,
    action: "USER_SUSPENDED" | "USER_BANNED",
  ) => (
    <ConfirmDialog
      key={action}
      trigger={
        <Button size="sm" variant="outline">
          {action === "USER_BANNED" ? "Ban" : "Suspend 7 days"}
        </Button>
      }
      title={
        action === "USER_BANNED"
          ? `Ban ${person.primary}?`
          : `Suspend ${person.primary} for 7 days?`
      }
      description="The account loses access and its upcoming appointments are cancelled."
      confirmLabel={action === "USER_BANNED" ? "Ban account" : "Suspend"}
      tone="destructive"
      requireReason={{ label: "Reason (kept on the report)" }}
      onConfirm={async ({ reason }) => {
        await postJson(
          `/api/staff/moderation/reports/${report.id}/action`,
          moderationActionBody({
            actionType: action,
            reason: reason ?? "",
            suspensionDays: 7,
          }),
        );
        void queryClient.invalidateQueries({
          queryKey: ["backoffice-nav-counts"],
        });
        router.refresh();
      }}
    />
  );

  const liftBan = (report: Row<"reports">) => (
    <ConfirmDialog
      trigger={
        <Button size="sm" variant="outline">
          Lift ban
        </Button>
      }
      title={`Lift the ban on ${person.primary}?`}
      description="The account can sign in and use chat again."
      confirmLabel="Lift ban"
      requireReason={{}}
      onConfirm={async ({ reason }) => {
        await postJson(
          `/api/staff/moderation/reports/${report.id}/unban`,
          unbanBody({ reason: reason ?? "" }),
        );
        router.refresh();
      }}
    />
  );

  const bookingColumns: ResponsiveColumn<Row<"bookings">>[] = [
    {
      key: "type",
      header: "Booking",
      primary: true,
      cell: (b) => humanizeEnum(b.appointment.appointmentType),
    },
    { key: "role", header: "As", cell: (b) => humanizeEnum(b.role) },
    {
      key: "status",
      header: "Seat",
      cell: (b) => <StatusBadge label={humanizeEnum(b.status)} variant="dot" />,
    },
    {
      key: "when",
      header: "Booked",
      cell: (b) => day(b.appointment.createdAt),
    },
  ];
  const paymentColumns: ResponsiveColumn<Row<"payments">>[] = [
    {
      key: "amount",
      header: "Amount",
      primary: true,
      cell: (p) => formatCurrencyAmount(Number(p.amount), p.currency),
    },
    {
      key: "status",
      header: "Status",
      cell: (p) => <StatusBadge {...paymentStatusBadge(p.paymentStatus)} />,
    },
    {
      key: "gateway",
      header: "Gateway",
      cell: (p) => gatewayLabel(p.paymentGateway),
    },
    { key: "when", header: "Date", cell: (p) => day(p.createdAt) },
  ];
  const ticketColumns: ResponsiveColumn<Row<"tickets">>[] = [
    {
      key: "title",
      header: "Ticket",
      primary: true,
      cell: (t) => `${t.referenceNumber ?? t.id.slice(0, 8)} · ${t.title}`,
    },
    {
      key: "status",
      header: "Status",
      cell: (t) => <StatusBadge {...ticketStatus(t.status)} />,
    },
    { key: "when", header: "Opened", cell: (t) => day(t.createdAt) },
  ];
  const reportColumns: ResponsiveColumn<Row<"reports">>[] = [
    {
      key: "reason",
      header: "Report",
      primary: true,
      cell: (r) => `${humanizeEnum(r.type)} · ${r.reason}`,
    },
    {
      key: "status",
      header: "Status",
      cell: (r) => <StatusBadge {...moderationReportStatus(r.status)} />,
    },
    { key: "when", header: "Filed", cell: (r) => day(r.createdAt) },
  ];
  const verificationColumns: ResponsiveColumn<Row<"verifications">>[] = [
    {
      key: "status",
      header: "Submission",
      primary: true,
      cell: (v) => <StatusBadge {...getVerificationStatusBadge(v.status)} />,
    },
    {
      key: "docs",
      header: "Documents",
      cell: (v) => `${v._count.documents}`,
    },
    { key: "submitted", header: "Submitted", cell: (v) => day(v.submittedAt) },
    {
      key: "reviewed",
      header: "Reviewed",
      cell: (v) => (v.reviewedAt ? day(v.reviewedAt) : "Not yet"),
    },
  ];
  const sentryIssueColumns: ResponsiveColumn<
    NonNullable<User360["sentryIssues"]["issues"]>[number]
  >[] = [
    {
      key: "issue",
      header: "Issue",
      primary: true,
      cell: (i) => (
        <a
          href={i.permalink}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium underline-offset-4 hover:underline"
        >
          {i.shortId} · {i.title}
        </a>
      ),
    },
    {
      key: "culprit",
      header: "Where",
      cell: (i) => i.culprit ?? "—",
    },
    {
      key: "level",
      header: "Level",
      cell: (i) => (
        <StatusBadge
          label={humanizeEnum(i.level ?? "error")}
          tone={
            i.level === "fatal" || i.level === "error"
              ? "critical"
              : i.level === "warning"
                ? "warning"
                : "neutral"
          }
        />
      ),
    },
    {
      key: "lastSeen",
      header: "Last seen",
      cell: (i) => day(i.lastSeen ?? ""),
    },
  ];

  const banned = profile.banned === true;
  let accountState: ReactNode = <StatusBadge label="Active" tone="success" />;
  if (profile.erasedAt) {
    accountState = <StatusBadge label="Erased" tone="neutral" />;
  } else if (banned) {
    accountState = (
      <StatusBadge
        label={
          profile.banExpires
            ? `Suspended until ${formatOperatorInstant(profile.banExpires, "date")}`
            : "Banned"
        }
        tone="critical"
      />
    );
  }

  return (
    <>
      <PageHeader
        title={person.primary}
        description={person.secondary ?? undefined}
        back={{ href: `${basePath}/users`, label: "Users" }}
        actions={
          <div className="flex flex-wrap gap-2">
            {profile.consultantProfile && viewDashboard("consultant")}
            {profile.consulteeProfile && viewDashboard("consultee")}
          </div>
        }
      />
      <DashboardContent>
        <Section title="Profile" variant="card">
          <KeyValueList
            items={[
              { label: "Role", value: userRoleLabel(profile.role) },
              { label: "Account", value: accountState },
              ...(banned && profile.banReason
                ? [{ label: "Ban reason", value: profile.banReason }]
                : []),
              {
                label: "Onboarding",
                value: profile.onboardingCompleted
                  ? "Complete"
                  : "Not finished",
              },
              {
                label: "Joined",
                value: <OperatorTime value={profile.createdAt} />,
              },
              {
                label: "Location",
                value:
                  [profile.city, profile.country].filter(Boolean).join(", ") ||
                  "Not given",
              },
              { label: "Phone", value: profile.phone ?? "Not given" },
              {
                label: "Organizations",
                value:
                  profile.memberships.length === 0
                    ? "None"
                    : profile.memberships
                        .map(
                          (m) =>
                            `${m.organization.name} (${humanizeEnum(m.role)}, ${humanizeEnum(m.status)})`,
                        )
                        .join("; "),
              },
              ...(profile.staffProfile
                ? [
                    {
                      label: "Staff role",
                      value:
                        [
                          profile.staffProfile.position,
                          profile.staffProfile.department,
                        ]
                          .filter(Boolean)
                          .join(", ") || "Not set",
                    },
                  ]
                : []),
            ]}
          />
        </Section>

        <Section title="Bookings" description="The ten most recent seats.">
          <ResponsiveTable
            columns={bookingColumns}
            rows={data.bookings.rows}
            error={data.bookings.failed ? SECTION_FAILED : undefined}
            onRetry={() => router.refresh()}
            getRowId={(b) => b.id}
            rowActions={
              canTrace
                ? (b) => traceLink("appointment", b.appointment.id)
                : undefined
            }
            empty={<Empty>No bookings.</Empty>}
          />
        </Section>

        <Section title="Payments" description="The ten most recent payments.">
          <ResponsiveTable
            columns={paymentColumns}
            rows={data.payments.rows}
            error={data.payments.failed ? SECTION_FAILED : undefined}
            onRetry={() => router.refresh()}
            getRowId={(p) => p.id}
            getRowHref={(p) => `${basePath}/payments/${p.id}`}
            rowActions={
              canTrace ? (p) => traceLink("payment", p.id) : undefined
            }
            empty={<Empty>No payments.</Empty>}
          />
        </Section>

        <Section title="Support tickets">
          <ResponsiveTable
            columns={ticketColumns}
            rows={data.tickets.rows}
            error={data.tickets.failed ? SECTION_FAILED : undefined}
            onRetry={() => router.refresh()}
            getRowId={(t) => t.id}
            // #1527 — each ticket opens as a case in the Support inbox.
            getRowHref={(t) => `${basePath}/support/c_${t.id}`}
            empty={<Empty>No tickets.</Empty>}
          />
        </Section>

        <Section
          title="Recent errors"
          description="Unresolved Sentry issues attributed to this user in the last 14 days."
        >
          {data.sentryIssues.configured ? (
            <ResponsiveTable
              columns={sentryIssueColumns}
              rows={data.sentryIssues.issues ?? []}
              getRowId={(i) => i.shortId}
              empty={<Empty>No unresolved errors in the last 14 days.</Empty>}
            />
          ) : (
            <Empty>Error triage is not configured.</Empty>
          )}
        </Section>

        <Section title="Reports and bans">
          <ResponsiveTable
            columns={reportColumns}
            rows={data.reports.rows}
            error={data.reports.failed ? SECTION_FAILED : undefined}
            onRetry={() => router.refresh()}
            getRowId={(r) => r.id}
            rowActions={
              canModerate
                ? (r) => (
                    <div className="flex gap-2">
                      {r.status === "PENDING" &&
                        !banned && [
                          reportAction(r, "USER_SUSPENDED"),
                          reportAction(r, "USER_BANNED"),
                        ]}
                      {banned && r.status === "ACTION_TAKEN" && liftBan(r)}
                    </div>
                  )
                : undefined
            }
            empty={<Empty>Nobody has reported this person.</Empty>}
          />
        </Section>

        {profile.consultantProfile && (
          <Section title="Verification">
            <ResponsiveTable
              columns={verificationColumns}
              rows={data.verifications.rows}
              error={data.verifications.failed ? SECTION_FAILED : undefined}
              onRetry={() => router.refresh()}
              getRowId={(v) => v.id}
              empty={<Empty>No verification submitted.</Empty>}
            />
          </Section>
        )}

        {data.panFailed && (
          <Section title="PAN" variant="card">
            <p className="text-sm text-destructive">
              The PAN state could not load.{" "}
              <button
                type="button"
                className="underline"
                onClick={() => router.refresh()}
              >
                Retry
              </button>
            </p>
          </Section>
        )}
        {data.pan && (
          <Section
            title="PAN"
            variant="card"
            actions={
              canManagePayouts && data.pan.state !== "NOT_PROVIDED" ? (
                <PanDoor
                  key={data.pan.state}
                  userId={profile.id}
                  decision={data.pan.state === "VERIFIED" ? "REJECT" : "VERIFY"}
                  pan={data.pan}
                />
              ) : undefined
            }
          >
            <KeyValueList
              items={[
                {
                  label: "PAN",
                  value: <StatusBadge {...PAN_STATE[data.pan.state]} />,
                  hint: data.pan.panLast4
                    ? `Ending ${data.pan.panLast4}`
                    : undefined,
                },
                {
                  label: "Payout account holder",
                  value: data.pan.payoutHolderName ?? "No verified account",
                  hint: data.pan.payoutHolderName
                    ? `${data.pan.namesMatch ? "Matches" : "Does not match"} the account name`
                    : undefined,
                },
              ]}
            />
          </Section>
        )}
      </DashboardContent>
    </>
  );
}
