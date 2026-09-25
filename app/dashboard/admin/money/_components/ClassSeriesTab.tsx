"use client";

import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ClassSeriesView } from "@/lib/backoffice/class-series-types";
import { formatCurrencyAmount } from "@/utils/formatting";
import { RefundDoorDialog, type RefundDoor } from "./RefundDoorDialog";
import { ReasonDialog } from "./ReasonDialog";
import { useOpsDoor } from "./ops-door";

interface PickerRow {
  id: string;
  title: string;
  status: string;
  hostName: string | null;
}

type Door = {
  url: string;
  title: string;
  description: string;
  confirm: string;
  body?: Record<string, unknown>;
  /** Extra fields the dialog asks for, merged into the body on confirm. */
  extra?: "make-up" | "subscription";
};

const when = (iso: string) => new Date(iso).toLocaleString();

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to load");
  return res.json() as Promise<T>;
}

/**
 * #1771 K-6 — the #1780 manual doors. Staff cancel a session for the host,
 * grant a make-up, flag reliability and leave notes; admins also skip a
 * make-up for a learner, cancel the whole series, run a sweep for one row,
 * and refund one seat — every door that moves money.
 */
export function ClassSeriesTab({ isAdmin }: Readonly<{ isAdmin: boolean }>) {
  const [query, setQuery] = useState("");
  const [classId, setClassId] = useState<string | null>(null);
  const [door, setDoor] = useState<Door | null>(null);
  const [refund, setRefund] = useState<{
    door: RefundDoor;
    paymentId: string;
  } | null>(null);

  const picker = useQuery({
    queryKey: ["class-series-picker", query],
    queryFn: () =>
      getJson<{ classes: PickerRow[] }>(
        `/api/admin/class-series?q=${encodeURIComponent(query)}`,
      ),
    staleTime: 30_000,
  });
  const view = useQuery({
    queryKey: ["class-series", classId],
    queryFn: () =>
      getJson<ClassSeriesView>(`/api/admin/class-series/${classId}`),
    enabled: !!classId,
    staleTime: 10_000,
  });
  const base = `/api/admin/class-series/${classId}`;
  const v = view.data;

  return (
    <div className="space-y-4 p-4 md:p-6 lg:p-8">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Class series</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Input
            aria-label="Find a class"
            placeholder="Class title or id"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <ul className="max-h-56 divide-y divide-border overflow-y-auto rounded-md border">
            {(picker.data?.classes ?? []).map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => setClassId(c.id)}
                  aria-current={c.id === classId ? "true" : undefined}
                  className="w-full px-3 py-2 text-left text-sm hover:bg-muted aria-[current=true]:bg-muted"
                >
                  <span className="font-medium">{c.title}</span>
                  <span className="text-muted-foreground">
                    {" "}
                    · {c.hostName ?? "Unknown host"} · {c.status}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {v && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">{v.title}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <p>
                {v.series.delivered} of {v.series.N} sessions delivered,{" "}
                {v.series.remaining} still ahead, {v.series.misses} missed by
                the host.{" "}
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

          <Section title="Sessions the host cancelled">
            {v.cancelledSessions.map((o) => (
              <Row
                key={o.id}
                label={`#${o.ordinal} · was ${when(o.startsAt)} · ${
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
              <Row
                key={s.userId}
                label={`${s.name ?? s.userId} · ${s.status} · ${s.rail ?? "unpaid"} · ${s.delivered}/${s.held} delivered · ${formatCurrencyAmount(s.unitPaise, "INR")} a session`}
              >
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

          {isAdmin && (
            <Button
              variant="outline"
              onClick={() =>
                setDoor({
                  url: "/api/admin/class-series/sweeps/unallocated",
                  title: "Run the 48-hour arm for one plan",
                  description:
                    "Expires a paid plan with no session after 48 hours and refunds it in full.",
                  confirm: "Run",
                  extra: "subscription",
                })
              }
            >
              Run the 48-hour arm for a subscription
            </Button>
          )}
        </>
      )}

      <DoorDialog
        key={door ? `${door.url}:${JSON.stringify(door.body ?? {})}` : "none"}
        door={door}
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

function DoorDialog({
  door,
  onClose,
}: Readonly<{ door: Door | null; onClose: () => void }>) {
  const [startsAt, setStartsAt] = useState("");
  const [bypass, setBypass] = useState(false);
  const [subscriptionId, setSubscriptionId] = useState("");
  const mutation = useOpsDoor({
    success: "Done",
    invalidate: [["class-series"]],
    onDone: onClose,
  });
  if (!door) return null;
  const extraOk =
    door.extra === "make-up"
      ? startsAt !== ""
      : door.extra !== "subscription" || subscriptionId.trim() !== "";
  const extraBody = (): Record<string, unknown> => {
    if (door.extra === "make-up")
      return {
        startsAt: new Date(startsAt).toISOString(),
        bypassWindow: bypass,
      };
    if (door.extra === "subscription")
      return { subscriptionId: subscriptionId.trim() };
    return {};
  };
  return (
    <ReasonDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={door.title}
      description={door.description}
      confirmLabel={door.confirm}
      pending={mutation.isPending}
      canConfirm={extraOk}
      onConfirm={(reason) =>
        mutation.mutate({
          url: door.url,
          body: { ...door.body, ...extraBody(), reason },
        })
      }
    >
      {door.extra === "make-up" && (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="makeup-at">Make-up starts at</Label>
            <Input
              id="makeup-at"
              type="datetime-local"
              value={startsAt}
              onChange={(e) => setStartsAt(e.target.value)}
            />
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id="makeup-bypass"
              checked={bypass}
              onCheckedChange={(c) => setBypass(c === true)}
            />
            <Label htmlFor="makeup-bypass">
              Allow a date past the 14-day window
            </Label>
          </div>
        </>
      )}
      {door.extra === "subscription" && (
        <div className="space-y-1.5">
          <Label htmlFor="sweep-sub">Subscription id</Label>
          <Input
            id="sweep-sub"
            value={subscriptionId}
            onChange={(e) => setSubscriptionId(e.target.value)}
          />
        </div>
      )}
    </ReasonDialog>
  );
}
