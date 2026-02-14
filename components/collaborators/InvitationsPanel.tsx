"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Check,
  X,
  Loader2,
  Inbox,
  Calendar,
  Clock,
  Users,
  ChevronDown,
  ChevronUp,
  AlertTriangle,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { formatCurrencyAmount } from "@/lib/utils";

// ─── Shared schedule types ───────────────────────────────────────────────────

interface SlotSchedule {
  startsAt: string;
  endsAt: string;
  isTentative: boolean;
  _count: { user: number };
}

interface WebinarEventSchedule {
  id: string;
  status: string;
  appointment: {
    slotsOfAppointment: SlotSchedule[];
  } | null;
}

interface ClassEventSchedule {
  id: string;
  status: string;
  schedulingPeriodStartsAt: string | null;
  schedulingPeriodEndsAt: string | null;
  appointments: {
    slotsOfAppointment: SlotSchedule[];
  }[];
}

// ─── Collaborator perspective types ──────────────────────────────────────────

interface PlanOwner {
  user: { name: string | null; image: string | null };
}

interface PlanCollaboratorInfo {
  id: string;
  role: string;
  revenueSharePercentage: number;
  status: "PENDING" | "ACCEPTED";
  consultantProfile: {
    id: string;
    user: { name: string | null; image: string | null };
  };
}

interface Collaboration {
  id: string;
  role: string;
  revenueSharePercentage: number;
  status: "PENDING" | "ACCEPTED";
  createdAt: string;
  webinarPlan?: {
    id: string;
    title: string;
    price: number;
    durationInHours: number;
    maxParticipants: number;
    language: string | null;
    level: string | null;
    webinars: WebinarEventSchedule[];
    consultantProfile: PlanOwner | null;
    collaborators: PlanCollaboratorInfo[];
  };
  classPlan?: {
    id: string;
    title: string;
    price: number;
    sessionDurationInHours: number;
    maxParticipants: number;
    meetingsPerWeek: number;
    durationInMonths: number;
    totalSessions: number;
    classes: ClassEventSchedule[];
    consultantProfile: PlanOwner | null;
    collaborators: PlanCollaboratorInfo[];
  };
  invitedBy: {
    user: { name: string | null };
  };
}

// ─── Host perspective types ──────────────────────────────────────────────────

interface CollaboratorInfo {
  id: string;
  role: string;
  revenueSharePercentage: number;
  status: "PENDING" | "ACCEPTED";
  consultantProfile: {
    id: string;
    user: { name: string | null; image: string | null };
  };
}

interface HostedWebinarPlan {
  id: string;
  title: string;
  price: number;
  durationInHours: number;
  maxParticipants: number;
  language: string | null;
  level: string | null;
  collaborators: CollaboratorInfo[];
  webinars: WebinarEventSchedule[];
}

interface HostedClassPlan {
  id: string;
  title: string;
  price: number;
  sessionDurationInHours: number;
  maxParticipants: number;
  meetingsPerWeek: number;
  durationInMonths: number;
  totalSessions: number;
  collaborators: CollaboratorInfo[];
  classes: ClassEventSchedule[];
}

// ─── Combined data from API ──────────────────────────────────────────────────

interface CollaborationsData {
  webinarCollaborations: Collaboration[];
  classCollaborations: Collaboration[];
  hostedWebinarPlans: HostedWebinarPlan[];
  hostedClassPlans: HostedClassPlan[];
  hostUser?: { name: string | null; image: string | null };
}

// ─── Formatting helpers ──────────────────────────────────────────────────────

function formatDateTime(dateStr: string) {
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function formatTime(dateStr: string) {
  const d = new Date(dateStr);
  return d.toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

function formatRole(role: string): string {
  const labels: Record<string, string> = {
    CO_HOST: "Co-Host",
    MODERATOR: "Moderator",
    GUEST_SPEAKER: "Guest Speaker",
    TECHNICAL_SUPPORT: "Technical Support",
    CO_INSTRUCTOR: "Co-Instructor",
    TEACHING_ASSISTANT: "TA",
    GUEST_LECTURER: "Guest Lecturer",
    CONTENT_CREATOR: "Content Creator",
  };
  return labels[role] || role.replace(/_/g, " ");
}

// ─── Schedule summary components (shared) ────────────────────────────────────

interface WebinarPlanSchedule {
  durationInHours: number;
  maxParticipants: number;
  webinars: WebinarEventSchedule[];
}

interface ClassPlanSchedule {
  sessionDurationInHours: number;
  maxParticipants: number;
  meetingsPerWeek: number;
  totalSessions: number;
  classes: ClassEventSchedule[];
}

function WebinarScheduleSummary({
  plan,
}: {
  plan: WebinarPlanSchedule;
}) {
  const webinar = plan.webinars[0];
  const slot = webinar?.appointment?.slotsOfAppointment[0];

  if (!webinar) {
    return (
      <p className="text-xs text-zinc-400 italic">No events scheduled yet</p>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <Badge
          variant="outline"
          className={
            webinar.status === "IN_PROGRESS"
              ? "border-green-300 text-green-700 bg-green-50 text-[11px]"
              : "border-blue-300 text-blue-700 bg-blue-50 text-[11px]"
          }
        >
          {webinar.status === "IN_PROGRESS" ? "Live" : "Scheduled"}
        </Badge>
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
              {slot._count.user} / {plan.maxParticipants} participants
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

function WebinarEventList({
  plan,
}: {
  plan: WebinarPlanSchedule;
}) {
  return (
    <div className="space-y-2">
      {plan.webinars.map((webinar) => {
        const slot = webinar.appointment?.slotsOfAppointment[0];
        if (!slot) return null;
        return (
          <div
            key={webinar.id}
            className="rounded-md border border-zinc-100 bg-zinc-50/50 px-3 py-2"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Badge
                  variant="outline"
                  className={
                    webinar.status === "IN_PROGRESS"
                      ? "border-green-300 text-green-700 bg-green-50 text-[10px]"
                      : "border-blue-300 text-blue-700 bg-blue-50 text-[10px]"
                  }
                >
                  {webinar.status === "IN_PROGRESS" ? "Live" : "Scheduled"}
                </Badge>
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
                  {slot._count.user} / {plan.maxParticipants}
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

function ClassScheduleSummary({
  plan,
}: {
  plan: ClassPlanSchedule;
}) {
  if (plan.classes.length === 0) {
    return (
      <p className="text-xs text-zinc-400 italic">No classes scheduled yet</p>
    );
  }

  const activeClass =
    plan.classes.find((c) => c.status === "IN_PROGRESS") ?? plan.classes[0];
  const allSlots = activeClass.appointments.flatMap(
    (a) => a.slotsOfAppointment,
  );
  const now = new Date();
  const upcomingSlots = allSlots.filter((s) => new Date(s.startsAt) > now);
  const nextSlot = upcomingSlots[0];
  const totalEnrolled = allSlots[0]?._count.user ?? 0;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <Badge
          variant="outline"
          className={
            activeClass.status === "IN_PROGRESS"
              ? "border-green-300 text-green-700 bg-green-50 text-[11px]"
              : "border-blue-300 text-blue-700 bg-blue-50 text-[11px]"
          }
        >
          {activeClass.status === "IN_PROGRESS" ? "In Progress" : "Scheduled"}
        </Badge>
        {plan.classes.length > 1 && (
          <span className="text-[11px] text-zinc-400">
            ({plan.classes.length} batches)
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-zinc-600">
        {activeClass.schedulingPeriodStartsAt &&
          activeClass.schedulingPeriodEndsAt && (
            <div className="flex items-center gap-1.5 col-span-2">
              <Calendar className="w-3 h-3 text-zinc-400" />
              <span>
                {formatDateTime(activeClass.schedulingPeriodStartsAt)} &ndash;{" "}
                {formatDateTime(activeClass.schedulingPeriodEndsAt)}
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
            {plan.meetingsPerWeek}x/week
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

      {!activeClass.schedulingPeriodStartsAt && allSlots.length === 0 && (
        <p className="text-xs text-zinc-400 italic">
          Sessions not yet scheduled
        </p>
      )}
    </div>
  );
}

function ClassSessionList({ cls }: { cls: ClassEventSchedule }) {
  const allSlots = cls.appointments.flatMap((a) => a.slotsOfAppointment);
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
              <span>{slot._count.user}</span>
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

function ClassEventCard({ cls, plan }: {
  cls: ClassEventSchedule;
  plan: ClassPlanSchedule;
}) {
  const [sessionsExpanded, setSessionsExpanded] = useState(false);
  const allSlots = cls.appointments.flatMap((a) => a.slotsOfAppointment);
  const totalEnrolled = allSlots[0]?._count.user ?? 0;

  return (
    <div className="rounded-md border border-zinc-100 bg-zinc-50/50 px-3 py-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Badge
            variant="outline"
            className={
              cls.status === "IN_PROGRESS"
                ? "border-green-300 text-green-700 bg-green-50 text-[10px]"
                : "border-blue-300 text-blue-700 bg-blue-50 text-[10px]"
            }
          >
            {cls.status === "IN_PROGRESS" ? "In Progress" : "Scheduled"}
          </Badge>
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
              <ClassSessionList cls={cls} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ClassEventList({
  plan,
}: {
  plan: ClassPlanSchedule;
}) {
  return (
    <div className="space-y-2">
      {plan.classes.map((cls) => (
        <ClassEventCard key={cls.id} cls={cls} plan={plan} />
      ))}
    </div>
  );
}

// ─── Collaborator perspective card ───────────────────────────────────────────

function ActiveCollaborationCard({
  collab,
  currentUser,
}: {
  collab: {
    id: string;
    role: string;
    revenueSharePercentage: number;
    planType: "webinar" | "class";
    planTitle: string;
    invitedBy: { user: { name: string | null } };
    webinarPlan?: Collaboration["webinarPlan"];
    classPlan?: Collaboration["classPlan"];
  };
  currentUser?: { name: string | null; image: string | null };
}) {
  const [slotsExpanded, setSlotsExpanded] = useState(false);

  const owner =
    collab.planType === "webinar"
      ? collab.webinarPlan?.consultantProfile
      : collab.classPlan?.consultantProfile;

  // Filter out the current user from the collaborators list (they're shown in the banner)
  const allCollaboratorsOnPlan = (
    collab.planType === "webinar"
      ? collab.webinarPlan?.collaborators
      : collab.classPlan?.collaborators
  ) ?? [];
  const otherCollaborators = allCollaboratorsOnPlan.filter(
    (c) => c.id !== collab.id,
  );

  const hasExpandableDetails =
    (collab.planType === "webinar" &&
      collab.webinarPlan &&
      collab.webinarPlan.webinars.length > 1) ||
    (collab.planType === "class" &&
      collab.classPlan &&
      collab.classPlan.classes.length > 1);

  return (
    <div className="bg-white border border-zinc-200 rounded-lg overflow-hidden">
      {/* Role banner */}
      <div className="bg-purple-600 px-3 py-1.5 flex items-center justify-between">
        <span className="text-xs font-semibold text-white tracking-wide uppercase">{formatRole(collab.role)}</span>
        <Badge variant="secondary" className="text-[10px] bg-purple-500 text-purple-100 border-purple-400">
          {collab.planType === "webinar" ? "Webinar" : "Class"}
        </Badge>
      </div>

      <div className="p-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="min-w-0">
          <p className="text-sm font-medium text-zinc-800 truncate">
            {collab.planTitle}
          </p>
          <p className="text-xs text-zinc-500">
            by {owner?.user.name ?? "Unknown"}
          </p>
        </div>
      </div>

      {/* Revenue share */}
      <div className="flex items-center gap-2 mt-2 px-2 py-1.5 bg-zinc-50 rounded-md border border-zinc-100">
        <div className="flex items-center gap-1.5 text-xs text-zinc-600">
          {currentUser && (
            <Avatar className="w-5 h-5">
              <AvatarImage src={currentUser.image ?? undefined} />
              <AvatarFallback className="text-[8px]">
                {(currentUser.name ?? "Y").charAt(0)}
              </AvatarFallback>
            </Avatar>
          )}
          <span className="font-medium">You {collab.revenueSharePercentage}%</span>
          {owner && (
            <span>&middot; {owner.user.name} {100 - collab.revenueSharePercentage}%</span>
          )}
        </div>
      </div>

      {/* Team — host + other collaborators (excludes self) */}
      <div className="border-t border-zinc-100 mt-3 pt-3">
        <p className="text-[11px] font-medium text-zinc-500 uppercase tracking-wider mb-2">
          Team ({1 + otherCollaborators.length})
        </p>
        <div className="space-y-2">
          {/* Host (plan owner) */}
          {owner && (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <Avatar className="w-7 h-7">
                  <AvatarImage src={owner.user.image ?? undefined} />
                  <AvatarFallback className="text-[10px]">
                    {(owner.user.name ?? "H").charAt(0)}
                  </AvatarFallback>
                </Avatar>
                <div>
                  <p className="text-xs font-medium text-zinc-800">
                    {owner.user.name ?? "Unknown"}
                  </p>
                  <p className="text-[11px] text-zinc-500">
                    Host &middot; {100 - allCollaboratorsOnPlan.reduce((sum, c) => sum + c.revenueSharePercentage, 0)}% share
                  </p>
                </div>
              </div>
              <Badge
                variant="default"
                className="bg-zinc-100 text-zinc-700 border-zinc-200 text-[10px]"
              >
                Owner
              </Badge>
            </div>
          )}
          {/* Other collaborators (not the current user) */}
          {otherCollaborators.map((c) => (
            <div
              key={c.id}
              className="flex items-center justify-between"
            >
              <div className="flex items-center gap-2.5">
                <Avatar className="w-7 h-7">
                  <AvatarImage
                    src={c.consultantProfile.user.image ?? undefined}
                  />
                  <AvatarFallback className="text-[10px]">
                    {(c.consultantProfile.user.name ?? "?").charAt(0)}
                  </AvatarFallback>
                </Avatar>
                <div>
                  <p className="text-xs font-medium text-zinc-800">
                    {c.consultantProfile.user.name ?? "Unknown"}
                  </p>
                  <p className="text-[11px] text-zinc-500">
                    {formatRole(c.role)} &middot; {c.revenueSharePercentage}% share
                  </p>
                </div>
              </div>
              <Badge
                variant={c.status === "ACCEPTED" ? "default" : "secondary"}
                className={
                  c.status === "ACCEPTED"
                    ? "bg-emerald-50 text-emerald-700 border-emerald-200 text-[10px]"
                    : "text-[10px]"
                }
              >
                {c.status === "ACCEPTED" ? "Accepted" : "Pending"}
              </Badge>
            </div>
          ))}
        </div>
      </div>

      {/* Schedule summary */}
      <div className="border-t border-zinc-100 mt-3 pt-3">
        <p className="text-[11px] font-medium text-zinc-500 uppercase tracking-wider mb-2">
          Schedule
        </p>
        {collab.planType === "webinar" && collab.webinarPlan ? (
          <WebinarScheduleSummary plan={collab.webinarPlan} />
        ) : collab.planType === "class" && collab.classPlan ? (
          <ClassScheduleSummary plan={collab.classPlan} />
        ) : (
          <p className="text-xs text-zinc-400 italic">
            No schedule data available
          </p>
        )}
      </div>

      {/* All events — collapsible */}
      {hasExpandableDetails && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setSlotsExpanded((prev) => !prev)}
            className="flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-700 transition-colors"
          >
            {slotsExpanded ? (
              <ChevronUp className="w-3 h-3" />
            ) : (
              <ChevronDown className="w-3 h-3" />
            )}
            {slotsExpanded ? "Hide" : "Show"} all events
          </button>
          {slotsExpanded && (
            <div className="mt-2 border-t border-zinc-100 pt-2">
              {collab.planType === "webinar" && collab.webinarPlan ? (
                <WebinarEventList plan={collab.webinarPlan} />
              ) : collab.planType === "class" && collab.classPlan ? (
                <ClassEventList plan={collab.classPlan} />
              ) : null}
            </div>
          )}
        </div>
      )}
      </div>
    </div>
  );
}

// ─── Host perspective card ───────────────────────────────────────────────────

function HostedPlanCard({
  plan,
  hostUser,
}: {
  plan: {
    planType: "webinar" | "class";
    title: string;
    price: number;
    collaborators: CollaboratorInfo[];
    webinarPlan?: HostedWebinarPlan;
    classPlan?: HostedClassPlan;
  };
  hostUser?: { name: string | null; image: string | null };
}) {
  const [eventsExpanded, setEventsExpanded] = useState(false);

  const totalCollabShare = plan.collaborators
    .filter((c) => c.status === "PENDING" || c.status === "ACCEPTED")
    .reduce((sum, c) => sum + c.revenueSharePercentage, 0);
  const hostShare = 100 - totalCollabShare;

  const pendingCollabs = plan.collaborators.filter((c) => c.status === "PENDING");
  const acceptedCollabs = plan.collaborators.filter((c) => c.status === "ACCEPTED");

  const hasExpandableDetails =
    (plan.planType === "webinar" &&
      plan.webinarPlan &&
      plan.webinarPlan.webinars.length > 1) ||
    (plan.planType === "class" &&
      plan.classPlan &&
      plan.classPlan.classes.length > 1);

  return (
    <div className="bg-white border border-zinc-200 rounded-lg overflow-hidden">
      {/* Role banner */}
      <div className="bg-zinc-800 px-3 py-1.5 flex items-center justify-between">
        <span className="text-xs font-semibold text-white tracking-wide uppercase">Host</span>
        <Badge variant="secondary" className="text-[10px] bg-zinc-700 text-zinc-200 border-zinc-600">
          {plan.planType === "webinar" ? "Webinar" : "Class"}
        </Badge>
      </div>

      <div className="p-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="min-w-0">
          <p className="text-sm font-medium text-zinc-800 truncate">
            {plan.title}
          </p>
          {plan.price > 0 && (
            <p className="text-xs text-zinc-500">
              {formatCurrencyAmount(plan.price, "INR")}
            </p>
          )}
        </div>
      </div>

      {/* Revenue split */}
      <div className="flex items-center gap-2 mt-2 px-2 py-1.5 bg-zinc-50 rounded-md border border-zinc-100">
        <div className="flex items-center gap-1.5 text-xs text-zinc-600">
          {hostUser && (
            <Avatar className="w-5 h-5">
              <AvatarImage src={hostUser.image ?? undefined} />
              <AvatarFallback className="text-[8px]">
                {(hostUser.name ?? "H").charAt(0)}
              </AvatarFallback>
            </Avatar>
          )}
          <span className="font-medium">You {hostShare}%</span>
          <span>&middot; Collaborators {totalCollabShare}%</span>
        </div>
      </div>

      {/* Collaborators list */}
      <div className="border-t border-zinc-100 mt-3 pt-3">
        <p className="text-[11px] font-medium text-zinc-500 uppercase tracking-wider mb-2">
          Collaborators ({plan.collaborators.length})
        </p>
        <div className="space-y-2">
          {acceptedCollabs.map((collab) => (
            <div
              key={collab.id}
              className="flex items-center justify-between"
            >
              <div className="flex items-center gap-2.5">
                <Avatar className="w-7 h-7">
                  <AvatarImage
                    src={collab.consultantProfile.user.image ?? undefined}
                  />
                  <AvatarFallback className="text-[10px]">
                    {(collab.consultantProfile.user.name ?? "?").charAt(0)}
                  </AvatarFallback>
                </Avatar>
                <div>
                  <p className="text-xs font-medium text-zinc-800">
                    {collab.consultantProfile.user.name ?? "Unknown"}
                  </p>
                  <p className="text-[11px] text-zinc-500">
                    {formatRole(collab.role)} &middot; {collab.revenueSharePercentage}% share
                  </p>
                </div>
              </div>
              <Badge
                variant="default"
                className="bg-emerald-50 text-emerald-700 border-emerald-200 text-[10px]"
              >
                Accepted
              </Badge>
            </div>
          ))}
          {pendingCollabs.map((collab) => (
            <div
              key={collab.id}
              className="flex items-center justify-between"
            >
              <div className="flex items-center gap-2.5">
                <Avatar className="w-7 h-7">
                  <AvatarImage
                    src={collab.consultantProfile.user.image ?? undefined}
                  />
                  <AvatarFallback className="text-[10px]">
                    {(collab.consultantProfile.user.name ?? "?").charAt(0)}
                  </AvatarFallback>
                </Avatar>
                <div>
                  <p className="text-xs font-medium text-zinc-800">
                    {collab.consultantProfile.user.name ?? "Unknown"}
                  </p>
                  <p className="text-[11px] text-zinc-500">
                    {formatRole(collab.role)} &middot; {collab.revenueSharePercentage}% share
                  </p>
                </div>
              </div>
              <Badge
                variant="secondary"
                className="text-[10px]"
              >
                Pending
              </Badge>
            </div>
          ))}
        </div>
      </div>

      {/* Schedule summary */}
      <div className="border-t border-zinc-100 mt-3 pt-3">
        <p className="text-[11px] font-medium text-zinc-500 uppercase tracking-wider mb-2">
          Schedule
        </p>
        {plan.planType === "webinar" && plan.webinarPlan ? (
          <WebinarScheduleSummary plan={plan.webinarPlan} />
        ) : plan.planType === "class" && plan.classPlan ? (
          <ClassScheduleSummary plan={plan.classPlan} />
        ) : (
          <p className="text-xs text-zinc-400 italic">
            No schedule data available
          </p>
        )}
      </div>

      {/* All events — collapsible */}
      {hasExpandableDetails && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setEventsExpanded((prev) => !prev)}
            className="flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-700 transition-colors"
          >
            {eventsExpanded ? (
              <ChevronUp className="w-3 h-3" />
            ) : (
              <ChevronDown className="w-3 h-3" />
            )}
            {eventsExpanded ? "Hide" : "Show"} all events
          </button>
          {eventsExpanded && (
            <div className="mt-2 border-t border-zinc-100 pt-2">
              {plan.planType === "webinar" && plan.webinarPlan ? (
                <WebinarEventList plan={plan.webinarPlan} />
              ) : plan.planType === "class" && plan.classPlan ? (
                <ClassEventList plan={plan.classPlan} />
              ) : null}
            </div>
          )}
        </div>
      )}
      </div>
    </div>
  );
}

// ─── Main component ──────────────────────────────────────────────────────────

export function InvitationsPanel() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery<CollaborationsData>({
    queryKey: ["my-collaborations"],
    queryFn: async () => {
      const res = await fetch("/api/collaborations");
      if (!res.ok) throw new Error("Failed to fetch collaborations");
      const json = await res.json();
      return json.data;
    },
    staleTime: 30_000,
  });

  const respondMutation = useMutation({
    mutationFn: async ({
      id,
      planType,
      response,
    }: {
      id: string;
      planType: "webinar" | "class";
      response: "ACCEPTED" | "DECLINED";
    }) => {
      const res = await fetch(`/api/collaborations/${id}/respond`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response, planType }),
      });
      if (!res.ok) throw new Error("Failed to respond");
      return res.json();
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ["my-collaborations"] });
      toast({
        title:
          variables.response === "ACCEPTED"
            ? "Invitation accepted"
            : "Invitation declined",
      });
    },
    onError: () => {
      toast({
        title: "Failed to respond to invitation",
        variant: "destructive",
      });
    },
  });

  // ── Collaborator perspective data ──
  const allCollaborations = [
    ...(data?.webinarCollaborations.map((c) => ({
      ...c,
      planType: "webinar" as const,
      planTitle: c.webinarPlan?.title ?? "Webinar",
      planPrice: c.webinarPlan?.price ?? 0,
    })) ?? []),
    ...(data?.classCollaborations.map((c) => ({
      ...c,
      planType: "class" as const,
      planTitle: c.classPlan?.title ?? "Class",
      planPrice: c.classPlan?.price ?? 0,
    })) ?? []),
  ];

  const pending = allCollaborations.filter((c) => c.status === "PENDING");
  const accepted = allCollaborations.filter((c) => c.status === "ACCEPTED");

  // ── Host perspective data ──
  const hostedPlans = [
    ...(data?.hostedWebinarPlans?.map((p) => ({
      planType: "webinar" as const,
      title: p.title,
      price: p.price,
      collaborators: p.collaborators,
      webinarPlan: p,
      classPlan: undefined as HostedClassPlan | undefined,
    })) ?? []),
    ...(data?.hostedClassPlans?.map((p) => ({
      planType: "class" as const,
      title: p.title,
      price: p.price,
      collaborators: p.collaborators,
      webinarPlan: undefined as HostedWebinarPlan | undefined,
      classPlan: p,
    })) ?? []),
  ];

  const hasAnyData = allCollaborations.length > 0 || hostedPlans.length > 0;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-6 h-6 animate-spin text-zinc-400" />
      </div>
    );
  }

  if (!hasAnyData) {
    return (
      <div className="text-center py-12 text-zinc-500">
        <Inbox className="w-10 h-10 mx-auto mb-3 text-zinc-300" />
        <p className="font-medium">No collaborations</p>
        <p className="text-sm mt-1">
          When you invite collaborators to your plans or another consultant
          invites you, it will appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* ── Host section: My Plans with Collaborators ── */}
      {hostedPlans.length > 0 && (
        <div>
          <h3 className="text-base font-semibold text-zinc-700 mb-3">
            My Plans with Collaborators ({hostedPlans.length})
          </h3>
          <div className="space-y-2">
            {hostedPlans.map((plan) => (
              <HostedPlanCard
                key={`${plan.planType}-${plan.webinarPlan?.id ?? plan.classPlan?.id}`}
                plan={plan}
                hostUser={data?.hostUser}
              />
            ))}
          </div>
        </div>
      )}

      {/* ── Collaborator section: Pending Invitations ── */}
      {pending.length > 0 && (
        <div>
          <h3 className="text-base font-semibold text-zinc-700 mb-3">
            Pending Invitations ({pending.length})
          </h3>
          <div className="space-y-3">
            {pending.map((collab) => (
              <div
                key={collab.id}
                className="p-4 bg-amber-50 border border-amber-200 rounded-lg"
              >
                <div className="flex items-start justify-between">
                  <div>
                    <p className="font-medium text-zinc-800">
                      {collab.planTitle}
                    </p>
                    <p className="text-sm text-zinc-600 mt-0.5">
                      Invited by{" "}
                      <span className="font-medium">
                        {collab.invitedBy.user.name ?? "Unknown"}
                      </span>
                    </p>
                    <div className="flex items-center gap-2 mt-2">
                      <Badge variant="secondary" className="text-xs">
                        {collab.planType === "webinar" ? "Webinar" : "Class"}
                      </Badge>
                      <Badge variant="outline" className="text-xs">
                        {formatRole(collab.role)}
                      </Badge>
                      <span className="text-xs text-zinc-500">
                        {collab.revenueSharePercentage}% revenue share
                      </span>
                      {collab.planPrice > 0 && (
                        <span className="text-xs text-zinc-500">
                          &middot; Plan price{" "}
                          {formatCurrencyAmount(collab.planPrice, "INR")}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 mt-2 text-xs text-amber-700">
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                      <span>
                        You won&apos;t earn from purchases made before you
                        accept the collaborations request.
                      </span>
                    </div>
                  </div>
                  <div className="flex gap-2 ml-4">
                    <Button
                      size="sm"
                      variant="default"
                      onClick={() =>
                        respondMutation.mutate({
                          id: collab.id,
                          planType: collab.planType,
                          response: "ACCEPTED",
                        })
                      }
                      disabled={respondMutation.isPending}
                    >
                      <Check className="w-3.5 h-3.5 mr-1" />
                      Accept
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        respondMutation.mutate({
                          id: collab.id,
                          planType: collab.planType,
                          response: "DECLINED",
                        })
                      }
                      disabled={respondMutation.isPending}
                    >
                      <X className="w-3.5 h-3.5 mr-1" />
                      Decline
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Collaborator section: Active Collaborations ── */}
      {accepted.length > 0 && (
        <div>
          <h3 className="text-base font-semibold text-zinc-700 mb-3">
            Active Collaborations ({accepted.length})
          </h3>
          <div className="space-y-2">
            {accepted.map((collab) => (
              <ActiveCollaborationCard key={collab.id} collab={collab} currentUser={data?.hostUser} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
