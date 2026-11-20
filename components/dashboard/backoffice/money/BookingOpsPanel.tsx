"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import type { BookingOpsView } from "@/lib/backoffice/booking-ops-types";
import {
  paymentStatusBadge,
  SESSION_OUTCOME_LABEL,
  slotStatusBadge,
} from "@/lib/labels/session-labels";
import { OperatorTime } from "@/lib/time/operator-time";
import { operatorEndKind } from "@/lib/time/operator-zone";
import { formatCurrencyAmount } from "@/utils/formatting";
import { useBackofficeCapability } from "@/components/dashboard/backoffice/BackofficeCapabilityProvider";
import { BookingDocumentsOps } from "./BookingDocumentsOps";
import { ClassSeriesDoors } from "./ClassSeriesDoors";
import { DoorDialog, type Door } from "./DoorDialog";
import { PlatformCancelDoor } from "./PlatformCancelDoor";
import { seatLiftDoor } from "./seat-lift-door";
import { SetOutcomeDialog } from "./SetOutcomeDialog";

type Session = BookingOpsView["sessions"][number];

// The set-outcome door overturns only a session the sweep already decided.
const DECIDED = new Set(["COMPLETED", "UNVERIFIED", "VOIDED"]);
// The reschedule door releases only a session that still holds a future time.
const RESCHEDULABLE = new Set(["SCHEDULED", "RESCHEDULED"]);

const REMOVAL_WORDS = {
  ORGANISER: "removed by the organiser",
  CONDUCT: "removed for conduct",
  LEGACY: "left with no recorded leave",
} as const;

const RESCHEDULE_COPY =
  "This only releases the time: the expert places the new time, and both parties are notified. The original time is not put back on its own, so follow up until a new one is placed. Nothing is refunded now, and a session within 24 hours cannot be moved.";

/**
 * #1771 — a booking's Ops actions, by type. Every booking lists its sessions
 * with the set-outcome door and its money state, and can be released for
 * rescheduling or cancelled whole; a class adds its series doors; admin alone
 * gets the refund link and the plan's 48-hour sweep.
 */
export function BookingOpsPanel({
  appointmentId,
}: Readonly<{ appointmentId: string }>) {
  const { can, basePath } = useBackofficeCapability();
  const [target, setTarget] = useState<Session | null>(null);
  const [door, setDoor] = useState<Door | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const ops = useQuery({
    queryKey: ["booking-ops", appointmentId],
    queryFn: async () => {
      const res = await fetch(`/api/staff/appointments/${appointmentId}/ops`);
      if (!res.ok) throw new Error("Failed to load");
      return (await res.json()) as BookingOpsView;
    },
    staleTime: 10_000,
  });
  const v = ops.data;
  if (!v) {
    return (
      <p className="text-sm text-muted-foreground">
        {ops.isError
          ? "Ops actions could not be loaded."
          : "Loading ops actions…"}
      </p>
    );
  }
  const now = Date.now();
  const rescheduleUrl = `/api/staff/appointments/${encodeURIComponent(appointmentId)}/reschedule`;
  const canReschedule = can("appointments.manage");
  const isLive = (s: Session) =>
    RESCHEDULABLE.has(s.completionStatus) &&
    new Date(s.startsAt).getTime() > now;
  const perSession = v.type === "SUBSCRIPTION" || v.type === "CLASS";
  // A booking with no session yet may still be awaiting its times.
  const canCancel =
    can("appointments.cancelForPlatform") &&
    (v.sessions.length === 0 || v.sessions.some(isLive));

  return (
    <section aria-label="Ops actions" className="space-y-4">
      <h3 className="text-sm font-semibold">Ops actions</h3>

      <div className="space-y-1 text-sm">
        <p className="font-medium">Sessions</p>
        {v.sessions.length === 0 && (
          <p className="text-muted-foreground">No sessions yet.</p>
        )}
        <ul className="divide-y divide-border rounded-md border">
          {v.sessions.map((s) => (
            <li
              key={s.id}
              className="flex flex-wrap items-center justify-between gap-2 p-2"
            >
              <span className="min-w-0 flex-1">
                #{s.ordinal} · <OperatorTime value={s.startsAt} /> –{" "}
                <OperatorTime
                  value={s.endsAt}
                  kind={operatorEndKind(s.startsAt, s.endsAt)}
                />{" "}
                · {slotStatusBadge(s.completionStatus).label}
                {s.outcome ? ` · ${SESSION_OUTCOME_LABEL[s.outcome]}` : ""}
              </span>
              {DECIDED.has(s.completionStatus) &&
                new Date(s.endsAt).getTime() < now && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setTarget(s)}
                  >
                    Set outcome
                  </Button>
                )}
              {canReschedule && perSession && isLive(s) && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setDoor({
                      url: rescheduleUrl,
                      title: `Release session #${s.ordinal} for rescheduling`,
                      description: RESCHEDULE_COPY,
                      confirm: "Release",
                      body: { slotIds: [s.id] },
                    })
                  }
                >
                  Reschedule
                </Button>
              )}
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          {canReschedule && v.sessions.some(isLive) && (
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                setDoor({
                  url: rescheduleUrl,
                  title: "Release this booking for rescheduling",
                  description: `Releases every live session. ${RESCHEDULE_COPY}`,
                  confirm: "Release",
                })
              }
            >
              Reschedule booking
            </Button>
          )}
          {canCancel && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setCancelOpen(true)}
            >
              Cancel booking
            </Button>
          )}
        </div>
      </div>

      {v.removedSeats.length > 0 && (
        <div className="space-y-1 text-sm">
          <p className="font-medium">Removed attendees</p>
          <ul className="divide-y divide-border rounded-md border">
            {v.removedSeats.map((seat) => (
              <li
                key={seat.userId}
                className="flex flex-wrap items-center justify-between gap-2 p-2"
              >
                <span className="min-w-0 flex-1">
                  {seat.name || "Attendee"} · {REMOVAL_WORDS[seat.removal]}
                  {seat.paidSeat && " · paid seat: support rejoins them"}
                </span>
                {can("appointments.liftSeatRemoval") && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setDoor(seatLiftDoor(appointmentId, seat))}
                  >
                    Allow back
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="space-y-1 text-sm">
        <p className="font-medium">Money</p>
        {v.payments.length === 0 && (
          <p className="text-muted-foreground">No payment on this booking.</p>
        )}
        <ul className="divide-y divide-border rounded-md border">
          {v.payments.map((p) => (
            <li
              key={p.id}
              className="flex flex-wrap items-center justify-between gap-2 p-2"
            >
              <span className="min-w-0 flex-1">
                {formatCurrencyAmount(p.amountPaise, p.currency)} ·{" "}
                {paymentStatusBadge(p.status).label}
                {p.refundedPaise > 0
                  ? ` · ${formatCurrencyAmount(p.refundedPaise, p.currency)} refunded`
                  : ""}
                {p.pendingRefundPaise > 0
                  ? ` · ${formatCurrencyAmount(p.pendingRefundPaise, p.currency)} refund pending`
                  : ""}
              </span>
              {can("refunds.manage") && (
                <Button size="sm" variant="outline" asChild>
                  <Link
                    href={`${basePath}/money/refunds?door=issue&paymentId=${encodeURIComponent(p.id)}`}
                  >
                    Issue refund
                  </Link>
                </Button>
              )}
            </li>
          ))}
        </ul>
      </div>

      {can("classSeries.money") &&
        v.type === "SUBSCRIPTION" &&
        v.subscriptionId && (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              setDoor({
                url: "/api/admin/class-series/sweeps/unallocated",
                title: "Run the 48-hour sweep for this plan",
                description:
                  "Expires a paid plan with no session after 48 hours and refunds it in full.",
                confirm: "Run",
                body: { subscriptionId: v.subscriptionId },
              })
            }
          >
            Run the 48-hour sweep
          </Button>
        )}

      {v.type === "CLASS" && v.classId && (
        <ClassSeriesDoors classId={v.classId} />
      )}

      {can("appointments.manage") && (
        <BookingDocumentsOps appointmentId={appointmentId} />
      )}

      {target && (
        <SetOutcomeDialog
          key={target.id}
          occurrenceId={target.id}
          initial={target.outcome ?? "INCONCLUSIVE"}
          invalidate={[["booking-ops"], ["sessions-needs-human"]]}
          onClose={() => setTarget(null)}
        />
      )}
      <DoorDialog
        key={door ? door.url : "none"}
        door={door}
        invalidate={[["booking-ops"], ["staff-appointment-timeline"]]}
        onClose={() => setDoor(null)}
      />
      <PlatformCancelDoor
        appointmentId={appointmentId}
        open={cancelOpen}
        invalidate={[["booking-ops"], ["staff-appointment-timeline"]]}
        onClose={() => setCancelOpen(false)}
      />
    </section>
  );
}
