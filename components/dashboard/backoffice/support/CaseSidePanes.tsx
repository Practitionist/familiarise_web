"use client";

import Link from "next/link";
import { ExternalLink, FileText } from "lucide-react";
import type { ReactNode } from "react";

import { useBackofficeCapability } from "@/components/dashboard/backoffice/BackofficeCapabilityProvider";
import { Section } from "@/components/dashboard/Section";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { Button } from "@/components/ui/button";
import { caseStatus } from "@/lib/labels/backoffice-labels";
import { paymentStatusBadge } from "@/lib/labels/session-labels";
import { savedRepliesFor } from "@/lib/support/saved-replies";
import { humanizeEnum } from "@/lib/ui/tone";
import type { ArticleLink, CaseWorkspace } from "@/types/support-case";
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

/** #1527 — the left pane: who is asking, about what, and what came before. */
export function CaseContextPane({ data }: Readonly<{ data: CaseWorkspace }>) {
  const { basePath, can } = useBackofficeCapability();
  const { person, booking, payment, organization } = data;
  return (
    <div className="space-y-4">
      <Section title="Person" variant="card">
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
        {can("users.read") && (
          <Link
            href={`${basePath}/users/${person.id}`}
            className={`${linkClass} mt-3 inline-block`}
          >
            Open User 360
          </Link>
        )}
      </Section>

      {booking && (
        <Section title="Booking" variant="card">
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
              ["Status", humanizeEnum(booking.status) || "—"],
            ]}
          />
          {can("appointments.manage") && (
            <Link
              href={bookingHref(basePath, booking.appointmentId)}
              className={`${linkClass} mt-3 inline-block`}
            >
              Open booking
            </Link>
          )}
        </Section>
      )}

      {payment && (
        <Section title="Payment" variant="card">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium tabular-nums text-foreground">
              {formatCurrencyAmount(payment.amount, payment.currency)}
            </span>
            <StatusBadge {...paymentStatusBadge(payment.status)} size="sm" />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {day(payment.createdAt)}
          </p>
          <Link
            href={`${basePath}/payments/${payment.id}`}
            className={`${linkClass} mt-3 inline-block`}
          >
            Open payment
          </Link>
        </Section>
      )}

      {organization && (
        <Section title="Organisation" variant="card">
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

      <Section title="Past cases" variant="card">
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
        <Section title="Attachments" variant="card">
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

/**
 * #1527 — the right pane: Help Center answers and saved replies to insert,
 * and quick actions that only deep-link EXISTING guarded flows. "Issue
 * refund" opens the payment page's own refund dialog (admin only); nothing
 * here moves money.
 */
export function CaseAssistPane({
  data,
  articles,
  onInsert,
}: Readonly<{
  data: CaseWorkspace;
  articles: ArticleLink[];
  onInsert: (text: string) => void;
}>) {
  const { basePath, can } = useBackofficeCapability();
  const actions: { label: string; href: string }[] = [];
  if (data.booking && can("appointments.manage")) {
    actions.push({
      label: "Open booking",
      href: bookingHref(basePath, data.booking.appointmentId),
    });
  }
  if (data.payment) {
    actions.push({
      label: "Open payment",
      href: `${basePath}/payments/${data.payment.id}`,
    });
    if (can("refunds.manage") && data.payment.status === "SUCCEEDED") {
      actions.push({
        label: "Issue refund",
        href: `${basePath}/payments/${data.payment.id}?refund=1`,
      });
    }
  }
  if (can("users.read")) {
    actions.push({
      label: "Open User 360",
      href: `${basePath}/users/${data.person.id}`,
    });
  }
  if (data.organization && can("organizations.manage")) {
    actions.push({
      label: "Open organisation",
      href: `${basePath}/organizations/${data.organization.id}`,
    });
  }

  return (
    <div className="space-y-4">
      <Section title="Quick actions" variant="card">
        <div className="flex flex-wrap gap-2">
          {actions.map((a) => (
            <Button key={a.label} variant="outline" size="sm" asChild>
              <Link href={a.href}>{a.label}</Link>
            </Button>
          ))}
        </div>
      </Section>

      <Section title="Suggested articles" variant="card">
        <ul className="space-y-2">
          {articles.map((a) => (
            <li key={a.href} className="flex items-start justify-between gap-2">
              <a
                href={a.href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-foreground underline-offset-4 hover:underline"
              >
                {a.title}
              </a>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 shrink-0 px-2 text-xs"
                onClick={() =>
                  onInsert(`${a.title}: ${window.location.origin}${a.href}`)
                }
              >
                Insert link
              </Button>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Saved replies" variant="card">
        <ul className="space-y-2">
          {savedRepliesFor(data.topic).map((r) => (
            <li key={r.id} className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">{r.title}</p>
                <p className="line-clamp-2 text-xs text-muted-foreground">
                  {r.body}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 shrink-0 px-2 text-xs"
                onClick={() => onInsert(r.body)}
              >
                Insert
              </Button>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
