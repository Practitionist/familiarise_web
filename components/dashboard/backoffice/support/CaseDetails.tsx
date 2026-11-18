"use client";

import { StaffCaseResolution } from "@/components/support/resolution/StaffCaseResolution";
import Link from "next/link";
import { ExternalLink, Phone } from "lucide-react";
import type { ReactNode } from "react";

import { useBackofficeCapability } from "@/components/dashboard/backoffice/BackofficeCapabilityProvider";
import { Section } from "@/components/dashboard/Section";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { Badge } from "@/components/ui/badge";
import { caseStatus } from "@/lib/labels/backoffice-labels";
import { paymentStatusBadge } from "@/lib/labels/session-labels";
import { caseBookingStatus } from "@/lib/support/case-booking-status";
import { buildEngineeringEscalationHref } from "@/lib/support/callback-info";
import { OperatorTime } from "@/lib/time/operator-time";
import { humanizeEnum } from "@/lib/ui/tone";
import type { CaseBooking, CaseWorkspace } from "@/types/support-case";
import { formatCurrencyAmount } from "@/utils/formatting";
import { CaseChatPanel } from "./CaseChatPanel";

const day = (iso: string | null) =>
  iso ? <OperatorTime value={iso} kind="date" /> : "—";

const linkClass =
  "text-sm font-medium text-foreground underline-offset-4 hover:underline";

function Facts({ items }: Readonly<{ items: [string, ReactNode][] }>) {
  return (
    <dl className="space-y-2 text-sm">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="break-words text-foreground">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function bookingStatusLabel(booking: CaseBooking): string {
  return caseBookingStatus(booking)?.label ?? "—";
}

function SentryIssuesSection({
  sentryIssues,
}: Readonly<{ sentryIssues: NonNullable<CaseWorkspace["sentryIssues"]> }>) {
  if (!sentryIssues.configured) {
    return (
      <p className="text-sm text-muted-foreground">
        Error triage is not configured.
      </p>
    );
  }
  const issues = sentryIssues.issues ?? [];
  if (issues.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No unresolved errors in the last 14 days.
      </p>
    );
  }
  return (
    <ul className="space-y-2">
      {issues.map((issue) => (
        <li key={issue.shortId} className="text-sm">
          <a
            href={issue.permalink}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 font-medium text-foreground underline-offset-4 hover:underline"
          >
            <span>
              {issue.shortId} · {issue.title}
            </span>
            <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
          </a>
          <p className="text-xs text-muted-foreground">
            {issue.culprit || issue.lastSeen ? (
              <>
                {issue.culprit}
                {issue.culprit && issue.lastSeen ? " · " : null}
                {issue.lastSeen ? day(issue.lastSeen) : null}
              </>
            ) : (
              humanizeEnum(issue.level ?? "error")
            )}
          </p>
        </li>
      ))}
    </ul>
  );
}

export function CaseDetails({ data }: Readonly<{ data: CaseWorkspace }>) {
  const { basePath, can } = useBackofficeCapability();
  const { person, booking, payment, organization } = data;
  const phone = person.phone;
  const callbackRequested = Boolean(person.callbackRequested);
  const telHref = phone ? `tel:${phone.replace(/[^\d+]/g, "")}` : null;
  const escalationHref = buildEngineeringEscalationHref({
    key: data.key,
    reference: data.reference,
  });

  const personItems: [string, ReactNode][] = [
    ["Name", person.name ?? "—"],
    ["Role", humanizeEnum(person.role) || "—"],
  ];
  if (person.email) {
    personItems.push(["Email", person.email]);
  }
  if (phone && telHref) {
    personItems.push([
      callbackRequested ? "Callback" : "Phone",
      <div key="phone-row" className="flex flex-wrap items-center gap-2">
        <a
          href={telHref}
          className="inline-flex items-center gap-1.5 font-medium text-foreground underline-offset-4 hover:underline"
        >
          <Phone className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>{phone}</span>
        </a>
        {callbackRequested && (
          <Badge variant="destructive" className="text-[11px]">
            Callback requested
          </Badge>
        )}
      </div>,
    ]);
  }
  personItems.push(["Joined", day(person.joinedAt)]);

  return (
    <div className="space-y-5">
      <StaffCaseResolution
        caseId={data.caseId}
        paymentId={data.payment?.id}
        basePath={basePath}
      />
      {can("supportChat.read") && <CaseChatPanel caseId={data.caseId} />}
      <Section title="Person">
        <Facts items={personItems} />
      </Section>

      {booking && (
        <Section title="Booking">
          <Facts
            items={[
              ["Session", `${booking.title} · ${humanizeEnum(booking.kind)}`],
              ["Expert", booking.expertName ?? "—"],
              ["Learner", booking.learnerName ?? "—"],
              [
                "Dates",
                booking.lastStartsAt &&
                booking.lastStartsAt !== booking.firstStartsAt ? (
                  <>
                    {day(booking.firstStartsAt)} – {day(booking.lastStartsAt)}
                  </>
                ) : (
                  day(booking.firstStartsAt)
                ),
              ],
              ["Status", bookingStatusLabel(booking)],
            ]}
          />
        </Section>
      )}

      {payment && (
        <Section title="Payment">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium tabular-nums text-foreground">
              {formatCurrencyAmount(payment.amount, payment.currency)}
            </span>
            <StatusBadge {...paymentStatusBadge(payment.status)} size="sm" />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {day(payment.createdAt)}
          </p>
        </Section>
      )}

      {organization && (
        <Section title="Organisation">
          <p className="text-sm text-foreground">{organization.name}</p>
          {can("organizations.manage") && (
            <Link
              href={`${basePath}/organizations/${organization.id}`}
              className={`${linkClass} mt-2 inline-block`}
            >
              Open organisation
            </Link>
          )}
        </Section>
      )}

      <Section title="Past cases">
        {data.pastCases.length === 0 ? (
          <p className="text-sm text-muted-foreground">No earlier cases.</p>
        ) : (
          <ul className="space-y-2">
            {data.pastCases.map((c) => (
              <li key={c.key} className="text-sm">
                <Link
                  href={`${basePath}/support/${c.key}`}
                  className={linkClass}
                >
                  {c.subject}
                </Link>
                <p className="text-xs text-muted-foreground">
                  {caseStatus(c.status).label} · {day(c.at)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {data.sentryIssues && (
        <Section title="Recent errors">
          <SentryIssuesSection sentryIssues={data.sentryIssues} />
        </Section>
      )}

      {data.events && data.events.length > 0 && (
        <Section title="History">
          <details className="text-xs">
            <summary className="cursor-pointer font-medium text-foreground">
              Audit trail ({data.events.length})
            </summary>
            <ul className="mt-2 space-y-2 border-l border-border pl-2.5">
              {data.events.map((ev) => (
                <li key={ev.id} className="space-y-0.5">
                  <p className="font-medium text-foreground">
                    {ev.actorName ?? "System"} · {humanizeEnum(ev.kind)}
                  </p>
                  {(ev.fromValue || ev.toValue) && (
                    <p className="text-muted-foreground">
                      {ev.fromValue ?? "—"} → {ev.toValue ?? "—"}
                    </p>
                  )}
                  {ev.note && (
                    <p className="italic text-foreground">{ev.note}</p>
                  )}
                  <p className="text-[11px] text-muted-foreground">
                    {day(ev.createdAt)}
                  </p>
                </li>
              ))}
            </ul>
          </details>
        </Section>
      )}

      {can("engineering.escalate") && (
        <Section title="Engineering">
          <a
            href={escalationHref}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground underline-offset-4 hover:underline"
          >
            <span>Escalate to Engineering (GitHub Issue)</span>
            <ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden />
          </a>
          <p className="mt-1 text-xs text-muted-foreground">
            Opens a pre-filled bug report with case IDs and zero customer PII.
          </p>
        </Section>
      )}
    </div>
  );
}
