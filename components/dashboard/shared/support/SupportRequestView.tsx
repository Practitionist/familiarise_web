"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, CreditCard, Send } from "lucide-react";
import { z } from "zod";

import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { ErrorState } from "@/components/dashboard/ErrorState";
import { PageHeader } from "@/components/dashboard/PageScaffold";
import { useSetBreadcrumbLabel } from "@/components/dashboard/breadcrumb-override";
import { Section } from "@/components/dashboard/Section";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { CaseCsat } from "@/components/support/CaseCsat";
import { CaseAttachments } from "@/components/support/CaseAttachments";
import { OwnTicketCaseSchema } from "@/components/support/own-case-schema";
import { CustomerCaseResolution } from "@/components/support/resolution/CustomerCaseResolution";
import { useCaseTimeline } from "@/components/support/useCaseTimeline";
import { SupportBubble } from "@/components/support/SupportBubble";
import {
  describeWait,
  fetchSupportThread,
  useSupportThread,
} from "@/components/support/useSupportThread";
import { useThreadScroll } from "@/components/support/useThreadScroll";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { paymentStatusBadge } from "@/lib/labels/session-labels";
import { parseCaseKey } from "@/lib/support/case-key";
import {
  CASE_TOPIC_LABEL,
  threadTopic,
  type CaseTopic,
  caseBookingLink,
} from "@/lib/support/case-topic";
import { throwSupportError } from "@/lib/support/error-copy";
import {
  REQUEST_STEPS,
  requestStage,
  type RequestStage,
} from "@/lib/support/request-stage";
import { invalidateSupportCase, supportKeys } from "@/lib/support/support-keys";
import { useZoneClock } from "@/lib/time/use-zone-clock";
import { humanizeEnum } from "@/lib/ui/tone";
import type { ArticleLink } from "@/types/support-case";
import { formatCurrencyAmount } from "@/utils/formatting";
import { cn } from "@/utils/tailwind";

import {
  CASE_RESOLUTION_ANCHOR,
  REOPEN_MESSAGE,
  ResolvedFollowUp,
} from "./ResolvedFollowUp";
import { SessionConversation } from "./SessionConversation";

export interface SupportRequestViewProps {
  /** `c_<caseId>` or `b_<appointmentId>` (lib/support/case-key.ts). */
  caseKey: string;
  /** The Support cases list, for the back link. */
  requestsHref: string;
  /** `<tree>/appointments` when this dashboard has booking pages. */
  appointmentsBase?: string;
  /** `<tree>/payments` when this dashboard has payment pages. */
  paymentsBase?: string;
  /** A thread category to start the flow on ("Problem with this charge"). */
  intent?: string;
  /** The session a retrospective report is about (`?occurrence=`). */
  occurrence?: string;
  articles: Record<CaseTopic, ArticleLink[]>;
}

/** A date in the viewer's zone (the page's DisplayZoneProvider), or null. */
function useDay() {
  const clock = useZoneClock();
  return (iso: string | null | undefined) => (iso ? clock.date(iso) : null);
}

function StatusTimeline({ stage }: Readonly<{ stage: RequestStage }>) {
  const steps = [...REQUEST_STEPS.slice(0, 2), stage.settledLabel];
  return (
    <ol
      className="flex items-center gap-2 text-xs"
      aria-label="Support case status"
    >
      {steps.map((label, i) => {
        const reached = i <= stage.step;
        return (
          <li key={label} className="flex items-center gap-2">
            {i > 0 && (
              <span
                className={cn(
                  "h-px w-6 sm:w-10",
                  reached ? "bg-foreground" : "bg-border",
                )}
                aria-hidden
              />
            )}
            <span
              aria-current={i === stage.step ? "step" : undefined}
              className={cn(
                "rounded-full border px-2.5 py-0.5",
                reached
                  ? "border-foreground/40 text-foreground"
                  : "border-border text-muted-foreground",
                i === stage.step &&
                  "border-foreground bg-foreground text-background",
              )}
            >
              {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function Articles({ links }: Readonly<{ links: ArticleLink[] }>) {
  return (
    <Section title="Suggested articles" variant="card">
      <ul className="space-y-2 text-sm">
        {links.slice(0, 3).map((a) => (
          <li key={a.href}>
            <Link
              href={a.href}
              className="text-foreground underline-offset-4 hover:underline"
            >
              {a.title}
            </Link>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function ContextCard({
  icon: Icon,
  title,
  detail,
  href,
  hrefLabel,
  badge,
}: Readonly<{
  icon: typeof CalendarDays;
  title: string;
  detail?: string | null;
  href?: string;
  hrefLabel: string;
  badge?: React.ReactNode;
}>) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">
            {title}
          </p>
          {detail && <p className="text-xs text-muted-foreground">{detail}</p>}
        </div>
        {badge}
      </div>
      {href && (
        <Button variant="outline" size="sm" asChild>
          <Link href={href}>{hrefLabel}</Link>
        </Button>
      )}
    </div>
  );
}

/** A session conversation, keyed by its booking (`b_<appointmentId>`). */
function SessionRequest({
  appointmentId,
  props,
}: Readonly<{ appointmentId: string; props: SupportRequestViewProps }>) {
  const t = useSupportThread(appointmentId, {
    seedCategory: props.intent,
    occurrenceId: props.occurrence,
  });
  const day = useDay();
  const booking = t.data?.booking ?? null;
  const category = t.thread?.category ?? props.intent;
  const topic: CaseTopic = category ? threadTopic(category) : "session";
  const title = `Help with ${booking?.title ?? "your session"}`;
  useSetBreadcrumbLabel(title);
  return (
    <>
      <PageHeader
        title={title}
        description={[
          CASE_TOPIC_LABEL[topic],
          t.thread?.supportTicket?.referenceNumber,
        ]
          .filter(Boolean)
          .join(" · ")}
        back={{ href: props.requestsHref, label: "Support cases" }}
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="min-w-0 space-y-4">
          <StatusTimeline
            stage={requestStage({
              status: t.thread?.status ?? null,
              selfServe: !t.isHuman,
            })}
          />
          {t.query.isError && !t.data ? (
            <ErrorState
              title="This conversation could not be loaded"
              onRetry={() => void t.query.refetch()}
            />
          ) : (
            <SessionConversation t={t} requestsHref={props.requestsHref} />
          )}
        </div>
        <aside className="order-first space-y-4 lg:order-last">
          <h2 className="text-sm font-semibold">Support case context</h2>
          {booking && (
            <ContextCard
              icon={CalendarDays}
              title={booking.title ?? "Session"}
              detail={[humanizeEnum(booking.kind), day(booking.startsAt)]
                .filter(Boolean)
                .join(" · ")}
              href={
                props.appointmentsBase
                  ? `${props.appointmentsBase}/${appointmentId}`
                  : undefined
              }
              hrefLabel="Go to booking"
            />
          )}
          <details className="rounded-lg border border-border p-4">
            <summary className="cursor-pointer text-sm font-medium">
              Helpful articles
            </summary>
            <div className="mt-3">
              <Articles links={props.articles[topic] ?? []} />
            </div>
          </details>
        </aside>
      </div>
    </>
  );
}

function ticketLiveAnnouncement(sending: boolean, offline: boolean): string {
  if (sending) return "Sending reply…";
  if (offline) return "You are offline. Your draft message is preserved.";
  return "";
}

function TicketComposer({
  caseId,
  closed,
  resolved,
  resolvedAt,
  canReopen = true,
  requestsHref,
  draft,
  sending,
  onDraftChange,
  onSubmit,
}: Readonly<{
  caseId: string;
  closed: boolean;
  resolved: boolean;
  resolvedAt: string | null | undefined;
  canReopen?: boolean;
  requestsHref: string;
  draft: string;
  sending: boolean;
  onDraftChange: (value: string) => void;
  onSubmit: (message: string, reopen?: boolean) => void;
}>) {
  const field = useRef<HTMLTextAreaElement>(null);
  if (closed) {
    return (
      <p className="text-sm text-muted-foreground">
        This support case is closed.{" "}
        <Link
          href={requestsHref}
          className="font-medium text-foreground underline underline-offset-4"
        >
          Start a new support case
        </Link>{" "}
        if you still need help.
      </p>
    );
  }
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        const msg = draft.trim();
        if (msg && !sending) onSubmit(msg);
        field.current?.focus();
      }}
    >
      {resolved && canReopen && (
        <ResolvedFollowUp
          caseId={caseId}
          resolvedAt={resolvedAt}
          disabled={sending}
          onReopen={() => onSubmit(draft.trim() || REOPEN_MESSAGE, true)}
        />
      )}
      <Textarea
        ref={field}
        aria-label="Reply"
        aria-describedby={
          resolved && canReopen ? "support-reply-follow-up" : undefined
        }
        rows={3}
        value={draft}
        onChange={(e) => onDraftChange(e.target.value)}
        placeholder={
          resolved ? "Add a follow-up…" : "Write a reply to our team…"
        }
      />
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={sending || !draft.trim()}>
          <Send className="mr-1.5 h-3.5 w-3.5" aria-hidden />
          Send
        </Button>
      </div>
    </form>
  );
}

/** A platform request (`c_<caseId>`); private notes never reach this read. */
function TicketRequest({
  ticketId,
  props,
}: Readonly<{ ticketId: string; props: SupportRequestViewProps }>) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const clock = useZoneClock();
  const day = useDay();
  const [draft, setDraft] = useState("");
  const [offline, setOffline] = useState(false);
  const pendingTurns = useRef(new Map<string, string>());

  useEffect(() => {
    setDraft("");
  }, [ticketId]);

  useEffect(() => {
    setOffline(!navigator.onLine);
    const goOffline = () => setOffline(true);
    const goOnline = () => setOffline(false);
    window.addEventListener("offline", goOffline);
    window.addEventListener("online", goOnline);
    return () => {
      window.removeEventListener("offline", goOffline);
      window.removeEventListener("online", goOnline);
    };
  }, []);

  const query = useQuery({
    queryKey: supportKeys.ownCase(ticketId),
    queryFn: async () => {
      const res = await fetch(`/api/support/requests/c_${ticketId}`);
      if (!res.ok) await throwSupportError(res, "request load");
      return z.object({ data: OwnTicketCaseSchema }).parse(await res.json())
        .data;
    },
    refetchIntervalInBackground: false,
    refetchInterval: (q) =>
      q.state.data?.status === "CLOSED" ? false : 30_000,
  });
  const reply = useMutation({
    mutationFn: async ({
      message,
      reopen,
    }: {
      message: string;
      reopen?: boolean;
    }) => {
      const turnKey = `${reopen ? "reopen" : "reply"}:${message}`;
      const clientTurnId =
        pendingTurns.current.get(turnKey) ?? crypto.randomUUID();
      pendingTurns.current.set(turnKey, clientTurnId);
      const res = await fetch(`/api/support/cases/${ticketId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body: message,
          clientTurnId,
          ...(reopen ? { reopen: true } : {}),
        }),
      });
      if (!res.ok) await throwSupportError(res, "request reply");
      pendingTurns.current.delete(turnKey);
    },
    onSuccess: (_result, { message }) => {
      setDraft((current) => (current.trim() === message ? "" : current));
      void invalidateSupportCase(qc, ticketId);
    },
    onError: (e: unknown) =>
      toast({
        title: "Your message wasn't sent",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      }),
  });

  const data = query.data;
  const history = useCaseTimeline(
    ticketId,
    data?.timeline ?? [],
    data?.nextBeforeSeq,
    data?.hasMore,
  );
  const scroll = useThreadScroll<HTMLDivElement>(
    ticketId,
    history.timeline.length,
  );
  const appointmentId = data?.appointmentId ?? null;
  const bookingLink =
    appointmentId && data
      ? caseBookingLink(data.topic, props.appointmentsBase ?? "", appointmentId)
      : null;
  const booking = useQuery({
    queryKey: supportKeys.thread(appointmentId ?? ""),
    queryFn: () => fetchSupportThread(appointmentId ?? ""),
    enabled:
      appointmentId !== null &&
      bookingLink?.readsBooking === true &&
      data?.canReply === true &&
      data?.viewerIsPresenter !== true,
    select: (thread) => thread.booking,
  });
  useSetBreadcrumbLabel(data?.subject);
  if (query.isError && !data) {
    return (
      <ErrorState
        title="This support case could not be loaded"
        onRetry={() => void query.refetch()}
        variant="page"
      />
    );
  }
  if (!data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-80 w-full" />
      </div>
    );
  }
  const closed = data.status === "CLOSED";
  const resolved = data.status === "RESOLVED";
  // The reply-by line speaks only while the first reply is still owed.
  const replyOwed = !closed && !resolved && !data.acknowledgedAt;
  const paymentHref =
    data.payment && props.paymentsBase
      ? `${props.paymentsBase}/${data.payment.id}`
      : undefined;

  return (
    <>
      <PageHeader
        title={data.subject || "Support case"}
        description={[
          CASE_TOPIC_LABEL[data.topic],
          data.reference,
          data.organization?.name,
        ]
          .filter(Boolean)
          .join(" · ")}
        back={{ href: props.requestsHref, label: "Support cases" }}
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="min-w-0 space-y-4">
          <StatusTimeline stage={requestStage({ status: data.status })} />
          {data.canReply && !data.viewerIsPresenter && (
            <div id={CASE_RESOLUTION_ANCHOR}>
              <CustomerCaseResolution caseId={data.caseId} />
            </div>
          )}
          <div className="flex flex-col rounded-lg border border-border bg-card">
            <div
              ref={scroll.container}
              onScroll={scroll.onScroll}
              className="max-h-[60vh] min-h-[16rem] space-y-3 overflow-y-auto p-4"
            >
              {history.hasMore && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={history.loading}
                  onClick={() =>
                    void scroll.loadOlderAnchored(history.loadOlder)
                  }
                >
                  Load older messages
                </Button>
              )}
              {data.filedByOrganizationNotice && (
                <p className="text-sm text-muted-foreground">
                  Your organization filed this support case. The conversation is
                  managed by its authorized team.
                </p>
              )}
              <div role="log" aria-label="Conversation" className="space-y-3">
                {history.timeline.map((m) => (
                  <SupportBubble
                    key={m.id}
                    perspective="user"
                    author={m.author}
                    authorName={m.author === "USER" ? null : m.authorName}
                    body={m.body}
                    actorKind={m.actorKind}
                    at={m.at}
                  />
                ))}
              </div>
              {replyOwed && (
                <p className="text-center text-[11px] text-muted-foreground">
                  {describeWait(data.ackDueAt, clock.zone)}
                </p>
              )}
              {data.canReply && !data.viewerIsPresenter && (
                <CaseCsat
                  key={data.caseId}
                  caseId={data.caseId}
                  status={data.status}
                  resolvedAt={data.resolvedAt}
                  rating={data.csatRating}
                />
              )}
              <div aria-live="polite" className="sr-only">
                {ticketLiveAnnouncement(reply.isPending, offline)}
              </div>
              {offline && (
                <div
                  role="alert"
                  className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-foreground"
                >
                  You appear to be offline — your message draft is safe here. If
                  your connection stays down, reach us anytime at{" "}
                  <Link
                    href="/contactus"
                    className="font-medium underline underline-offset-4"
                  >
                    /contactus
                  </Link>
                  .
                </div>
              )}
            </div>
            {!data.filedByOrganizationNotice && !data.viewerIsPresenter && (
              <CaseAttachments
                caseId={data.caseId}
                canUpload={data.canReply && !closed}
              />
            )}
            <div className="border-t border-border p-4">
              {data.canReply && (
                <TicketComposer
                  caseId={data.caseId}
                  closed={closed}
                  resolved={resolved}
                  resolvedAt={data.resolvedAt}
                  canReopen={!data.viewerIsPresenter}
                  requestsHref={props.requestsHref}
                  draft={draft}
                  sending={reply.isPending}
                  onDraftChange={setDraft}
                  onSubmit={(message, reopen) =>
                    reply.mutate({ message, reopen })
                  }
                />
              )}
            </div>
          </div>
        </div>
        <aside className="order-first space-y-4 lg:order-last">
          <h2 className="text-sm font-semibold">Support case details</h2>
          <div className="space-y-2 rounded-lg border border-border p-4 text-sm">
            <p className="text-xs text-muted-foreground">{data.reference}</p>
            <StatusBadge
              label={humanizeEnum(data.status)}
              tone="neutral"
              size="sm"
            />
            {replyOwed && (
              <p className="text-muted-foreground">
                {describeWait(data.ackDueAt, clock.zone)}
              </p>
            )}
            {data.organization && <p>{data.organization.name}</p>}
          </div>
          {appointmentId && (
            <ContextCard
              icon={CalendarDays}
              title={booking.data?.title ?? "Appointment"}
              detail={
                booking.data
                  ? [
                      humanizeEnum(booking.data.kind),
                      day(booking.data.startsAt),
                    ]
                      .filter(Boolean)
                      .join(" · ")
                  : null
              }
              href={
                props.appointmentsBase && bookingLink
                  ? bookingLink.href
                  : undefined
              }
              hrefLabel={
                bookingLink?.readsBooking === false
                  ? "Go to your cancelled bookings"
                  : "Go to booking"
              }
            />
          )}
          {data.payment && (
            <ContextCard
              icon={CreditCard}
              title={formatCurrencyAmount(
                data.payment.amount,
                data.payment.currency,
              )}
              detail={day(data.payment.createdAt)}
              badge={
                <StatusBadge
                  {...paymentStatusBadge(data.payment.status)}
                  size="sm"
                />
              }
              href={paymentHref}
              hrefLabel="Go to payment"
            />
          )}
          <details className="rounded-lg border border-border p-4">
            <summary className="cursor-pointer text-sm font-medium">
              Helpful articles
            </summary>
            <div className="mt-3">
              <Articles links={props.articles[data.topic] ?? []} />
            </div>
          </details>
        </aside>
      </div>
    </>
  );
}

/**
 * One support request as a full page: status timeline, the booking or payment
 * it is about, the conversation and composer, and Help Center answers.
 */
export function SupportRequestView(props: Readonly<SupportRequestViewProps>) {
  const ref = parseCaseKey(props.caseKey);
  return (
    <DashboardErrorBoundary>
      {ref?.kind === "booking" && (
        <SessionRequest key={ref.id} appointmentId={ref.id} props={props} />
      )}
      {ref?.kind === "case" && (
        <TicketRequest key={ref.id} ticketId={ref.id} props={props} />
      )}
    </DashboardErrorBoundary>
  );
}
