"use client";

/**
 * #support-hub — the Swiggy-style Support & Feedback hub: ONE role-agnostic
 * surface with two subtabs.
 *
 *  • Sessions — your recent sessions (tap → per-appointment flowchart thread)
 *    and every support conversation you've opened, bucketed by status, newest
 *    activity first.
 *  • Platform — flowchart intake for platform issues (stateless; escalates
 *    into a ticket) and your ticket list, same bucketing/sorting.
 *
 * The panels are deliberately scope-free: `/api/user/support-tickets`,
 * `/api/user/support-threads` and `/api/appointments` all key off the session,
 * so consultee, consultant, org operator and staff mount the same component.
 * Feedback and Help remain their own destinations (deep-linked below).
 */

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  LifeBuoy,
  MessageSquareText,
  HelpCircle,
  CalendarDays,
  ChevronRight,
  Bot,
  UserRound,
  Headset,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { SupportThreadSheet } from "@/components/support/SupportThreadSheet";
import { PlatformSupportSheet } from "@/components/support/PlatformSupportSheet";

// ---------------------------------------------------------------------------
// Types + small helpers
// ---------------------------------------------------------------------------

interface ThreadRow {
  id: string;
  appointmentId: string;
  category: string;
  status: string;
  activeChannel: string;
  lastMessageAt: string;
  createdAt: string;
  lastMessage: { sender: string; body: string } | null;
  appointment: {
    appointmentType: string;
    startsAt: string | null;
    planTitle: string | null;
  };
}

interface TicketRow {
  id: string;
  title: string;
  status: string;
  updatedAt: string;
  createdAt: string;
  responses?: { message: string; createdAt: string; isInternal: boolean }[];
}

interface AppointmentRow {
  id: string;
  consultation?: { consultationPlan?: { title?: string } };
  subscription?: { subscriptionPlan?: { title?: string } };
  webinar?: { webinarPlan?: { title?: string } };
  class?: { classPlan?: { title?: string } };
  slotsOfAppointment?: { startsAt: string }[];
}

const STATUS_LABELS: Record<string, string> = {
  OPEN: "Open",
  IN_PROGRESS: "In progress",
  ESCALATED: "With our team",
  ON_HOLD: "With our team",
  RESOLVED: "Resolved",
  CLOSED: "Closed",
};

function statusVariant(status: string): "default" | "secondary" | "outline" | "destructive" {
  if (status === "RESOLVED") return "secondary";
  if (status === "CLOSED") return "outline";
  if (status === "ESCALATED" || status === "ON_HOLD") return "destructive";
  return "default";
}

/** Bucket key for the three user-facing groups. */
function bucketOf(status: string): "open" | "team" | "resolved" {
  if (status === "ESCALATED" || status === "ON_HOLD") return "team";
  if (status === "RESOLVED" || status === "CLOSED") return "resolved";
  return "open";
}

const BUCKETS: { key: "open" | "team" | "resolved"; label: string }[] = [
  { key: "open", label: "Open" },
  { key: "team", label: "With our team" },
  { key: "resolved", label: "Resolved" },
];

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function planTitleOf(a: AppointmentRow): string {
  return (
    a.consultation?.consultationPlan?.title ??
    a.subscription?.subscriptionPlan?.title ??
    a.webinar?.webinarPlan?.title ??
    a.class?.classPlan?.title ??
    "Session"
  );
}

/** Bucket rows by status preserving the server's last-activity order. */
function bucketize<T extends { status: string }>(
  rows: T[],
): Record<"open" | "team" | "resolved", T[]> {
  const out = { open: [], team: [], resolved: [] } as Record<
    "open" | "team" | "resolved",
    T[]
  >;
  for (const r of rows) out[bucketOf(r.status)].push(r);
  return out;
}

// ---------------------------------------------------------------------------
// Subtab: Sessions
// ---------------------------------------------------------------------------

function SessionsTab({ profileId }: { profileId?: string }) {
  const threads = useQuery({
    queryKey: ["user-support-threads"],
    queryFn: async (): Promise<ThreadRow[]> => {
      const res = await fetch("/api/user/support-threads");
      if (!res.ok) throw new Error("Failed to load conversations");
      const { data } = await res.json();
      return data;
    },
  });

  const appointments = useQuery({
    queryKey: ["support-hub-recent-sessions"],
    queryFn: async (): Promise<AppointmentRow[]> => {
      const res = await fetch("/api/appointments?pageSize=5");
      if (!res.ok) throw new Error("Failed to load sessions");
      const json = await res.json();
      return json.data ?? json.appointments ?? [];
    },
  });

  const buckets = useMemo(
    () => bucketize(threads.data ?? []),
    [threads.data],
  );

  return (
    <div className="space-y-8">
      {/* Recent sessions — pick one, get help (the Swiggy order-picker) */}
      <section>
        <h3 className="mb-3 text-sm font-semibold text-foreground">
          Your recent sessions
        </h3>
        {appointments.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : (appointments.data?.length ?? 0) === 0 ? (
          <p className="text-sm text-muted-foreground">
            No sessions yet — help for any booking appears here.
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {appointments.data!.map((a) => (
              <li
                key={a.id}
                className="flex items-center justify-between gap-3 px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">
                    {planTitleOf(a)}
                  </p>
                  <p className="flex items-center gap-1 text-xs text-muted-foreground">
                    <CalendarDays className="h-3 w-3" />
                    {fmtDate(a.slotsOfAppointment?.[0]?.startsAt)}
                  </p>
                </div>
                <SupportThreadSheet appointmentId={a.id} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Existing conversations, bucketed by status */}
      <section>
        <h3 className="mb-3 text-sm font-semibold text-foreground">
          Your support conversations
        </h3>
        {threads.isLoading ? (
          <Skeleton className="h-20 w-full" />
        ) : (threads.data?.length ?? 0) === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing open — when you raise an issue about a session it lives here.
          </p>
        ) : (
          <div className="space-y-6">
            {BUCKETS.map(({ key, label }) =>
              buckets[key].length > 0 ? (
                <div key={key}>
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {label} ({buckets[key].length})
                  </p>
                  <ul className="divide-y divide-border rounded-lg border border-border">
                    {buckets[key].map((t) => (
                      <li key={t.id} className="px-4 py-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-foreground">
                              {t.appointment.planTitle ?? "Session"}
                              <span className="ml-2 text-xs font-normal text-muted-foreground">
                                {fmtDate(t.appointment.startsAt)}
                              </span>
                            </p>
                            {t.lastMessage && (
                              <p className="mt-0.5 flex items-center gap-1 truncate text-xs text-muted-foreground">
                                {t.lastMessage.sender === "USER" ? (
                                  <UserRound className="h-3 w-3 shrink-0" />
                                ) : (
                                  <Bot className="h-3 w-3 shrink-0" />
                                )}
                                {t.lastMessage.body}
                              </p>
                            )}
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <Badge variant={statusVariant(t.status)}>
                              {t.activeChannel === "HUMAN"
                                ? "With our team"
                                : STATUS_LABELS[t.status] ?? t.status}
                            </Badge>
                            <SupportThreadSheet
                              appointmentId={t.appointmentId}
                              trigger={
                                <Button variant="ghost" size="sm">
                                  View
                                  <ChevronRight className="ml-1 h-4 w-4" />
                                </Button>
                              }
                            />
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null,
            )}
          </div>
        )}
        {/* profileId kept for parity with the requests page deep-link */}
        {profileId ? null : null}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subtab: Platform
// ---------------------------------------------------------------------------

function PlatformTab({
  orgId,
  feedbackHref,
  helpHref,
}: {
  orgId?: string;
  feedbackHref?: string;
  helpHref?: string;
}) {
  const tickets = useQuery({
    queryKey: ["user-support-tickets"],
    queryFn: async (): Promise<TicketRow[]> => {
      const res = await fetch("/api/user/support-tickets");
      if (!res.ok) throw new Error("Failed to load requests");
      return res.json();
    },
  });

  /** Last activity = latest visible reply, else the ticket's own clock. */
  const sorted = useMemo(() => {
    const rows = tickets.data ?? [];
    return [...rows].sort((a, b) => {
      const la = Math.max(
        Date.parse(a.updatedAt),
        ...(a.responses ?? []).map((r) => Date.parse(r.createdAt)),
      );
      const lb = Math.max(
        Date.parse(b.updatedAt),
        ...(b.responses ?? []).map((r) => Date.parse(r.createdAt)),
      );
      return lb - la;
    });
  }, [tickets.data]);

  const buckets = useMemo(() => bucketize(sorted), [sorted]);

  return (
    <div className="space-y-8">
      {/* Platform issue intake */}
      <section>
        <h3 className="mb-3 text-sm font-semibold text-foreground">
          Get help with the platform
        </h3>
        <div className="flex flex-col gap-3 rounded-lg border border-border p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium text-foreground">
              Payments, account, sign-in or site trouble
            </p>
            <p className="text-xs text-muted-foreground">
              A few quick questions and we&apos;ll either fix it on the spot or
              route you to the right team with full context.
            </p>
          </div>
          <PlatformSupportSheet orgId={orgId} />
        </div>
        {(feedbackHref || helpHref) && (
          <div className="mt-3 flex flex-wrap gap-2">
            {feedbackHref && (
              <Button variant="ghost" size="sm" asChild>
                <a href={feedbackHref}>
                  <MessageSquareText className="mr-1.5 h-4 w-4" />
                  Share feedback
                </a>
              </Button>
            )}
            {helpHref && (
              <Button variant="ghost" size="sm" asChild>
                <a href={helpHref}>
                  <HelpCircle className="mr-1.5 h-4 w-4" />
                  Browse FAQs
                </a>
              </Button>
            )}
          </div>
        )}
      </section>

      {/* Tickets, bucketed by status, latest activity first */}
      <section>
        <h3 className="mb-3 text-sm font-semibold text-foreground">My requests</h3>
        {tickets.isLoading ? (
          <Skeleton className="h-20 w-full" />
        ) : sorted.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No platform requests yet.
          </p>
        ) : (
          <div className="space-y-6">
            {BUCKETS.map(({ key, label }) =>
              buckets[key].length > 0 ? (
                <div key={key}>
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {label} ({buckets[key].length})
                  </p>
                  <ul className="divide-y divide-border rounded-lg border border-border">
                    {buckets[key].map((t) => {
                      const lastReply = [...(t.responses ?? [])].pop();
                      return (
                        <li key={t.id} className="px-4 py-3">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium text-foreground">
                                {t.title || "Support request"}
                              </p>
                              {lastReply && (
                                <p className="mt-0.5 flex items-center gap-1 truncate text-xs text-muted-foreground">
                                  <Headset className="h-3 w-3 shrink-0" />
                                  {lastReply.message}
                                </p>
                              )}
                            </div>
                            <Badge variant={statusVariant(t.status)}>
                              {STATUS_LABELS[t.status] ?? t.status}
                            </Badge>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ) : null,
            )}
          </div>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hub
// ---------------------------------------------------------------------------

export function SupportHub({
  profileId,
  orgId,
  feedbackHref,
  helpHref,
}: {
  /** Profile id of the mounting dashboard (consultee/consultant) — passed
   *  through for parity with the standalone request pages. */
  profileId?: string;
  /** Active org id in operator trees — attributes platform tickets. */
  orgId?: string;
  feedbackHref?: string;
  helpHref?: string;
}) {
  const [tab, setTab] = useState<"sessions" | "platform">("sessions");

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <div className="mb-6 flex gap-1 rounded-lg bg-muted p-1 sm:w-fit">
        {(
          [
            { key: "sessions", label: "Sessions", icon: CalendarDays },
            { key: "platform", label: "Platform", icon: LifeBuoy },
          ] as const
        ).map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={
              "flex items-center gap-1.5 rounded-md px-4 py-1.5 text-sm font-medium transition-colors " +
              (tab === key
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground")
            }
          >
            <Icon className="h-4 w-4" />
            {label}
          </button>
        ))}
      </div>

      {tab === "sessions" ? (
        <SessionsTab profileId={profileId} />
      ) : (
        <PlatformTab orgId={orgId} feedbackHref={feedbackHref} helpHref={helpHref} />
      )}
    </div>
  );
}
