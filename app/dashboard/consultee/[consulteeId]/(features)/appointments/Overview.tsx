"use client";

import { Button } from "@/components/ui/button";
import {
  TClassWithPlan,
  TConsultationWithPlan,
  TSubscriptionWithPlan,
  TWebinarWithPlan,
  TTrialWithPlan,
} from "@/hooks/useEvents";
import {
  getActualSlots,
  getAllSlots,
} from "../../utils/scheduleHelpers";
import { OneOffEventCard } from "./components/OneOffEventCard";
import { MultiSessionEventCard } from "./components/MultiSessionEventCard";
import type { SlotOfAppointment } from "@prisma/client";
import type { TAppointment } from "@/types/appointment";
import type { SlotWithMeetingSession } from "./types";
import React, { useRef, useState, useEffect, useCallback } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Calendar,
  Video,
  Users,
  BookOpen,
} from "lucide-react";
import { motion } from "framer-motion";
import type { BookingStatus } from "@/components/ui/waitlist-status-badge";

interface OverviewProps {
  consultations: TConsultationWithPlan[];
  subscriptions: TSubscriptionWithPlan[];
  webinars: TWebinarWithPlan[];
  classes: TClassWithPlan[];
  trials: TTrialWithPlan[];
}

interface CollaboratorInfo {
  name: string;
  image?: string | null;
  role: string;
}

interface DashboardCardProps {
  title: string;
  icon: typeof Calendar;
  accentColor: string;
  itemCount: number;
  children: React.ReactNode;
}

// Extract collaborators from a webinar or class plan
function extractCollaborators(
  plan: Record<string, unknown>,
): CollaboratorInfo[] {
  const collaborators = plan?.collaborators;
  if (!Array.isArray(collaborators)) return [];
  return collaborators.map(
    (c: {
      consultantProfile?: { user?: { name?: string; image?: string | null } };
      role: string;
    }) => ({
      name: c.consultantProfile?.user?.name ?? "Collaborator",
      image: c.consultantProfile?.user?.image ?? null,
      role: c.role ?? "",
    }),
  );
}

// Helper to check if a status is inactive (greyed out)
function isInactiveStatus(status: string): boolean {
  const inactive = ["cancelled", "rejected", "completed", "expired"];
  return inactive.includes(status.toLowerCase());
}

// Sort items: active first, then inactive. Within each group, sort chronologically
function sortByStatusAndTime<
  T extends { status: string; firstSlotTime?: number },
>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const aInactive = isInactiveStatus(a.status);
    const bInactive = isInactiveStatus(b.status);
    if (aInactive !== bInactive) return aInactive ? 1 : -1;
    return (a.firstSlotTime ?? Infinity) - (b.firstSlotTime ?? Infinity);
  });
}

const fadeInUp = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.4 } },
};

export function Overview({
  consultations,
  subscriptions,
  classes,
  webinars,
  trials,
}: Readonly<OverviewProps>) {
  // Prepare sorted consultation items
  const sortedConsultations = sortByStatusAndTime(
    consultations.map((c) => ({
      data: c,
      status: c.requestStatus.toString(),
      firstSlotTime: c.appointment?.slotsOfAppointment?.[0]
        ? new Date(c.appointment.slotsOfAppointment[0].startsAt).getTime()
        : Infinity,
    })),
  );

  // Prepare sorted subscription + trial items
  const subItems = subscriptions.map((s) => ({
    kind: "subscription" as const,
    data: s,
    status: s.requestStatus.toString(),
    firstSlotTime: s.appointments?.[0]?.slotsOfAppointment?.[0]
      ? new Date(s.appointments[0].slotsOfAppointment[0].startsAt).getTime()
      : Infinity,
  }));
  const trialItems = trials.map((t) => ({
    kind: "trial" as const,
    data: t,
    status: t.status,
    firstSlotTime: t.appointment?.slotsOfAppointment?.[0]
      ? new Date(t.appointment.slotsOfAppointment[0].startsAt).getTime()
      : Infinity,
  }));
  const sortedSubsAndTrials = sortByStatusAndTime([
    ...subItems,
    ...trialItems,
  ]);

  // Prepare sorted webinar items
  const sortedWebinars = sortByStatusAndTime(
    webinars.map((w) => ({
      data: w,
      status: w.status.toString(),
      firstSlotTime: w.appointment?.slotsOfAppointment?.[0]
        ? new Date(w.appointment.slotsOfAppointment[0].startsAt).getTime()
        : Infinity,
    })),
  );

  // Prepare sorted class items
  const sortedClasses = sortByStatusAndTime(
    classes.map((c) => ({
      data: c,
      status: c.status.toString(),
      firstSlotTime: c.appointments?.[0]?.slotsOfAppointment?.[0]
        ? new Date(c.appointments[0].slotsOfAppointment[0].startsAt).getTime()
        : Infinity,
    })),
  );

  return (
    <motion.div
      initial="hidden"
      animate="visible"
      className="space-y-8"
      data-testid="overview-grid"
    >
      {/* Consultations */}
      <motion.div variants={fadeInUp}>
        <DashboardCard
          title="Consultations"
          icon={Video}
          accentColor="blue"
          itemCount={sortedConsultations.length}
        >
          {sortedConsultations.map(({ data: consultation }) => {
            const rawSlots = getActualSlots({
              ...consultation,
              type: "Consultation",
            });
            const nextSlot = rawSlots[0];
            return (
              <div key={consultation.id} className="flex-shrink-0 w-[300px]">
                <OneOffEventCard
                  title={consultation.consultationPlan.title}
                  consultant={
                    consultation.consultationPlan.consultantProfile?.user
                      ?.name ?? "Unknown Consultant"
                  }
                  image={
                    consultation.consultationPlan.consultantProfile?.user?.image
                  }
                  status={consultation.requestStatus.toString()}
                  type="Consultation"
                  isTentative={nextSlot?.isTentative ?? false}
                  appointmentId={consultation.appointment?.id}
                  appointment={
                    consultation.appointment as TAppointment | undefined
                  }
                  rawSlots={rawSlots}
                  pendingPaymentUrl={consultation.pendingPaymentUrl}
                />
              </div>
            );
          })}
        </DashboardCard>
      </motion.div>

      {/* Subscriptions + Trials */}
      <motion.div variants={fadeInUp}>
        <DashboardCard
          title="Subscriptions"
          icon={Calendar}
          accentColor="violet"
          itemCount={sortedSubsAndTrials.length}
        >
          {sortedSubsAndTrials.map((item) => {
            if (item.kind === "trial") {
              const trial = item.data;
              const rawSlots = (trial.appointment?.slotsOfAppointment ??
                []) as SlotOfAppointment[];
              const firstSlot = rawSlots[0];
              return (
                <div key={trial.id} className="flex-shrink-0 w-[300px]">
                  <OneOffEventCard
                    title={trial.subscriptionPlan.title}
                    consultant={
                      trial.subscriptionPlan.consultantProfile?.user?.name ??
                      "Unknown Consultant"
                    }
                    image={
                      trial.subscriptionPlan.consultantProfile?.user?.image
                    }
                    status={trial.status}
                    type="Trial"
                    isTentative={firstSlot?.isTentative ?? false}
                    appointmentId={trial.appointment?.id}
                    appointment={
                      trial.appointment as TAppointment | undefined
                    }
                    rawSlots={rawSlots}
                  />
                </div>
              );
            }

            const subscription = item.data;
            const rawSlots = getActualSlots({
              ...subscription,
              type: "Subscription",
            });
            const allSlotsData = getAllSlots({
              ...subscription,
              type: "Subscription",
            }) as SlotWithMeetingSession[];
            const nextSlot = rawSlots[0];
            return (
              <div key={subscription.id} className="flex-shrink-0 w-[300px]">
                <MultiSessionEventCard
                  title={subscription.subscriptionPlan.title}
                  consultant={
                    subscription.subscriptionPlan.consultantProfile?.user
                      ?.name ?? "Unknown Consultant"
                  }
                  image={
                    subscription.subscriptionPlan.consultantProfile?.user?.image
                  }
                  status={subscription.requestStatus.toString()}
                  type="Subscription"
                  isTentative={nextSlot?.isTentative ?? false}
                  appointmentId={subscription.appointments?.[0]?.id}
                  appointment={
                    subscription.appointments?.[0] as
                      | TAppointment
                      | undefined
                  }
                  rawSlots={rawSlots}
                  allSlots={allSlotsData}
                  pendingPaymentUrl={subscription.pendingPaymentUrl}
                />
              </div>
            );
          })}
        </DashboardCard>
      </motion.div>

      {/* Webinars */}
      <motion.div variants={fadeInUp}>
        <DashboardCard
          title="Webinars"
          icon={Users}
          accentColor="amber"
          itemCount={sortedWebinars.length}
        >
          {sortedWebinars.map(({ data: webinar }) => {
            const rawSlots = getActualSlots({
              ...webinar,
              type: "Webinar",
            });
            const nextSlot = rawSlots[0];

            const hasConfirmedSlot =
              (webinar.appointment?.slotsOfAppointment?.length ?? 0) > 0;
            const waitlistEntry = webinar.waitlist?.[0];

            let bookingStatus: BookingStatus = null;
            let waitlistPosition: number | undefined;
            if (hasConfirmedSlot) {
              bookingStatus = "CONFIRMED";
            } else if (waitlistEntry) {
              if (waitlistEntry.status === "NOTIFIED") {
                bookingStatus = "NOTIFIED";
              } else if (waitlistEntry.status === "WAITING") {
                bookingStatus = "WAITLISTED";
                waitlistPosition = waitlistEntry.position ?? undefined;
              }
            }

            const collaborators = extractCollaborators(
              webinar.webinarPlan as unknown as Record<string, unknown>,
            );

            return (
              <div key={webinar.id} className="flex-shrink-0 w-[300px]">
                <OneOffEventCard
                  title={webinar.webinarPlan.title}
                  consultant={
                    webinar.webinarPlan.consultantProfile?.user?.name ??
                    "Unknown Consultant"
                  }
                  image={webinar.webinarPlan.consultantProfile?.user?.image}
                  status={webinar.status.toString()}
                  type="Webinar"
                  isTentative={nextSlot?.isTentative ?? false}
                  appointmentId={webinar.appointment?.id}
                  appointment={
                    webinar.appointment as TAppointment | undefined
                  }
                  rawSlots={rawSlots}
                  bookingStatus={bookingStatus}
                  waitlistPosition={waitlistPosition}
                  collaborators={collaborators}
                />
              </div>
            );
          })}
        </DashboardCard>
      </motion.div>

      {/* Classes */}
      <motion.div variants={fadeInUp}>
        <DashboardCard
          title="Classes"
          icon={BookOpen}
          accentColor="emerald"
          itemCount={sortedClasses.length}
        >
          {sortedClasses.map(({ data: classItem }) => {
            const rawSlots = getActualSlots({
              ...classItem,
              type: "Class",
            });
            const allSlotsData = getAllSlots({
              ...classItem,
              type: "Class",
            }) as SlotWithMeetingSession[];
            const nextSlot = rawSlots[0];

            const hasConfirmedSlot =
              classItem.appointments?.some(
                (a) => (a.slotsOfAppointment?.length ?? 0) > 0,
              ) ?? false;
            const waitlistEntry = classItem.waitlist?.[0];

            let bookingStatus: BookingStatus = null;
            let waitlistPosition: number | undefined;
            if (hasConfirmedSlot) {
              bookingStatus = "CONFIRMED";
            } else if (waitlistEntry) {
              if (waitlistEntry.status === "NOTIFIED") {
                bookingStatus = "NOTIFIED";
              } else if (waitlistEntry.status === "WAITING") {
                bookingStatus = "WAITLISTED";
                waitlistPosition = waitlistEntry.position ?? undefined;
              }
            }

            const collaborators = extractCollaborators(
              classItem.classPlan as unknown as Record<string, unknown>,
            );

            return (
              <div key={classItem.id} className="flex-shrink-0 w-[300px]">
                <MultiSessionEventCard
                  title={classItem.classPlan.title}
                  consultant={
                    classItem.classPlan.consultantProfile?.user?.name ??
                    "Unknown Consultant"
                  }
                  image={classItem.classPlan.consultantProfile?.user?.image}
                  status={classItem.status.toString()}
                  type="Class"
                  isTentative={nextSlot?.isTentative ?? false}
                  appointmentId={classItem.appointments?.[0]?.id}
                  appointment={
                    classItem.appointments?.[0] as TAppointment | undefined
                  }
                  rawSlots={rawSlots}
                  allSlots={allSlotsData}
                  bookingStatus={bookingStatus}
                  waitlistPosition={waitlistPosition}
                  collaborators={collaborators}
                />
              </div>
            );
          })}
        </DashboardCard>
      </motion.div>
    </motion.div>
  );
}

function DashboardCard({
  title,
  icon: Icon,
  accentColor,
  itemCount,
  children,
}: Readonly<DashboardCardProps>) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

  const SCROLL_AMOUNT = 320;

  const accentStyles: Record<
    string,
    { bg: string; text: string; border: string }
  > = {
    blue: {
      bg: "bg-blue-50",
      text: "text-blue-600",
      border: "border-blue-100",
    },
    violet: {
      bg: "bg-violet-50",
      text: "text-violet-600",
      border: "border-violet-100",
    },
    amber: {
      bg: "bg-amber-50",
      text: "text-amber-600",
      border: "border-amber-100",
    },
    emerald: {
      bg: "bg-emerald-50",
      text: "text-emerald-600",
      border: "border-emerald-100",
    },
    rose: {
      bg: "bg-rose-50",
      text: "text-rose-600",
      border: "border-rose-100",
    },
  };

  const accent = accentStyles[accentColor] || accentStyles.blue;

  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 1024);
    };

    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  const updateScrollButtonStates = useCallback(() => {
    if (scrollContainerRef.current && !isMobile) {
      const { scrollLeft, scrollWidth, clientWidth } =
        scrollContainerRef.current;
      setCanScrollLeft(scrollLeft > 5);
      setCanScrollRight(scrollLeft < scrollWidth - clientWidth - 5);
    }
  }, [isMobile]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || itemCount === 0 || isMobile) {
      setCanScrollLeft(false);
      setCanScrollRight(false);
      return;
    }

    updateScrollButtonStates();

    container.addEventListener("scroll", updateScrollButtonStates, {
      passive: true,
    });
    window.addEventListener("resize", updateScrollButtonStates);

    const observer = new MutationObserver(updateScrollButtonStates);
    observer.observe(container, { childList: true, subtree: true });

    return () => {
      container.removeEventListener("scroll", updateScrollButtonStates);
      window.removeEventListener("resize", updateScrollButtonStates);
      observer.disconnect();
    };
  }, [itemCount, updateScrollButtonStates, isMobile]);

  const handleScroll = (direction: "left" | "right") => {
    if (scrollContainerRef.current && !isMobile) {
      const currentScroll = scrollContainerRef.current.scrollLeft;
      const newScroll =
        direction === "left"
          ? currentScroll - SCROLL_AMOUNT
          : currentScroll + SCROLL_AMOUNT;

      scrollContainerRef.current.scrollTo({
        left: newScroll,
        behavior: "smooth",
      });

      setTimeout(updateScrollButtonStates, 300);
    }
  };

  if (!itemCount) {
    return (
      <div className="bg-white rounded-2xl border border-zinc-200 shadow-sm overflow-hidden">
        <div className="flex items-center gap-3 px-6 py-4 border-b border-zinc-100">
          <div
            className={`h-9 w-9 rounded-xl ${accent.bg} flex items-center justify-center`}
          >
            <Icon className={`h-5 w-5 ${accent.text}`} />
          </div>
          <h2 className="font-semibold text-zinc-900 text-lg">{title}</h2>
        </div>
        <div className="flex items-center justify-center py-16">
          <div className="text-center">
            <div className="h-12 w-12 rounded-xl bg-zinc-100 flex items-center justify-center mx-auto mb-4">
              <Icon className="h-6 w-6 text-zinc-400" />
            </div>
            <p className="text-zinc-600 font-medium mb-1">
              No {title.toLowerCase()} found
            </p>
            <p className="text-sm text-zinc-400">
              Your {title.toLowerCase()} will appear here once scheduled
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-2xl border border-zinc-200 shadow-sm overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-100">
        <div className="flex items-center gap-3">
          <div
            className={`h-9 w-9 rounded-xl ${accent.bg} flex items-center justify-center`}
          >
            <Icon className={`h-5 w-5 ${accent.text}`} />
          </div>
          <h2 className="font-semibold text-zinc-900 text-lg">{title}</h2>
          <span className="text-sm text-zinc-400 font-medium">
            {itemCount} {itemCount === 1 ? "item" : "items"}
          </span>
        </div>

        {/* Scroll Buttons */}
        {!isMobile && (canScrollLeft || canScrollRight) && (
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="icon"
              onClick={() => handleScroll("left")}
              disabled={!canScrollLeft}
              className="h-8 w-8 rounded-lg border-zinc-200 disabled:opacity-30"
              aria-label="Scroll left"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              onClick={() => handleScroll("right")}
              disabled={!canScrollRight}
              className="h-8 w-8 rounded-lg border-zinc-200 disabled:opacity-30"
              aria-label="Scroll right"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        )}
      </div>

      {/* Content */}
      <div className="p-5">
        {isMobile ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {children}
          </div>
        ) : (
          <div
            ref={scrollContainerRef}
            className="flex gap-4 overflow-x-auto pb-2 scrollbar-hide"
            style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}
          >
            {children}
          </div>
        )}
      </div>
    </div>
  );
}
