"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";

import { useBackofficeCapability } from "@/components/dashboard/backoffice/BackofficeCapabilityProvider";
import { ConfirmDialog } from "@/components/dashboard/ConfirmDialog";
import {
  DashboardContent,
  PageHeader,
} from "@/components/dashboard/PageScaffold";
import { KeyValueList, Section } from "@/components/dashboard/Section";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { Button } from "@/components/ui/button";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import type { User360 } from "@/lib/backoffice/user-360";
import { ticketStatus } from "@/lib/labels/backoffice-labels";
import { gatewayLabel } from "@/lib/labels/money-labels";
import { paymentStatusBadge } from "@/lib/labels/session-labels";
import { humanizeEnum, type Tone } from "@/lib/ui/tone";
import { formatCurrencyAmount } from "@/utils/formatting";

type Row<K extends keyof User360> =
  User360[K] extends Array<infer R> ? R : never;

const day = (d: Date | string) => new Date(d).toLocaleDateString();

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

const REPORT_TONE: Record<string, Tone> = {
  PENDING: "warning",
  UNDER_REVIEW: "caution",
  ACTION_TAKEN: "critical",
  ESCALATED: "critical",
  DISMISSED: "neutral",
};

async function postJson(url: string, body: Record<string, unknown>) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as {
    error?: string;
    href?: string;
  };
  if (!res.ok) throw new Error(json.error ?? "That did not go through.");
  return json;
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
  const canModerate = can("users.moderate");

  const viewDashboard = (facet: "consultant" | "consultee") => (
    <ConfirmDialog
      key={facet}
      trigger={
        <Button variant="outline" size="sm">
          View {facet === "consultant" ? "expert" : "client"} dashboard
        </Button>
      }
      title={`Open ${profile.name}'s dashboard?`}
      description="You see it read-only, as they do. The visit is recorded in the audit log."
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
          ? `Ban ${profile.name}?`
          : `Suspend ${profile.name} for 7 days?`
      }
      description="The account loses access and its upcoming appointments are cancelled."
      confirmLabel={action === "USER_BANNED" ? "Ban account" : "Suspend"}
      tone="destructive"
      requireReason={{ label: "Reason (kept on the report)" }}
      onConfirm={async ({ reason }) => {
        await postJson(`/api/staff/moderation/reports/${report.id}/action`, {
          actionType: action,
          notes: reason,
          ...(action === "USER_SUSPENDED" ? { suspensionDays: 7 } : {}),
        });
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
      title={`Lift the ban on ${profile.name}?`}
      description="The account can sign in and use chat again."
      confirmLabel="Lift ban"
      requireReason={{}}
      onConfirm={async ({ reason }) => {
        await postJson(`/api/staff/moderation/reports/${report.id}/unban`, {
          notes: reason,
        });
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
      cell: (r) => (
        <StatusBadge
          label={humanizeEnum(r.status)}
          tone={REPORT_TONE[r.status] ?? "neutral"}
        />
      ),
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

  const banned = profile.banned === true;
  let accountState: ReactNode = <StatusBadge label="Active" tone="success" />;
  if (profile.erasedAt) {
    accountState = <StatusBadge label="Erased" tone="neutral" />;
  } else if (banned) {
    accountState = (
      <StatusBadge
        label={
          profile.banExpires
            ? `Suspended until ${day(profile.banExpires)}`
            : "Banned"
        }
        tone="critical"
      />
    );
  }

  return (
    <>
      <PageHeader
        title={profile.name}
        description={profile.email}
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
              { label: "Role", value: humanizeEnum(profile.role ?? "none") },
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
              { label: "Joined", value: day(profile.createdAt) },
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
            rows={data.bookings}
            getRowId={(b) => b.id}
            empty={<Empty>No bookings.</Empty>}
          />
        </Section>

        <Section title="Payments" description="The ten most recent payments.">
          <ResponsiveTable
            columns={paymentColumns}
            rows={data.payments}
            getRowId={(p) => p.id}
            getRowHref={(p) => `${basePath}/payments/${p.id}`}
            empty={<Empty>No payments.</Empty>}
          />
        </Section>

        <Section title="Support tickets">
          <ResponsiveTable
            columns={ticketColumns}
            rows={data.tickets}
            getRowId={(t) => t.id}
            empty={<Empty>No tickets.</Empty>}
          />
        </Section>

        <Section title="Reports and bans">
          <ResponsiveTable
            columns={reportColumns}
            rows={data.reports}
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
              rows={data.verifications}
              getRowId={(v) => v.id}
              empty={<Empty>No verification submitted.</Empty>}
            />
          </Section>
        )}
      </DashboardContent>
    </>
  );
}
