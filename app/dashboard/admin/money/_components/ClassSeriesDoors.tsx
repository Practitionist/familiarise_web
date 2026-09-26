"use client";

import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ClassSeriesView } from "@/lib/backoffice/class-series-types";
import { enumLabel, fundingRailLabel } from "@/lib/labels/money-labels";
import { formatCurrencyAmount } from "@/utils/formatting";
import { DoorDialog, type Door } from "./DoorDialog";
import { RefundDoorDialog, type RefundDoor } from "./RefundDoorDialog";

const when = (iso: string) => new Date(iso).toLocaleString();

function seatLabel(s: ClassSeriesView["seats"][number]): string {
  const rail = s.rail ? fundingRailLabel(s.rail) : "Unpaid";
  const unit = formatCurrencyAmount(s.unitPaise, "INR");
  return `${s.name ?? s.userId} · ${enumLabel(s.status)} · ${rail} · ${s.delivered}/${s.held} delivered · ${unit} a session`;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to load");
  return res.json() as Promise<T>;
}

/**
 * #1771 K-6 — the #1780 manual doors for one class, in its booking's Ops
 * actions panel. Staff cancel a session for the host, grant a make-up, flag
 * reliability and leave notes; admins also skip a make-up for a learner,
 * cancel the whole series, run the 14-day sweep for one session, and refund
 * one seat — every door that moves money.
 */
export function ClassSeriesDoors({
  classId,
  isAdmin,
}: Readonly<{ classId: string; isAdmin: boolean }>) {
  const [door, setDoor] = useState<Door | null>(null);
  const [refund, setRefund] = useState<{
    door: RefundDoor;
    paymentId: string;
  } | null>(null);

  const view = useQuery({
    queryKey: ["class-series", classId],
    queryFn: () =>
      getJson<ClassSeriesView>(`/api/admin/class-series/${classId}`),
    staleTime: 10_000,
  });
  const base = `/api/admin/class-series/${classId}`;
  const v = view.data;

  return (
    <div className="space-y-4">
      {v && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Class series</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <p>
                {v.series.delivered} of {v.series.N} sessions delivered,{" "}
                {v.series.remaining} still ahead, {v.series.misses} missed (
                {v.series.hostMisses} by the host).{" "}
                {v.series.exitRight
                  ? "Learners may leave with every undelivered session refunded."
                  : "Learners have no exit right yet."}
              </p>
              <p>
                Reliability flag:{" "}
                {v.reliability.active
                  ? `on since ${when(v.reliability.since ?? "")}`
                  : "off"}
                .
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setDoor({
                      url: `${base}/reliability`,
                      title: v.reliability.active
                        ? "Clear the reliability flag"
                        : "Apply the reliability flag",
                      description:
                        "The latest flag event on this class decides whether it is on.",
                      confirm: v.reliability.active ? "Clear" : "Apply",
                      body: { state: v.reliability.active ? "clear" : "apply" },
                    })
                  }
                >
                  {v.reliability.active ? "Clear flag" : "Apply flag"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setDoor({
                      url: `${base}/note`,
                      title: "Add an ops note",
                      description: "The note is kept in the audit log.",
                      confirm: "Save note",
                    })
                  }
                >
                  Add note
                </Button>
                {isAdmin && (
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() =>
                      setDoor({
                        url: `${base}/cancel-series`,
                        title: "Cancel the whole series",
                        description:
                          "Every seat is refunded what was not delivered, through the normal cancel path.",
                        confirm: "Cancel series",
                      })
                    }
                  >
                    Cancel whole series
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>

          <Section title="Upcoming sessions">
            {v.upcoming.map((o) => (
              <Row key={o.id} label={`#${o.ordinal} · ${when(o.startsAt)}`}>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setDoor({
                      url: `${base}/cancel-session`,
                      title: "Cancel this session for the host",
                      description:
                        "It counts as a host miss and must be made up within 14 days or refunded.",
                      confirm: "Cancel session",
                      body: { occurrenceId: o.id },
                    })
                  }
                >
                  Cancel for host
                </Button>
              </Row>
            ))}
          </Section>

          <Section title="Missed sessions (cancelled by the host or voided)">
            {v.cancelledSessions.map((o) => (
              <Row
                key={o.id}
                label={`#${o.ordinal} · ${o.voided ? "voided" : "cancelled"} · was ${when(o.startsAt)} · ${
                  o.makeUp ? `made up ${when(o.makeUp.startsAt)}` : "no make-up"
                }${o.seatsSettledAt ? " · settled" : ""}`}
              >
                {!o.makeUp && !o.seatsSettledAt && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setDoor({
                        url: `${base}/make-up`,
                        title: "Grant a make-up",
                        description:
                          "Same session number, new time. Past the 14-day window only with the bypass.",
                        confirm: "Schedule make-up",
                        body: { occurrenceId: o.id },
                        extra: "make-up",
                      })
                    }
                  >
                    Grant make-up
                  </Button>
                )}
                {isAdmin && !o.seatsSettledAt && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setDoor({
                        url: "/api/admin/class-series/sweeps/settle-session",
                        title: "Run the 14-day sweep for this session",
                        description:
                          "Refunds one unit to every seat that held it, if the window is over and no make-up exists.",
                        confirm: "Run sweep",
                        body: { occurrenceId: o.id },
                      })
                    }
                  >
                    Settle now
                  </Button>
                )}
              </Row>
            ))}
          </Section>

          <Section title="Seats">
            {v.seats.map((s) => (
              <Row key={s.userId} label={seatLabel(s)}>
                {v.cancelledSessions
                  .filter((o) => isAdmin && o.makeUp && !o.seatsSettledAt)
                  .map((o) => (
                    <Button
                      key={o.id}
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        setDoor({
                          url: `${base}/skip-make-up`,
                          title: `Skip make-up #${o.ordinal} for this learner`,
                          description:
                            "The session comes back as one unit, under the same key as the day-14 sweep.",
                          confirm: "Skip make-up",
                          body: { occurrenceId: o.id, userId: s.userId },
                        })
                      }
                    >
                      Skip #{o.ordinal}
                    </Button>
                  ))}
                {isAdmin && s.paymentId && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setRefund({
                        door: s.rail === "CREDITS" ? "credits" : "issue",
                        paymentId: s.paymentId ?? "",
                      })
                    }
                  >
                    {s.rail === "CREDITS" ? "Return credits" : "Refund"}
                  </Button>
                )}
              </Row>
            ))}
          </Section>
        </>
      )}

      <DoorDialog
        key={door ? `${door.url}:${JSON.stringify(door.body ?? {})}` : "none"}
        door={door}
        invalidate={[["class-series"], ["booking-ops"]]}
        onClose={() => setDoor(null)}
      />
      <RefundDoorDialog
        key={refund ? `${refund.door}-${refund.paymentId}` : "none"}
        door={refund?.door ?? null}
        presetPaymentId={refund?.paymentId}
        onClose={() => setRefund(null)}
      />
    </div>
  );
}

function Section({
  title,
  children,
}: Readonly<{ title: string; children: ReactNode[] }>) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {children.length > 0 ? (
          <ul className="divide-y divide-border">{children}</ul>
        ) : (
          <p className="text-sm text-muted-foreground">None.</p>
        )}
      </CardContent>
    </Card>
  );
}

function Row({
  label,
  children,
}: Readonly<{ label: string; children?: ReactNode }>) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
      <span className="min-w-0 flex-1">{label}</span>
      <span className="flex flex-wrap gap-2">{children}</span>
    </li>
  );
}
