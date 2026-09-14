"use client";

/**
 * Schedule display cluster for the collaborations surface — summary +
 * expandable event lists for webinar and class plans. Extracted verbatim
 * from InvitationsPanel.tsx during the dashboard redesign; event status
 * pills come from the shared session-labels maps.
 */

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { eventStatusBadge } from "@/lib/labels/session-labels";
import { Calendar, Clock, Users, ChevronDown, ChevronUp } from "lucide-react";
import type {
  CohortEventSchedule,
  CohortPlanSchedule,
  WebinarPlanSchedule,
} from "./types";
import { formatDateTime, formatTime } from "./format";

export function WebinarScheduleSummary({
  plan,
}: {
  plan: WebinarPlanSchedule;
}) {
  const webinar = plan.webinars[0];
  const slot = webinar?.appointment?.occurrences[0];

  if (!webinar) {
    return (
      <p className="text-xs text-zinc-400 italic">
        No events scheduled yet — only the event owner can add scheduling
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <StatusBadge size="sm" {...eventStatusBadge(webinar.status)} />
        {slot?.isTentative && (
          <Badge
            variant="outline"
            className="border-amber-300 text-amber-700 bg-amber-50 text-[11px]"
          >
            Tentative
          </Badge>
        )}
      </div>

      {slot ? (
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-zinc-600">
          <div className="flex items-center gap-1.5">
            <Calendar className="w-3 h-3 text-zinc-400" />
            <span>{formatDateTime(slot.startsAt)}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Clock className="w-3 h-3 text-zinc-400" />
            <span>
              {formatTime(slot.startsAt)} &ndash; {formatTime(slot.endsAt)}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Clock className="w-3 h-3 text-zinc-400" />
            <span>{plan.durationInHours}h duration</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Users className="w-3 h-3 text-zinc-400" />
            <span>
              {webinar.appointment?._count.participants ?? 0} /{" "}
              {plan.maxParticipants} participants
            </span>
          </div>
        </div>
      ) : (
        <p className="text-xs text-zinc-400 italic">
          Event exists but no time slot set
        </p>
      )}
    </div>
  );
}

export function WebinarEventList({ plan }: { plan: WebinarPlanSchedule }) {
  return (
    <div className="space-y-2">
      {plan.webinars.map((webinar) => {
        const slot = webinar.appointment?.occurrences[0];
        if (!slot) return null;
        return (
          <div
            key={webinar.id}
            className="rounded-md border border-zinc-100 bg-zinc-50/50 px-3 py-2"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <StatusBadge size="sm" {...eventStatusBadge(webinar.status)} />
                {slot.isTentative && (
                  <Badge
                    variant="outline"
                    className="border-amber-300 text-amber-700 bg-amber-50 text-[10px]"
                  >
                    Tentative
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-1.5 text-xs text-zinc-500">
                <Users className="w-3 h-3" />
                <span>
                  {webinar.appointment?._count.participants ?? 0} /{" "}
                  {plan.maxParticipants}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-3 mt-1.5 text-xs text-zinc-600">
              <div className="flex items-center gap-1.5">
                <Calendar className="w-3 h-3 text-zinc-400" />
                <span>{formatDateTime(slot.startsAt)}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Clock className="w-3 h-3 text-zinc-400" />
                <span>
                  {formatTime(slot.startsAt)} &ndash; {formatTime(slot.endsAt)}
                </span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function CohortScheduleSummary({ plan }: { plan: CohortPlanSchedule }) {
  if (plan.cohorts.length === 0) {
    return (
      <p className="text-xs text-zinc-400 italic">
        No classes scheduled yet — only the event owner can add scheduling
      </p>
    );
  }

  const activeCohort =
    plan.cohorts.find((c) => c.status === "IN_PROGRESS") ?? plan.cohorts[0];
  const allSlots = activeCohort.appointments.flatMap((a) => a.occurrences);
  const now = new Date();
  const upcomingOccurrences = allSlots.filter(
    (s) => new Date(s.startsAt) > now,
  );
  const nextSlot = upcomingOccurrences[0];
  const totalEnrolled = activeCohort.appointments[0]?._count.participants ?? 0;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <StatusBadge size="sm" {...eventStatusBadge(activeCohort.status)} />
        {plan.cohorts.length > 1 && (
          <span className="text-[11px] text-zinc-400">
            ({plan.cohorts.length} batches)
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-zinc-600">
        {activeCohort.schedulingPeriodStartsAt &&
          activeCohort.schedulingPeriodEndsAt && (
            <div className="flex items-center gap-1.5 col-span-2">
              <Calendar className="w-3 h-3 text-zinc-400" />
              <span>
                {formatDateTime(activeCohort.schedulingPeriodStartsAt)} &ndash;{" "}
                {formatDateTime(activeCohort.schedulingPeriodEndsAt)}
              </span>
            </div>
          )}
        <div className="flex items-center gap-1.5">
          <Clock className="w-3 h-3 text-zinc-400" />
          <span>
            {allSlots.length} / {plan.totalSessions} sessions
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <Users className="w-3 h-3 text-zinc-400" />
          <span>
            {totalEnrolled} / {plan.maxParticipants} participants
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <Clock className="w-3 h-3 text-zinc-400" />
          <span>
            {plan.sessionDurationInHours}h/session &middot;{" "}
            {plan.sessionsPerWeek}x/week
          </span>
        </div>
        {nextSlot && (
          <div className="flex items-center gap-1.5">
            <Calendar className="w-3 h-3 text-zinc-400" />
            <span>
              Next: {formatDateTime(nextSlot.startsAt)}{" "}
              {formatTime(nextSlot.startsAt)}
            </span>
          </div>
        )}
      </div>

      {!activeCohort.schedulingPeriodStartsAt && allSlots.length === 0 && (
        <p className="text-xs text-zinc-400 italic">
          Sessions not yet scheduled
        </p>
      )}
    </div>
  );
}

function CohortSessionList({ cls }: { cls: CohortEventSchedule }) {
  const allSlots = cls.appointments.flatMap((a) =>
    a.occurrences.map((slot) => ({ ...slot, enrolled: a._count.participants })),
  );
  if (allSlots.length === 0) {
    return (
      <p className="text-xs text-zinc-400 italic py-1">
        Sessions not yet scheduled
      </p>
    );
  }

  const now = new Date();

  return (
    <div className="space-y-1">
      {allSlots.map((slot, i) => {
        const isPast = new Date(slot.endsAt) < now;
        return (
          <div
            key={i}
            className={`flex items-center justify-between text-xs py-1.5 border-b border-zinc-50 last:border-0 ${
              isPast ? "text-zinc-400" : "text-zinc-600"
            }`}
          >
            <div className="flex items-center gap-3">
              <span className="w-5 text-center text-[10px] text-zinc-400">
                {i + 1}
              </span>
              <span>{formatDateTime(slot.startsAt)}</span>
              <span className="text-zinc-400">
                {formatTime(slot.startsAt)} &ndash; {formatTime(slot.endsAt)}
              </span>
              {isPast && (
                <Badge
                  variant="outline"
                  className="border-zinc-200 text-zinc-400 text-[10px]"
                >
                  Done
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-1.5 text-zinc-400">
              <Users className="w-3 h-3" />
              <span>{slot.enrolled}</span>
              {slot.isTentative && (
                <Badge
                  variant="outline"
                  className="border-amber-300 text-amber-700 bg-amber-50 text-[10px] ml-1"
                >
                  Tentative
                </Badge>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function CohortEventCard({
  cls,
  plan,
}: {
  cls: CohortEventSchedule;
  plan: CohortPlanSchedule;
}) {
  const [sessionsExpanded, setSessionsExpanded] = useState(false);
  const allSlots = cls.appointments.flatMap((a) => a.occurrences);
  const totalEnrolled = cls.appointments[0]?._count.participants ?? 0;

  return (
    <div className="rounded-md border border-zinc-100 bg-zinc-50/50 px-3 py-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <StatusBadge size="sm" {...eventStatusBadge(cls.status)} />
        </div>
        <div className="flex items-center gap-1.5 text-xs text-zinc-500">
          <Users className="w-3 h-3" />
          <span>
            {totalEnrolled} / {plan.maxParticipants}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-3 mt-1.5 text-xs text-zinc-600">
        {cls.schedulingPeriodStartsAt && cls.schedulingPeriodEndsAt && (
          <div className="flex items-center gap-1.5">
            <Calendar className="w-3 h-3 text-zinc-400" />
            <span>
              {formatDateTime(cls.schedulingPeriodStartsAt)} &ndash;{" "}
              {formatDateTime(cls.schedulingPeriodEndsAt)}
            </span>
          </div>
        )}
        <div className="flex items-center gap-1.5 text-zinc-400">
          <Clock className="w-3 h-3" />
          <span>
            {allSlots.length} / {plan.totalSessions} sessions
          </span>
        </div>
      </div>
      {allSlots.length > 0 && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setSessionsExpanded((prev) => !prev)}
            className="flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-700 transition-colors"
          >
            {sessionsExpanded ? (
              <ChevronUp className="w-3 h-3" />
            ) : (
              <ChevronDown className="w-3 h-3" />
            )}
            {sessionsExpanded ? "Hide" : "Show"} sessions
          </button>
          {sessionsExpanded && (
            <div className="mt-1.5 border-t border-zinc-100 pt-1.5">
              <CohortSessionList cls={cls} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function CohortEventList({ plan }: { plan: CohortPlanSchedule }) {
  return (
    <div className="space-y-2">
      {plan.cohorts.map((cls) => (
        <CohortEventCard key={cls.id} cls={cls} plan={plan} />
      ))}
    </div>
  );
}
