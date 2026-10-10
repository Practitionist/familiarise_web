"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, CreditCard, Send } from "lucide-react";

import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { ErrorState } from "@/components/dashboard/ErrorState";
import { PageHeader } from "@/components/dashboard/PageScaffold";
import { useSetBreadcrumbLabel } from "@/components/dashboard/breadcrumb-override";
import { Section } from "@/components/dashboard/Section";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { SupportBubble } from "@/components/support/SupportBubble";
import {
  describeWait,
  useSupportThread,
} from "@/components/support/useSupportThread";
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
} from "@/lib/support/case-topic";
import { throwSupportError } from "@/lib/support/error-copy";
import {
  REQUEST_STEPS,
  requestStage,
  type RequestStage,
} from "@/lib/support/request-stage";
import { humanizeEnum } from "@/lib/ui/tone";
import type { ArticleLink, OwnTicketCase } from "@/types/support-case";
import { formatCurrencyAmount } from "@/utils/formatting";
import { cn } from "@/utils/tailwind";

import { SessionConversation } from "./SessionConversation";

export interface SupportRequestViewProps {
  /** `t_<ticketId>` or `b_<appointmentId>` (lib/support/case-key.ts). */
  caseKey: string;
  /** The Support requests list, for the back link. */
  requestsHref: string;
  /** `<tree>/appointments` when this dashboard has booking pages. */
  appointmentsBase?: string;
  /** `<tree>/payments` when this dashboard has payment pages. */
  paymentsBase?: string;
  /** A thread category to start the flow on ("Problem with this charge"). */
  intent?: string;
  articles: Record<CaseTopic, ArticleLink[]>;
}

const day = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : null;

function StatusTimeline({ stage }: Readonly<{ stage: RequestStage }>) {
  const steps = [...REQUEST_STEPS.slice(0, 2), stage.settledLabel];
  return (
    <ol className="flex items-center gap-2 text-xs" aria-label="Request status">
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
  const t = useSupportThread(appointmentId, { seedCategory: props.intent });
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
        back={{ href: props.requestsHref, label: "Support requests" }}
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="min-w-0 space-y-4">
          <StatusTimeline
            stage={requestStage({
              kind: "thread",
              status: t.thread?.status ?? null,
              channel: t.thread?.activeChannel ?? null,
            })}
          />
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
          {t.query.isError && !t.data ? (
            <ErrorState
              title="This conversation could not be loaded"
              onRetry={() => void t.query.refetch()}
            />
          ) : (
            <SessionConversation t={t} requestsHref={props.requestsHref} />
          )}
        </div>
        <aside>
          <Articles links={props.articles[topic] ?? []} />
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

function TicketCsatPrompt({
  effectiveCsat,
  onRate,
}: Readonly<{
  effectiveCsat: number | null;
  onRate: (star: number) => void;
}>) {
  return (
    <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs">
      <p className="font-medium text-foreground">
        {effectiveCsat
          ? "Thanks for rating how we handled your request."
          : "How did our support team do on this request?"}
      </p>
      <div className="mt-1.5 flex items-center gap-1">
        {[1, 2, 3, 4, 5].map((star) => (
          <Button
            key={star}
            type="button"
            size="sm"
            variant={effectiveCsat === star ? "default" : "outline"}
            className="h-7 w-7 p-0 text-xs"
            aria-label={`Rate support ${star} out of 5`}
            onClick={() => onRate(star)}
          >
            {star}★
          </Button>
        ))}
      </div>
    </div>
  );
}

function TicketComposer({
  closed,
  resolved,
  requestsHref,
  draft,
  sending,
  onDraftChange,
  onSubmit,
}: Readonly<{
  closed: boolean;
  resolved: boolean;
  requestsHref: string;
  draft: string;
  sending: boolean;
  onDraftChange: (value: string) => void;
  onSubmit: (message: string) => void;
}>) {
  if (closed) {
    return (
      <p className="text-sm text-muted-foreground">
        This request is closed.{" "}
        <Link
          href={requestsHref}
          className="font-medium text-foreground underline underline-offset-4"
        >
          Start a new request
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
      }}
    >
      {resolved && (
        <p id="support-reply-reopens" className="text-xs text-muted-foreground">
          This request is marked resolved. Replying reopens it.
        </p>
      )}
      <Textarea
        aria-label="Reply"
        aria-describedby={resolved ? "support-reply-reopens" : undefined}
        rows={3}
        value={draft}
        onChange={(e) => onDraftChange(e.target.value)}
        placeholder={
          resolved
            ? "Reply to reopen this request…"
            : "Write a reply to our team…"
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

/** A platform request (`t_<ticketId>`); private notes never reach this read. */
function TicketRequest({
  ticketId,
  props,
}: Readonly<{ ticketId: string; props: SupportRequestViewProps }>) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [draft, setDraft] = useState("");
  const [offline, setOffline] = useState(false);
  const [csatChoice, setCsatChoice] = useState<number | null>(null);
  const queryKey = ["user-support-ticket", ticketId];

  useEffect(() => {
    setDraft("");
    setCsatChoice(null);
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
    queryKey,
    queryFn: async (): Promise<OwnTicketCase> => {
      const res = await fetch(`/api/user/support-tickets/${ticketId}`);
      if (!res.ok) await throwSupportError(res, "request load");
      return ((await res.json()) as { data: OwnTicketCase }).data;
    },
    refetchIntervalInBackground: false,
    refetchInterval: (q) =>
      q.state.data?.status === "CLOSED" ? false : 30_000,
  });
  const reply = useMutation({
    mutationFn: async (message: string) => {
      const res = await fetch(
        `/api/user/support-tickets/${ticketId}/responses`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message }),
        },
      );
      if (!res.ok) await throwSupportError(res, "request reply");
    },
    onSuccess: () => {
      setDraft("");
      void qc.invalidateQueries({ queryKey });
      void qc.invalidateQueries({ queryKey: ["user-support-tickets"] });
    },
    onError: (e: unknown) =>
      toast({
        title: "Your message wasn't sent",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      }),
  });

  const submitCsat = async (rating: number) => {
    try {
      const res = await fetch(`/api/support/cases/${ticketId}/csat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating }),
      });
      if (res.ok) {
        setCsatChoice(rating);
        void qc.invalidateQueries({ queryKey });
      }
    } catch {
      // Best-effort rating submission.
    }
  };

  const data = query.data;
  useSetBreadcrumbLabel(data?.subject);
  if (query.isError && !data) {
    return (
      <ErrorState
        title="This request could not be loaded"
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
  const withinCsatWindow = Boolean(
    data.resolvedAt &&
    Date.now() - new Date(data.resolvedAt).getTime() <=
      28 * 24 * 60 * 60 * 1000,
  );
  const effectiveCsat = csatChoice ?? data.csatRating ?? null;
  const paymentHref =
    data.payment && props.paymentsBase
      ? `${props.paymentsBase}/${data.payment.id}`
      : undefined;

  return (
    <>
      <PageHeader
        title={data.subject || "Support request"}
        description={[
          CASE_TOPIC_LABEL[data.topic],
          data.reference,
          data.organization?.name,
        ]
          .filter(Boolean)
          .join(" · ")}
        back={{ href: props.requestsHref, label: "Support requests" }}
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="min-w-0 space-y-4">
          <StatusTimeline
            stage={requestStage({ kind: "ticket", status: data.status })}
          />
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
          <div className="flex flex-col rounded-lg border border-border bg-card">
            <div className="max-h-[60vh] min-h-[16rem] space-y-3 overflow-y-auto p-4">
              {data.timeline.map((m) => (
                <SupportBubble
                  key={m.id}
                  perspective="user"
                  author={m.author}
                  authorName={m.author === "USER" ? null : m.authorName}
                  body={m.body}
                  at={m.at}
                />
              ))}
              {!closed && !resolved && (
                <p className="text-center text-[11px] text-muted-foreground">
                  {describeWait(data.ackDueAt)}
                </p>
              )}
              {resolved && withinCsatWindow && (
                <TicketCsatPrompt
                  effectiveCsat={effectiveCsat}
                  onRate={(star) => void submitCsat(star)}
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
            <div className="border-t border-border p-4">
              <TicketComposer
                closed={closed}
                resolved={resolved}
                requestsHref={props.requestsHref}
                draft={draft}
                sending={reply.isPending}
                onDraftChange={setDraft}
                onSubmit={(msg) => reply.mutate(msg)}
              />
            </div>
          </div>
        </div>
        <aside>
          <Articles links={props.articles[data.topic] ?? []} />
        </aside>
      </div>
    </>
  );
}

/**
 * #1527 — one support request as a full page (no drawers): a header with the
 * status timeline, the booking or payment it is about, the conversation and a
 * composer, and three Help Center answers. Shared by every dashboard that
 * mounts Support requests.
 */
export function SupportRequestView(props: Readonly<SupportRequestViewProps>) {
  const ref = parseCaseKey(props.caseKey);
  return (
    <DashboardErrorBoundary>
      {ref?.kind === "booking" && (
        <SessionRequest appointmentId={ref.id} props={props} />
      )}
      {ref?.kind === "ticket" && (
        <TicketRequest ticketId={ref.id} props={props} />
      )}
    </DashboardErrorBoundary>
  );
}
