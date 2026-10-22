"use client";

/** Session quality aggregates and scoped support activity; member correspondence stays private. */

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Star, MessageSquareText, ShieldAlert } from "lucide-react";
import { z } from "zod";

import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useRequireOrgAccess } from "../useOrgRole";
import { caseKeyOf } from "@/lib/support/case-key";
import { humanizeEnum, type Tone } from "@/lib/ui/tone";
import { supportKeys } from "@/lib/support/support-keys";

const TriageList = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      appointmentId: z.string(),
      category: z.string(),
      status: z.string(),
      activeChannel: z.string(),
      lastMessageAt: z.string(),
      createdAt: z.string(),
      canCorrespond: z.boolean().optional(),
      submitterUserId: z.string().nullish(),
      member: z.object({ id: z.string(), name: z.string().nullable() }),
      appointment: z.object({
        appointmentType: z.string().nullish(),
        startsAt: z.string().nullable(),
        planTitle: z.string().nullable(),
      }),
    }),
  ),
  /** Personal requests in sensitive categories are counted, never listed. */
  withheld: z.object({ sensitivePersonal: z.number() }),
});
type TriageRow = z.infer<typeof TriageList>["data"][number];

export function isOrgOperatorThread(t: {
  category: string;
  submitterUserId?: string | null;
  member: { id: string };
}): boolean {
  return (
    t.category === "ORG_ADMIN_DISPUTE" ||
    t.category === "SPONSORSHIP_BILLING" ||
    (Boolean(t.submitterUserId) && t.submitterUserId !== t.member.id)
  );
}

interface FeedbackSummary {
  averageRating: number | null;
  totalResponses: number | null;
  respondents: number | null;
  averageRating30d: number | null;
  responses30d: number | null;
  respondents30d: number | null;
  minRespondents: number;
  byConsultant: {
    consultantProfileId: string;
    name: string | null;
    average: number | null;
    responses: number | null;
    respondents: number | null;
  }[];
  consultantsSuppressed: number;
}

const STATUS: Record<string, { label: string; tone: Tone }> = {
  OPEN: { label: "Open", tone: "caution" },
  IN_PROGRESS: { label: "In progress", tone: "info" },
  ESCALATED: { label: "With platform team", tone: "caution" },
  RESOLVED: { label: "Resolved", tone: "success" },
  CLOSED: { label: "Closed", tone: "neutral" },
};

const STATUS_FILTERS = [
  "OPEN",
  "IN_PROGRESS",
  "ESCALATED",
  "RESOLVED",
] as const;

function OrgThreadRow({
  thread: t,
  orgId,
}: Readonly<{ thread: TriageRow; orgId: string }>) {
  const raisedByOrg = isOrgOperatorThread(t);
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-foreground">
          {t.appointment.planTitle ?? "Session"}
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            {t.member.name ?? t.member.id} ·{" "}
            {t.appointment.startsAt &&
              new Date(t.appointment.startsAt).toLocaleDateString()}
          </span>
        </p>
        <p className="text-xs text-muted-foreground">
          {humanizeEnum(t.category)} · last activity{" "}
          {new Date(t.lastMessageAt).toLocaleDateString(undefined, {
            day: "numeric",
            month: "short",
          })}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <StatusBadge
          label={raisedByOrg ? "Raised by org" : "Learner session"}
          tone={raisedByOrg ? "info" : "neutral"}
          variant="dot"
        />
        <StatusBadge
          label={STATUS[t.status]?.label ?? humanizeEnum(t.status)}
          tone={STATUS[t.status]?.tone ?? "neutral"}
        />
        <Button variant="outline" size="sm" asChild>
          <Link
            href={`/dashboard/organization/${orgId}/support/requests/${caseKeyOf({ kind: t.canCorrespond ? "case" : "booking", id: t.canCorrespond ? t.id : t.appointmentId })}`}
          >
            <ShieldAlert className="mr-1.5 h-3.5 w-3.5" />
            {t.canCorrespond ? "View request" : "Raise concern"}
          </Link>
        </Button>
      </div>
    </li>
  );
}

export function OrgSupportTriage({ orgId }: { orgId: string }) {
  const { allowed, isLoading: gateLoading } = useRequireOrgAccess(orgId, {
    permission: "operations.read",
  });
  const [status, setStatus] = useState<string>("");

  const summary = useQuery({
    queryKey: ["org-feedback-summary", orgId],
    enabled: allowed,
    queryFn: async (): Promise<FeedbackSummary | null> => {
      const res = await fetch(`/api/organizations/${orgId}/feedback-summary`);
      // The summary is behind `quality.read`, a narrower grant than the
      // `operations.read` this page needs: a 403 is "not your permission", not
      // a failure to retry.
      if (res.status === 403) return null;
      if (!res.ok) throw new Error("Failed to load quality summary");
      const { data } = await res.json();
      return data;
    },
  });

  const threads = useQuery({
    queryKey: supportKeys.orgThreads(orgId, status),
    enabled: allowed,
    queryFn: async () => {
      const params = new URLSearchParams({ pageSize: "30" });
      if (status) params.set("status", status);
      const res = await fetch(
        `/api/organizations/${orgId}/support-threads?${params}`,
      );
      if (!res.ok) throw new Error("Failed to load support triage");
      return TriageList.parse(await res.json());
    },
  });

  if (gateLoading) return <Skeleton className="h-40 w-full" />;
  if (!allowed) return null;

  const s = summary.data;
  // A failed request is not "no data" — show it, with a way out. A 403 (data
  // resolved to null) is a third thing: the card is not for this role.
  const summaryError = summary.isError ? (
    <div className="rounded-lg border border-dashed border-border p-3 text-sm text-muted-foreground sm:col-span-2">
      Couldn&apos;t load the quality summary.{" "}
      <Button
        variant="outline"
        size="sm"
        className="ml-1"
        onClick={() => summary.refetch()}
      >
        Retry
      </Button>
    </div>
  ) : summary.data === null && !summary.isLoading ? (
    <div className="rounded-lg border border-dashed border-border p-3 text-sm text-muted-foreground sm:col-span-2">
      The quality summary needs the quality permission, which your role does not
      hold.
    </div>
  ) : null;
  const threadsError = threads.isError ? (
    <div className="rounded-lg border border-dashed border-border p-3 text-sm text-muted-foreground">
      Couldn&apos;t load member conversations.{" "}
      <Button
        variant="outline"
        size="sm"
        className="ml-1"
        onClick={() => threads.refetch()}
      >
        Retry
      </Button>
    </div>
  ) : null;

  return (
    <div className="space-y-8">
      {/* Quality signal — aggregates only (ADR 20) */}
      <section>
        <h3 className="mb-3 text-sm font-semibold text-foreground">
          Session quality
        </h3>
        <div className="grid gap-3 sm:grid-cols-2">
          {summaryError ? (
            summaryError
          ) : (
            <>
              <div className="rounded-lg border border-border p-4">
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Star className="h-3.5 w-3.5" /> All-time average rating
                </p>
                {summary.isLoading ? (
                  <Skeleton className="mt-2 h-7 w-20" />
                ) : (
                  <p className="mt-1 text-2xl font-semibold text-foreground">
                    {s?.averageRating ?? "—"}
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      {s?.averageRating === null
                        ? `needs ${s?.minRespondents ?? 5} people`
                        : `${s?.totalResponses ?? 0} private ratings`}
                    </span>
                  </p>
                )}
              </div>
              <div className="rounded-lg border border-border p-4">
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Star className="h-3.5 w-3.5" /> Last 30 days
                </p>
                {summary.isLoading ? (
                  <Skeleton className="mt-2 h-7 w-20" />
                ) : (
                  <p className="mt-1 text-2xl font-semibold text-foreground">
                    {s?.averageRating30d ?? "—"}
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      {s?.averageRating30d === null
                        ? `needs ${s?.minRespondents ?? 5} people`
                        : `${s?.responses30d ?? 0} responses`}
                    </span>
                  </p>
                )}
              </div>
            </>
          )}
        </div>
        {/* #1300 — the question an enterprise buyer actually has is per expert,
            not per organisation. Still aggregate, still floored; the endpoint
            has already applied secondary suppression on distinct people. */}
        {!summary.isLoading && (s?.byConsultant?.length ?? 0) > 0 && (
          <div className="mt-4">
            <p className="mb-2 text-xs font-medium text-foreground">
              By expert
            </p>
            <ul className="divide-y divide-border rounded-lg border border-border">
              {s?.byConsultant.map((c) => (
                <li
                  key={c.consultantProfileId}
                  className="flex items-center justify-between gap-3 px-3 py-2"
                >
                  <span className="truncate text-sm text-foreground">
                    {c.name ?? "Expert"}
                  </span>
                  <span className="shrink-0 text-sm text-muted-foreground">
                    {c.average ?? "—"}
                    <span className="ml-1.5 text-xs">
                      {c.respondents === null
                        ? `needs ${s?.minRespondents ?? 5} people`
                        : `· ${c.respondents} people`}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {!summary.isLoading && (s?.consultantsSuppressed ?? 0) > 0 && (
          <p className="mt-2 text-xs text-muted-foreground">
            {s?.consultantsSuppressed} expert
            {(s?.consultantsSuppressed ?? 0) === 1 ? "" : "s"} withheld — too
            few people have rated their sessions for an average to stay
            anonymous.
          </p>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          Ratings are private to the participant and the platform — this card is
          the aggregate, never individual feedback. An average appears once at
          least {s?.minRespondents ?? 5} different people have rated.
        </p>
      </section>

      {/* Members' support conversations — metadata triage */}
      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
            <MessageSquareText className="h-4 w-4" /> Member support activity
          </h3>
          <div className="flex gap-1">
            <Button
              size="sm"
              variant={status === "" ? "default" : "outline"}
              onClick={() => setStatus("")}
            >
              All
            </Button>
            {STATUS_FILTERS.map((f) => (
              <Button
                key={f}
                size="sm"
                variant={status === f ? "default" : "outline"}
                onClick={() => setStatus(f)}
              >
                {STATUS[f].label}
              </Button>
            ))}
          </div>
        </div>
        {threadsError ? (
          threadsError
        ) : threads.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : (threads.data?.data.length ?? 0) === 0 ? (
          <p className="text-sm text-muted-foreground">
            No member conversations match this filter.
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {threads.data!.data.map((t) => (
              <OrgThreadRow key={t.id} thread={t} orgId={orgId} />
            ))}
          </ul>
        )}
        {(threads.data?.withheld.sensitivePersonal ?? 0) > 0 && (
          <p className="mt-2 text-xs text-muted-foreground">
            {threads.data!.withheld.sensitivePersonal} personal{" "}
            {threads.data!.withheld.sensitivePersonal === 1
              ? "request is"
              : "requests are"}{" "}
            not listed because of their sensitive category.
          </p>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          Member requests show status only; their conversations stay private.
          Authorized teammates can open organization-owned requests. &quot;Raise
          concern&quot; starts your organization&apos;s own request about that
          session.
        </p>
      </section>
    </div>
  );
}
