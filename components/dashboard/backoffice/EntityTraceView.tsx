"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import { useBackofficeCapability } from "@/components/dashboard/backoffice/BackofficeCapabilityProvider";
import {
  DashboardContent,
  PageHeader,
} from "@/components/dashboard/PageScaffold";
import { KeyValueList, Section } from "@/components/dashboard/Section";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { bookingHref } from "@/lib/backoffice/booking-href";
import {
  traceHref,
  type EntityTrace,
  type TraceCandidates,
  type TraceKind,
  type TraceRow,
  type TraceSource,
  type TraceSourceReport,
} from "@/lib/backoffice/entity-trace-types";
import { OperatorTime } from "@/lib/time/operator-time";
import { humanizeEnum } from "@/lib/ui/tone";
import { formatCurrencyAmount } from "@/utils/formatting";

export type EntityTraceViewProps =
  | { mode: "lookup"; invalid: boolean }
  | { mode: "missing"; kind: TraceKind; id: string }
  | { mode: "user"; candidates: TraceCandidates }
  | { mode: "trace"; trace: EntityTrace; seesSystemEvents: boolean };

const SOURCE_LABEL: Record<TraceSource, string> = {
  payment: "Payment",
  leg: "Payment leg",
  ledger: "Ledger",
  earnings: "Earnings",
  hold: "Earnings hold",
  payout: "Payout",
  invoice: "Invoice",
  refund: "Refund",
  creditNote: "Credit note",
  dispute: "Dispute",
  booking: "Booking",
  support: "Support",
  opsAction: "Console action",
  systemEvent: "System event",
};

const KIND_LABEL: Record<TraceKind, string> = {
  payment: "Payment",
  appointment: "Booking",
  user: "User",
};

const when = (iso: string) => <OperatorTime value={iso} />;

function Empty({ children }: Readonly<{ children: ReactNode }>) {
  return <p className="py-6 text-sm text-muted-foreground">{children}</p>;
}

function ExternalLink({
  href,
  children,
}: Readonly<{ href: string; children: ReactNode }>) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="underline-offset-4 hover:underline"
    >
      {children}
    </a>
  );
}

/** A GET form, so a trace is a shareable URL and needs no client state. */
function LookupForm({
  basePath,
  invalid,
}: Readonly<{ basePath: string; invalid: boolean }>) {
  return (
    <Section title="Look up" variant="card">
      <form
        action={`${basePath}/trace`}
        method="get"
        className="flex flex-wrap items-end gap-2"
      >
        <div className="flex flex-col gap-1">
          <label htmlFor="trace-kind" className="text-xs text-muted-foreground">
            Kind
          </label>
          <select
            id="trace-kind"
            name="kind"
            defaultValue="payment"
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="payment">Payment id</option>
            <option value="appointment">Booking id</option>
            <option value="user">User id</option>
          </select>
        </div>
        <div className="flex min-w-72 flex-1 flex-col gap-1">
          <label htmlFor="trace-id" className="text-xs text-muted-foreground">
            Id
          </label>
          <Input
            id="trace-id"
            name="id"
            required
            autoComplete="off"
            aria-invalid={invalid}
            aria-describedby={invalid ? "trace-id-hint" : undefined}
            placeholder="Paste a payment, booking or user id"
          />
        </div>
        <Button type="submit">Trace</Button>
      </form>
      {invalid && (
        <p id="trace-id-hint" className="mt-2 text-sm text-destructive">
          That is not a valid id. Ids are letters, digits, dashes and
          underscores.
        </p>
      )}
    </Section>
  );
}

function UserPicker({
  basePath,
  candidates,
}: Readonly<{ basePath: string; candidates: TraceCandidates }>) {
  type Pay = TraceCandidates["payments"][number];
  type Appt = TraceCandidates["appointments"][number];
  const paymentColumns: ResponsiveColumn<Pay>[] = [
    {
      key: "amount",
      header: "Amount",
      primary: true,
      cell: (p) => formatCurrencyAmount(p.amountPaise, p.currency),
    },
    { key: "status", header: "Status", cell: (p) => humanizeEnum(p.status) },
    { key: "when", header: "Created", cell: (p) => when(p.createdAt) },
  ];
  const bookingColumns: ResponsiveColumn<Appt>[] = [
    {
      key: "type",
      header: "Booking",
      primary: true,
      cell: (a) => humanizeEnum(a.type),
    },
    { key: "role", header: "As", cell: (a) => humanizeEnum(a.role) },
    { key: "when", header: "Created", cell: (a) => when(a.createdAt) },
  ];
  return (
    <>
      <Section
        title={`Payments of ${candidates.name}`}
        description="The most recent payments. Pick one to trace."
      >
        <ResponsiveTable
          columns={paymentColumns}
          rows={candidates.payments}
          getRowId={(p) => p.id}
          getRowHref={(p) => traceHref(basePath, "payment", p.id)}
          empty={<Empty>No payments.</Empty>}
        />
      </Section>
      <Section
        title={`Bookings of ${candidates.name}`}
        description="The most recent seats. Pick one to trace."
      >
        <ResponsiveTable
          columns={bookingColumns}
          rows={candidates.appointments}
          getRowId={(a) => a.id}
          getRowHref={(a) => traceHref(basePath, "appointment", a.id)}
          empty={<Empty>No bookings.</Empty>}
        />
      </Section>
    </>
  );
}

function SourcesTable({
  sources,
  seesSystemEvents,
}: Readonly<{ sources: TraceSourceReport[]; seesSystemEvents: boolean }>) {
  const columns: ResponsiveColumn<TraceSourceReport>[] = [
    {
      key: "source",
      header: "Source",
      primary: true,
      cell: (s) => SOURCE_LABEL[s.source],
    },
    { key: "rows", header: "Rows", cell: (s) => String(s.rows) },
    {
      key: "state",
      header: "State",
      cell: (s) => {
        if (s.failed)
          return <StatusBadge label="Read failed" tone="critical" />;
        if (s.truncated)
          return (
            <StatusBadge label="Capped; older rows hidden" tone="caution" />
          );
        if (s.source === "systemEvent" && !seesSystemEvents)
          return <StatusBadge label="Admin only" tone="neutral" />;
        return <StatusBadge label="Complete" tone="success" />;
      },
    },
  ];
  return (
    <Section
      title="Sources"
      description="Each source is one bounded read. Gateway webhooks are not traced: their rows are keyed by the gateway's event id and hold the payment only inside an unindexed payload. Job runs are not linked: no traced row records which job wrote it, and up to ten jobs share a tick."
    >
      <ResponsiveTable
        columns={columns}
        rows={sources}
        getRowId={(s) => s.source}
      />
    </Section>
  );
}

function TraceTimeline({
  basePath,
  trace,
  seesSystemEvents,
}: Readonly<{
  basePath: string;
  trace: EntityTrace;
  seesSystemEvents: boolean;
}>) {
  const columns: ResponsiveColumn<TraceRow>[] = [
    {
      key: "when",
      header: "When",
      primary: true,
      cell: (r) => <span className="whitespace-nowrap">{when(r.at)}</span>,
    },
    { key: "source", header: "Source", cell: (r) => SOURCE_LABEL[r.source] },
    { key: "status", header: "What happened", cell: (r) => r.status },
    {
      key: "amount",
      header: "Amount",
      cell: (r) =>
        r.amountPaise === null
          ? "—"
          : formatCurrencyAmount(r.amountPaise, r.currency ?? "INR"),
    },
    { key: "actor", header: "Actor", cell: (r) => r.actor ?? "System" },
    {
      key: "detail",
      header: "Detail",
      cell: (r) => (
        <span className="break-words text-xs text-muted-foreground">
          {r.detail ?? ""}
        </span>
      ),
    },
    {
      key: "links",
      header: "Links",
      cell: (r) => (
        <span className="flex flex-wrap gap-2 text-xs">
          {r.sentryHref && (
            <ExternalLink href={r.sentryHref}>Sentry</ExternalLink>
          )}
          {r.source === "opsAction" && (
            <Link
              href={`${basePath}/money/audit?targetId=${encodeURIComponent(r.entityId)}`}
              className="underline-offset-4 hover:underline"
            >
              Audit
            </Link>
          )}
        </span>
      ),
    },
  ];
  return (
    <>
      <Section title="Summary" variant="card">
        <KeyValueList
          items={[
            {
              label: KIND_LABEL[trace.kind],
              value: <span className="font-mono text-xs">{trace.id}</span>,
            },
            {
              label: "Payments",
              value:
                trace.paymentIds.length === 0 ? (
                  "None"
                ) : (
                  <span className="flex flex-col gap-1">
                    {trace.paymentIds.map((id) => (
                      <Link
                        key={id}
                        href={`${basePath}/payments/${id}`}
                        className="font-mono text-xs underline-offset-4 hover:underline"
                      >
                        {id}
                      </Link>
                    ))}
                  </span>
                ),
            },
            {
              label: "Booking",
              value: trace.appointmentId ? (
                <Link
                  href={bookingHref(basePath, trace.appointmentId)}
                  className="font-mono text-xs underline-offset-4 hover:underline"
                >
                  {trace.appointmentId}
                </Link>
              ) : (
                "None"
              ),
            },
            {
              label: "Customer",
              value: trace.userId ? (
                <Link
                  href={`${basePath}/users/${trace.userId}`}
                  className="underline-offset-4 hover:underline"
                >
                  Open User 360
                </Link>
              ) : (
                "Unknown"
              ),
            },
            {
              label: "Errors",
              value: trace.sentryHref ? (
                <ExternalLink href={trace.sentryHref}>
                  Search Sentry for this id
                </ExternalLink>
              ) : (
                "—"
              ),
            },
          ]}
        />
      </Section>
      <Section
        title="Timeline"
        description="Every recorded event, oldest first. A row without an actor was written by a webhook, a sweep or a job."
      >
        <ResponsiveTable
          columns={columns}
          rows={trace.rows}
          getRowId={(r) => r.key}
          empty={<Empty>Nothing is recorded for this id.</Empty>}
        />
      </Section>
      <SourcesTable
        sources={trace.sources}
        seesSystemEvents={seesSystemEvents}
      />
    </>
  );
}

/** The read-only entity trace: one payment's or booking's life as a timeline. */
export function EntityTraceView(props: Readonly<EntityTraceViewProps>) {
  const { basePath } = useBackofficeCapability();
  let body: ReactNode = null;
  if (props.mode === "missing") {
    body = (
      <Empty>
        No {KIND_LABEL[props.kind].toLowerCase()} has the id {props.id}.
      </Empty>
    );
  } else if (props.mode === "user") {
    body = <UserPicker basePath={basePath} candidates={props.candidates} />;
  } else if (props.mode === "trace") {
    body = (
      <TraceTimeline
        basePath={basePath}
        trace={props.trace}
        seesSystemEvents={props.seesSystemEvents}
      />
    );
  }
  return (
    <>
      <PageHeader
        title="Trace"
        description="What happened to one payment or booking, from every table that recorded it."
      />
      <DashboardContent>
        <LookupForm
          basePath={basePath}
          invalid={props.mode === "lookup" && props.invalid}
        />
        {body}
      </DashboardContent>
    </>
  );
}
