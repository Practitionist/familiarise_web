"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
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
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { formatCurrencyAmount } from "@/lib/utils";

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

interface PlanOwner {
  user: { name: string | null; image: string | null };
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
  };
  invitedBy: {
    user: { name: string | null };
  };
}

interface CollaborationsData {
  webinarCollaborations: Collaboration[];
  classCollaborations: Collaboration[];
}

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

function WebinarSchedule({
  plan,
}: {
  plan: NonNullable<Collaboration["webinarPlan"]>;
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

      {plan.webinars.length > 1 && (
        <p className="text-[11px] text-zinc-400">
          +{plan.webinars.length - 1} more event
          {plan.webinars.length > 2 ? "s" : ""}
        </p>
      )}
    </div>
  );
}

function ClassSchedule({
  plan,
}: {
  plan: NonNullable<Collaboration["classPlan"]>;
}) {
  const cls = plan.classes[0];

  if (!cls) {
    return (
      <p className="text-xs text-zinc-400 italic">No classes scheduled yet</p>
    );
  }

  const allSlots = cls.appointments.flatMap((a) => a.slotsOfAppointment);
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
            cls.status === "IN_PROGRESS"
              ? "border-green-300 text-green-700 bg-green-50 text-[11px]"
              : "border-blue-300 text-blue-700 bg-blue-50 text-[11px]"
          }
        >
          {cls.status === "IN_PROGRESS" ? "In Progress" : "Scheduled"}
        </Badge>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-zinc-600">
        {cls.schedulingPeriodStartsAt && cls.schedulingPeriodEndsAt && (
          <div className="flex items-center gap-1.5 col-span-2">
            <Calendar className="w-3 h-3 text-zinc-400" />
            <span>
              {formatDateTime(cls.schedulingPeriodStartsAt)} &ndash;{" "}
              {formatDateTime(cls.schedulingPeriodEndsAt)}
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

      {!cls.schedulingPeriodStartsAt && allSlots.length === 0 && (
        <p className="text-xs text-zinc-400 italic">
          Sessions not yet scheduled
        </p>
      )}
    </div>
  );
}

function ActiveCollaborationCard({
  collab,
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
}) {
  const [expanded, setExpanded] = useState(false);

  const owner =
    collab.planType === "webinar"
      ? collab.webinarPlan?.consultantProfile
      : collab.classPlan?.consultantProfile;

  return (
    <div className="bg-white border border-zinc-200 rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="w-full p-3 flex items-center justify-between text-left hover:bg-zinc-50 transition-colors"
      >
        <div className="min-w-0">
          <p className="text-sm font-medium text-zinc-800 truncate">
            {collab.planTitle}
          </p>
          <p className="text-xs text-zinc-500">
            {collab.role.replace(/_/g, " ")} &middot;{" "}
            {collab.revenueSharePercentage}% share
            {owner?.user.name && (
              <>
                {" "}
                &middot; by {owner.user.name}
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2 ml-3 shrink-0">
          <Badge variant="secondary" className="text-xs">
            {collab.planType === "webinar" ? "Webinar" : "Class"}
          </Badge>
          <Badge
            variant="default"
            className="bg-emerald-50 text-emerald-700 border-emerald-200"
          >
            Active
          </Badge>
          {expanded ? (
            <ChevronUp className="w-4 h-4 text-zinc-400" />
          ) : (
            <ChevronDown className="w-4 h-4 text-zinc-400" />
          )}
        </div>
      </button>

      {expanded && (
        <div className="px-3 pb-3 pt-0">
          <div className="border-t border-zinc-100 pt-3">
            <p className="text-[11px] font-medium text-zinc-500 uppercase tracking-wider mb-2">
              Schedule
            </p>
            {collab.planType === "webinar" && collab.webinarPlan ? (
              <WebinarSchedule plan={collab.webinarPlan} />
            ) : collab.planType === "class" && collab.classPlan ? (
              <ClassSchedule plan={collab.classPlan} />
            ) : (
              <p className="text-xs text-zinc-400 italic">
                No schedule data available
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

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

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-6 h-6 animate-spin text-zinc-400" />
      </div>
    );
  }

  if (allCollaborations.length === 0) {
    return (
      <div className="text-center py-12 text-zinc-500">
        <Inbox className="w-10 h-10 mx-auto mb-3 text-zinc-300" />
        <p className="font-medium">No collaborations</p>
        <p className="text-sm mt-1">
          When another consultant invites you to collaborate, it will appear
          here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Pending invitations */}
      {pending.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-zinc-700 mb-3">
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
                        {collab.role.replace(/_/g, " ")}
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

      {/* Accepted collaborations */}
      {accepted.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-zinc-700 mb-3">
            Active Collaborations ({accepted.length})
          </h3>
          <div className="space-y-2">
            {accepted.map((collab) => (
              <ActiveCollaborationCard key={collab.id} collab={collab} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
