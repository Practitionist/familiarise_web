"use client";

import Link from "next/link";
import { ExternalLink, FileText } from "lucide-react";
import type { ReactNode } from "react";

import { useBackofficeCapability } from "@/components/dashboard/backoffice/BackofficeCapabilityProvider";
import { Section } from "@/components/dashboard/Section";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { caseStatus } from "@/lib/labels/backoffice-labels";
import {
  appointmentStatusBadge,
  eventStatusBadge,
  paymentStatusBadge,
  trialStatusBadge,
} from "@/lib/labels/session-labels";
import { humanizeEnum } from "@/lib/ui/tone";
import type { CaseBooking, CaseWorkspace } from "@/types/support-case";
import { formatCurrencyAmount } from "@/utils/formatting";

const day = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : "—";

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

/** Where a booking opens in the console: the Appointments page, opened on it. */
export const bookingHref = (basePath: string, appointmentId: string) =>
  `${basePath}/appointments?open=${encodeURIComponent(appointmentId)}`;

/** #1527 — each booking kind's status lives on a different enum. */
function bookingStatusLabel(booking: CaseBooking): string {
  if (!booking.status) return "—";
  if (booking.kind === "TRIAL") return trialStatusBadge(booking.status).label;
  if (booking.kind === "CLASS" || booking.kind === "WEBINAR") {
    return eventStatusBadge(booking.status).label;
  }
  return appointmentStatusBadge(booking.status).label;
}

/**
 * #1527 — the Details panel's body: who is asking, about what, and what came
 * before. The header carries the Open booking / payment / User 360 links.
 */
export function CaseDetails({ data }: Readonly<{ data: CaseWorkspace }>) {
  const { basePath, can } = useBackofficeCapability();
  const { person, booking, payment, organization } = data;
  return (
    <div className="space-y-5">
      <Section title="Person">
        <Facts
          items={[
            ["Name", person.name ?? "—"],
            ["Role", humanizeEnum(person.role) || "—"],
            ...(person.email
              ? [["Email", person.email] as [string, ReactNode]]
              : []),
            ["Joined", day(person.joinedAt)],
          ]}
        />
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
                booking.lastStartsAt !== booking.firstStartsAt
                  ? `${day(booking.firstStartsAt)} – ${day(booking.lastStartsAt)}`
                  : day(booking.firstStartsAt),
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
                  {
                    caseStatus(
                      c.key.startsWith("t_") ? "ticket" : "thread",
                      c.status,
                    ).label
                  }{" "}
                  · {day(c.at)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {data.attachments.length > 0 && (
        <Section title="Attachments">
          <ul className="space-y-1.5">
            {data.attachments.map((a) => (
              <li key={a.id}>
                <a
                  href={a.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 text-sm text-foreground underline-offset-4 hover:underline"
                >
                  <FileText className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span className="truncate">{a.name}</span>
                  <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
                </a>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}
