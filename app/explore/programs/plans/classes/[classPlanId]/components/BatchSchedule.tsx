"use client";

import Link from "next/link";
import { formatInTimeZone } from "date-fns-tz";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FreeCancellationLine } from "@/components/events/FreeCancellationLine";
import { useCurrency } from "@/hooks/useCurrency";
import { useSession } from "@/lib/auth-client";
import { isUserEnrolled } from "@/lib/payments/utils/participants";
import type { BatchCard } from "@/lib/booking/batch-cards";
import {
  buildSessionsFromAppointment,
  groupSessionsByWeek,
  type SessionInfo,
} from "@/app/explore/programs/plans/schedule-utils";
import type { TClassPlanDetailsData } from "../types";

type Plan = TClassPlanDetailsData;
type Batch = Plan["classes"][number];

function badgeVariant(status: string): "outline" | "destructive" | "default" {
  if (status === "Completed") return "outline";
  if (status === "Happening Now") return "destructive";
  return "default";
}

/** #1819 — the batch's enrolment state in one sentence. */
function enrolmentLine(
  card: BatchCard,
  price: (paise: number) => string,
  when: (d: Date) => string,
): string {
  const next = card.nextBatchStartsAt
    ? ` · next batch starts ${when(card.nextBatchStartsAt)}`
    : "";
  if (card.phase === "completed") return "This batch has finished.";
  if (card.phase === "unscheduled") return "Dates to be announced.";
  if (card.isFull) return `Sold out${next}`;
  if (card.enrolment.state !== "open") return `Enrolment closed${next}`;
  const { basePaise, remaining, N, isLateJoin } = card.enrolment;
  return isLateJoin
    ? `Join now for ${price(basePaise)} · ${remaining} of ${N} sessions left`
    : `Join now for ${price(basePaise)} · all ${N} sessions`;
}

function SessionRow({
  session,
  zone,
}: Readonly<{ session: SessionInfo; zone: string }>) {
  return (
    <div
      className={`flex items-center justify-between p-3 rounded-lg bg-muted ${
        session.status === "Completed" ? "opacity-60" : ""
      }`}
    >
      <div className="flex items-center gap-3">
        <div className="w-7 h-7 rounded-full bg-border text-muted-foreground flex items-center justify-center text-xs font-semibold flex-shrink-0">
          {session.sessionNumber}
        </div>
        <div className="text-sm">
          <span className="font-medium text-foreground">
            {formatInTimeZone(session.sessionStart, zone, "EEEE, MMMM d")}
          </span>
          <span className="text-muted-foreground ml-2">
            {formatInTimeZone(session.sessionStart, zone, "h:mm a")}
            {" – "}
            {formatInTimeZone(session.sessionEnd, zone, "h:mm a zzz")}
          </span>
        </div>
      </div>
      <Badge variant={badgeVariant(session.status)}>{session.status}</Badge>
    </div>
  );
}

function BatchSessions({
  batch,
  weekly,
  zone,
}: Readonly<{ batch: Batch; weekly: boolean; zone: string }>) {
  const sessions = buildSessionsFromAppointment(batch.appointment);
  if (sessions.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">Schedule to be announced</p>
    );
  }
  // One session a week makes every "Week N" heading hold a single row.
  if (!weekly) {
    return (
      <div className="space-y-2">
        {sessions.map((s) => (
          <SessionRow
            key={s.sessionStart.toISOString()}
            session={s}
            zone={zone}
          />
        ))}
      </div>
    );
  }
  return (
    <div className="space-y-4">
      {Array.from(groupSessionsByWeek(sessions).entries()).map(
        ([weekNum, weekSessions]) => (
          <div key={weekNum}>
            <h4 className="text-xs font-medium text-muted-foreground/70 uppercase tracking-wider mb-2 px-1">
              Week {weekNum}
            </h4>
            <div className="space-y-2">
              {weekSessions.map((s) => (
                <SessionRow
                  key={s.sessionStart.toISOString()}
                  session={s}
                  zone={zone}
                />
              ))}
            </div>
          </div>
        ),
      )}
    </div>
  );
}

function BatchPanel({
  plan,
  batch,
  card,
  zone,
  userId,
}: Readonly<{
  plan: Plan;
  batch: Batch;
  card: BatchCard;
  zone: string;
  userId: string | undefined;
}>) {
  const { formatPrice } = useCurrency();
  const checkoutUrl = `/checkout/plans/class/${plan.id}?eventId=${card.classId}`;
  const enrolled = !!userId && isUserEnrolled(batch.appointment, userId);
  const href = userId
    ? checkoutUrl
    : `/auth/signin?callbackUrl=${encodeURIComponent(checkoutUrl)}`;
  return (
    <div className="p-4 border border-border rounded-xl space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="font-medium text-foreground">{card.label}</h3>
          <p className="text-sm text-muted-foreground">
            {enrolmentLine(card, formatPrice, (d) =>
              formatInTimeZone(d, zone, "EEE d MMM"),
            )}
          </p>
          {card.phase !== "completed" && (
            <p className="text-sm text-muted-foreground">
              {card.isFull
                ? "No seats left"
                : `${card.seatsLeft} ${card.seatsLeft === 1 ? "seat" : "seats"} left`}
            </p>
          )}
          {card.phase === "upcoming" && (
            <FreeCancellationLine
              startsAt={card.startsAt}
              windowHours={plan.refundWindowHours}
              kind="class"
            />
          )}
        </div>
        {enrolled ? (
          <Badge variant="secondary">You are enrolled</Badge>
        ) : (
          card.canEnrol && (
            <Button asChild size="sm">
              <Link href={href}>Enrol in this batch</Link>
            </Button>
          )
        )}
      </div>
      <BatchSessions
        batch={batch}
        weekly={plan.sessionsPerWeek > 1}
        zone={zone}
      />
    </div>
  );
}

/** #1819 — the listing's batches as cards, finished batches collapsed. */
export function BatchSchedule({
  plan,
  cards,
  zone,
}: Readonly<{ plan: Plan; cards: BatchCard[]; zone: string }>) {
  const { data: session } = useSession();
  const userId = session?.user?.id;
  const byId = new Map(plan.classes.map((c) => [c.id, c]));
  const panel = (card: BatchCard) => {
    const batch = byId.get(card.classId);
    return batch ? (
      <BatchPanel
        key={card.classId}
        plan={plan}
        batch={batch}
        card={card}
        zone={zone}
        userId={userId}
      />
    ) : null;
  };
  const current = cards.filter((c) => c.phase !== "completed");
  const past = cards.filter((c) => c.phase === "completed");
  if (cards.length === 0) {
    return (
      <p className="text-muted-foreground">Class schedule to be announced.</p>
    );
  }
  return (
    <div className="space-y-6">
      {current.map(panel)}
      {past.length > 0 && (
        <details className="rounded-xl border border-border p-4">
          <summary className="cursor-pointer text-sm font-medium text-foreground">
            Past batches ({past.length})
          </summary>
          <div className="mt-4 space-y-6">{past.map(panel)}</div>
        </details>
      )}
    </div>
  );
}
