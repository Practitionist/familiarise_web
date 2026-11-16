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
import { PersonCell } from "@/components/dashboard/backoffice/PersonCell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  | { mode: "lookup"; invalid: boolean; kind?: TraceKind; id?: string }
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

/** What the lookup form shows: the kind and id the page is tracing now. */
export function lookupDefaults(props: EntityTraceViewProps): {
  kind: TraceKind;
  id: string;
} {
  switch (props.mode) {
    case "trace":
      return { kind: props.trace.kind, id: props.trace.id };
    case "user":
      return { kind: "user", id: props.candidates.userId };
    case "missing":
      return { kind: props.kind, id: props.id };
    case "lookup":
      return { kind: props.kind ?? "payment", id: props.id ?? "" };
  }
}

const KIND_OPTIONS: { value: TraceKind; label: string }[] = [
  { value: "payment", label: "Payment id" },
  { value: "appointment", label: "Booking id" },
  { value: "user", label: "User id" },
];

/** A GET form, so a trace is a shareable URL and needs no client state. */
function LookupForm({
  basePath,
  invalid,
  kind,
  id,
}: Readonly<{
  basePath: string;
  invalid: boolean;
  kind: TraceKind;
  id: string;
}>) {
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
          <Select name="kind" defaultValue={kind}>
            <SelectTrigger id="trace-kind" className="h-9 w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {KIND_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex min-w-72 flex-1 flex-col gap-1">
          <label htmlFor="trace-id" className="text-xs text-muted-foreground">
            Id
          </label>
          <Input
            id="trace-id"
            name="id"
            defaultValue={id}
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
  // Four stacked columns, and a Detail that wraps long ids, so the table fits its card.
  const columns: ResponsiveColumn<TraceRow>[] = [
    {
      key: "when",
      header: "When",
      primary: true,
      className: "w-44 align-top",
      cell: (r) => <span className="text-xs sm:text-sm">{when(r.at)}</span>,
    },
    {
      key: "status",
      header: "What happened",
      className: "align-top",
      cell: (r) => (
        <div className="min-w-0">
          <p className="text-sm text-foreground">{r.status}</p>
          <p className="text-xs text-muted-foreground">
            {SOURCE_LABEL[r.source]} · {r.actor ?? "System"}
          </p>
        </div>
      ),
    },
    {
      key: "amount",
      header: "Amount",
      className: "whitespace-nowrap align-top",
      cell: (r) =>
        r.amountPaise === null
          ? "—"
          : formatCurrencyAmount(r.amountPaise, r.currency ?? "INR"),
    },
    {
      key: "detail",
      header: "Detail",
      className: "max-w-md align-top",
      cell: (r) => (
        <div className="min-w-0 space-y-1 text-xs text-muted-foreground">
          {r.detail && <p className="[overflow-wrap:anywhere]">{r.detail}</p>}
          <span className="flex flex-wrap gap-2">
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
        </div>
      ),
    },
  ];
  const bookingLink = (id: string) => (
    <Link
      href={bookingHref(basePath, id)}
      className="font-mono text-xs underline-offset-4 hover:underline"
    >
      {id}
    </Link>
  );
  return (
    <>
      <Section title="Summary" variant="card">
        <KeyValueList
          items={[
            {
              label: KIND_LABEL[trace.kind],
              value:
                trace.kind === "appointment" ? (
                  bookingLink(trace.id)
                ) : (
                  <span className="font-mono text-xs">{trace.id}</span>
                ),
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
            // A booking trace names its booking in the first row.
            ...(trace.kind === "appointment"
              ? []
              : [
                  {
                    label: "Booking",
                    value: trace.appointmentId
                      ? bookingLink(trace.appointmentId)
                      : "None",
                  },
                ]),
            {
              label: "Customer",
              value: trace.customer ? (
                <Link
                  href={`${basePath}/users/${trace.customer.id}`}
                  className="block underline-offset-4 hover:underline"
                >
                  <PersonCell person={trace.customer} />
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
  const defaults = lookupDefaults(props);
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
          // A new trace remounts the form, so its defaults follow the URL.
          key={`${defaults.kind}:${defaults.id}`}
          basePath={basePath}
          invalid={props.mode === "lookup" && props.invalid}
          {...defaults}
        />
        {body}
      </DashboardContent>
    </>
  );
}
