"use client";

/**
 * #org-appts — the member-facing list for an org's per-user appointments
 * (sessions they booked as a learner OR deliver as an expert; trials
 * excluded). Renders a responsive card list rather than the ScopedListTable
 * used by the operator Appointments page: each row needs its own in-context
 * Join button with per-row busy state, which a plain column-accessor table
 * doesn't host cleanly.
 *
 * The Join path mirrors the consultant adapter (useLazyJoinMeeting): it reads
 * the already-connected global Stream video client at click time and stamps
 * per-appointment identity (consultantUserId / consulteeUserId) into the call
 * so the meeting room derives host/guest from WHICH SIDE the viewer is on —
 * correct even for a dual-profile user booked as a learner into someone
 * else's session.
 */

import { useState } from "react";
import Link from "next/link";
import { CalendarClock, Loader2, Video } from "lucide-react";
import type { AppointmentsType } from "@prisma/client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  CONSULTEE_JOIN_WINDOW_MS,
  getJoinableSlot,
} from "@/lib/appointments/slots";
import type { MeetingAppointment } from "@/lib/meeting";
import { useLazyJoinMeeting } from "@/app/dashboard/consultant/[consultantId]/(features)/shared/hooks/useLazyJoinMeeting";

// Slot shape as delivered by getOrgMemberAppointments (see the include in
// lib/api/scope/list-appointments.ts). Dates survive the RSC boundary as
// Date instances (toPlain preserves them); typed loosely so either survives.
export interface MyAppointmentSlot {
  id: string;
  startsAt: string | Date;
  endsAt: string | Date | null;
  isTentative: boolean;
  completionStatus: string | null;
}

interface PlanSide {
  title: string | null;
  consultantProfile: { user: { id: string } | null } | null;
}

interface RequestedBySide {
  user: { id: string; name: string | null; email: string } | null;
}

export interface MyAppointmentItem {
  id: string;
  appointmentType: AppointmentsType;
  createdAt: string | Date;
  slotsOfAppointment: MyAppointmentSlot[];
  consultation: {
    consultationPlan: PlanSide | null;
    requestedBy: RequestedBySide | null;
  } | null;
  subscription: {
    subscriptionPlan: PlanSide | null;
    requestedBy: RequestedBySide | null;
  } | null;
  webinar: { webinarPlan: PlanSide | null } | null;
  class: { classPlan: PlanSide | null } | null;
}

const TYPE_LABEL: Record<string, string> = {
  CONSULTATION: "Consultation",
  SUBSCRIPTION: "Subscription",
  WEBINAR: "Webinar",
  CLASS: "Class",
  TRIAL: "Trial",
};

interface ResolvedIdentity {
  title: string;
  counterpart: string | null;
  consultantUserId: string | null;
  consulteeUserId: string | null;
}

/**
 * Resolve the display title + the two identity user-ids from whichever of
 * consultation / subscription / webinar / class is populated on the row.
 * consulteeUserId is null for webinar/class (no single requester).
 */
function resolveIdentity(item: MyAppointmentItem): ResolvedIdentity {
  if (item.consultation) {
    return {
      title: item.consultation.consultationPlan?.title ?? "Consultation",
      counterpart:
        item.consultation.requestedBy?.user?.name ??
        item.consultation.requestedBy?.user?.email ??
        null,
      consultantUserId:
        item.consultation.consultationPlan?.consultantProfile?.user?.id ?? null,
      consulteeUserId: item.consultation.requestedBy?.user?.id ?? null,
    };
  }
  if (item.subscription) {
    return {
      title: item.subscription.subscriptionPlan?.title ?? "Subscription",
      counterpart:
        item.subscription.requestedBy?.user?.name ??
        item.subscription.requestedBy?.user?.email ??
        null,
      consultantUserId:
        item.subscription.subscriptionPlan?.consultantProfile?.user?.id ?? null,
      consulteeUserId: item.subscription.requestedBy?.user?.id ?? null,
    };
  }
  if (item.webinar) {
    return {
      title: item.webinar.webinarPlan?.title ?? "Webinar",
      counterpart: null,
      consultantUserId:
        item.webinar.webinarPlan?.consultantProfile?.user?.id ?? null,
      consulteeUserId: null,
    };
  }
  if (item.class) {
    return {
      title: item.class.classPlan?.title ?? "Class",
      counterpart: null,
      consultantUserId:
        item.class.classPlan?.consultantProfile?.user?.id ?? null,
      consulteeUserId: null,
    };
  }
  return {
    title: "Session",
    counterpart: null,
    consultantUserId: null,
    consulteeUserId: null,
  };
}

/** Earliest slot that hasn't ended yet, else the latest slot (for display). */
function displaySlot(slots: MyAppointmentSlot[]): MyAppointmentSlot | null {
  if (slots.length === 0) return null;
  const now = Date.now();
  const sorted = [...slots].sort(
    (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
  );
  const upcoming = sorted.find((s) => {
    const end = s.endsAt ? new Date(s.endsAt).getTime() : new Date(s.startsAt).getTime();
    return end >= now;
  });
  return upcoming ?? sorted[sorted.length - 1];
}

function formatSlot(slot: MyAppointmentSlot): string {
  return new Date(slot.startsAt).toLocaleString("en-IN", {
    // RSC renders in UTC otherwise; this component is client-side but the
    // fixed IST zone keeps parity with the compensation page's formatting.
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function MyAppointmentsClient({
  orgId,
  items,
  total,
  page,
  perPage,
}: {
  orgId: string;
  items: MyAppointmentItem[];
  total: number;
  page: number;
  perPage: number;
}) {
  const joinMeeting = useLazyJoinMeeting();
  const [joiningId, setJoiningId] = useState<string | null>(null);

  const totalPages = Math.max(1, Math.ceil(total / perPage));

  const handleJoin = async (item: MyAppointmentItem, slot: MyAppointmentSlot) => {
    setJoiningId(item.id);
    const identity = resolveIdentity(item);
    const appointment: MeetingAppointment = {
      id: item.id,
      appointmentType: item.appointmentType,
      slotsOfAppointment: item.slotsOfAppointment.map((s) => ({
        id: s.id,
        startsAt: s.startsAt,
        endsAt: s.endsAt,
        isTentative: s.isTentative,
      })),
      organizationId: orgId,
      consultantUserId: identity.consultantUserId,
      consulteeUserId: identity.consulteeUserId,
    };
    const navigating = await joinMeeting(appointment, {
      id: slot.id,
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      isTentative: slot.isTentative,
    });
    if (!navigating) setJoiningId(null);
  };

  if (items.length === 0) {
    return (
      <div className="rounded-lg border bg-card py-12 text-center text-sm text-muted-foreground">
        No appointments under this organization yet. Sessions you book or are
        assigned to deliver here will show up on this page.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <ul className="space-y-3">
        {items.map((item) => {
          const identity = resolveIdentity(item);
          const joinable = getJoinableSlot(item.slotsOfAppointment, {
            joinWindowMs: CONSULTEE_JOIN_WINDOW_MS,
          });
          const shown = displaySlot(item.slotsOfAppointment);
          const busy = joiningId === item.id;
          return (
            <li
              key={item.id}
              className="flex flex-col gap-3 rounded-lg border bg-card p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0 space-y-1">
                <div className="flex items-center gap-2">
                  <p className="truncate font-medium">{identity.title}</p>
                  <Badge variant="outline" className="shrink-0">
                    {TYPE_LABEL[item.appointmentType] ?? item.appointmentType}
                  </Badge>
                </div>
                {identity.counterpart && (
                  <p className="truncate text-sm text-muted-foreground">
                    with {identity.counterpart}
                  </p>
                )}
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <CalendarClock className="h-3.5 w-3.5 shrink-0" />
                  {shown ? formatSlot(shown) : "No session scheduled yet"}
                </p>
              </div>

              <div className="shrink-0">
                {joinable ? (
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => void handleJoin(item, joinable)}
                  >
                    {busy ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Video className="mr-2 h-4 w-4" />
                    )}
                    Join
                  </Button>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    Join opens near the start time
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {total > perPage && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            Showing {(page - 1) * perPage + 1}–{Math.min(page * perPage, total)}{" "}
            of {total}
          </span>
          <div className="flex gap-2">
            <Button asChild variant="outline" size="sm" disabled={page <= 1}>
              <Link href={`?page=${Math.max(1, page - 1)}`}>Prev</Link>
            </Button>
            <Button
              asChild
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
            >
              <Link href={`?page=${Math.min(totalPages, page + 1)}`}>Next</Link>
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
