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
import { formatCurrencyAmount } from "@/utils/formatting";
import { useBackofficeCapability } from "@/components/dashboard/backoffice/BackofficeCapabilityProvider";
import { ClassSeriesDoors } from "./ClassSeriesDoors";
import { DoorDialog, type Door } from "./DoorDialog";
import { SetOutcomeDialog } from "./SetOutcomeDialog";

type Session = BookingOpsView["sessions"][number];

// The set-outcome door overturns only a session the sweep already decided.
const DECIDED = new Set(["COMPLETED", "UNVERIFIED", "VOIDED"]);

const when = (iso: string) => new Date(iso).toLocaleString();

/**
 * #1771 — a booking's Ops actions, by type. Every booking lists its sessions
 * with the set-outcome door and its money state; a class adds its series
 * doors; admin alone gets the refund link and the plan's 48-hour sweep.
 */
export function BookingOpsPanel({
  appointmentId,
}: Readonly<{ appointmentId: string }>) {
  const { can, basePath } = useBackofficeCapability();
  const [target, setTarget] = useState<Session | null>(null);
  const [door, setDoor] = useState<Door | null>(null);
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
                #{s.ordinal} · {when(s.startsAt)} ·{" "}
                {slotStatusBadge(s.completionStatus).label}
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
            </li>
          ))}
        </ul>
      </div>

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
        invalidate={[["booking-ops"]]}
        onClose={() => setDoor(null)}
      />
    </section>
  );
}
