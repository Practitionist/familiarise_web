"use client";

import { Button } from "@/components/ui/button";
import {
  ClassWithPlan,
  ConsultationWithPlan,
  SubscriptionWithPlan,
  WebinarWithPlan,
} from "@/hooks/useEvents";
import { EventWithType } from "../../utils/getMetadata";
import {
  getActualNextSlotTime,
  getActualSlots,
} from "../../utils/scheduleHelpers";
import { EventCard } from "./EventCard";
import type { SlotOfAppointment } from "@prisma/client";
import type { TAppointment } from "@/types/appointment";
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
  consultations: ConsultationWithPlan[];
  subscriptions: SubscriptionWithPlan[];
  webinars: WebinarWithPlan[];
  classes: ClassWithPlan[];
}

interface DashboardCardProps {
  title: string;
  icon: typeof Calendar;
  accentColor: string;
  items: Array<{
    id: string;
    title: string;
    consultant: string;
    date: string;
    image?: string | null;
    status: string;
    type: "Subscription" | "Class" | "Consultation" | "Webinar";
    isTentative: boolean;
    actualSlots?: Array<{
      startTime: Date;
      endTime: Date;
    }>;
    appointmentId?: string;
    appointment?: TAppointment;
    rawSlots?: SlotOfAppointment[];
    pendingPaymentUrl?: string | null;
    // Booking status for webinars/classes
    bookingStatus?: BookingStatus;
    waitlistPosition?: number;
  }>;
}

// Helper functions
function formatDateFromSlot(slotInfo: SlotOfAppointment): string {
  return new Date(slotInfo.startsAt).toLocaleString();
}

function getNoSlotMessage(_type: string): string {
  return "No slots available";
}

function getValidAppointmentSlots(event: EventWithType): Array<{
  startTime: Date;
  endTime: Date;
}> {
  const slots = getActualSlots(event);
  return slots.map((slot) => ({
    startTime: new Date(slot.startsAt),
    endTime: new Date(slot.endsAt || slot.startsAt),
  }));
}

// Helper to check if a status is inactive (greyed out)
function isInactiveStatus(status: string): boolean {
  const inactive = ["cancelled", "rejected", "completed", "expired"];
  return inactive.includes(status.toLowerCase());
}

// Sort items: active first, then inactive. Within each group, sort chronologically
function sortEventItems<
  T extends { status: string; actualSlots?: Array<{ startTime: Date }> },
>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const aInactive = isInactiveStatus(a.status);
    const bInactive = isInactiveStatus(b.status);

    // Active items come first
    if (aInactive !== bInactive) {
      return aInactive ? 1 : -1;
    }

    // Within the same group, sort chronologically by first slot
    const aTime = a.actualSlots?.[0]?.startTime?.getTime() ?? Infinity;
    const bTime = b.actualSlots?.[0]?.startTime?.getTime() ?? Infinity;
    return aTime - bTime;
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
}: Readonly<OverviewProps>) {
  return (
    <motion.div
      initial="hidden"
      animate="visible"
      className="space-y-8"
      data-testid="overview-grid"
    >
      <motion.div variants={fadeInUp}>
        <DashboardCard
          title="Consultations"
          icon={Video}
          accentColor="blue"
          items={sortEventItems(
            consultations.map((consultation) => {
              const slotInfo = getActualNextSlotTime({
                ...consultation,
                type: "Consultation",
              });
              const rawSlots = getActualSlots({
                ...consultation,
                type: "Consultation",
              });
              return {
                id: consultation.id,
                title: consultation.consultationPlan.title,
                consultant:
                  consultation.consultationPlan.consultantProfile?.user?.name ??
                  "Unknown Consultant",
                date: slotInfo
                  ? formatDateFromSlot(slotInfo)
                  : getNoSlotMessage("Consultation"),
                image:
                  consultation.consultationPlan.consultantProfile?.user?.image,
                status: consultation.requestStatus.toString(),
                type: "Consultation" as const,
                isTentative: slotInfo?.isTentative ?? false,
                actualSlots: getValidAppointmentSlots({
                  ...consultation,
                  type: "Consultation",
                }),
                appointmentId: consultation.appointment?.id,
                appointment: consultation.appointment as
                  | TAppointment
                  | undefined,
                rawSlots,
                pendingPaymentUrl: consultation.pendingPaymentUrl,
              };
            }),
          )}
        />
      </motion.div>

      <motion.div variants={fadeInUp}>
        <DashboardCard
          title="Subscriptions"
          icon={Calendar}
          accentColor="violet"
          items={sortEventItems(
            subscriptions.map((subscription) => {
              const slotInfo = getActualNextSlotTime({
                ...subscription,
                type: "Subscription",
              });
              const rawSlots = getActualSlots({
                ...subscription,
                type: "Subscription",
              });
              return {
                id: subscription.id,
                title: subscription.subscriptionPlan.title,
                consultant:
                  subscription.subscriptionPlan.consultantProfile?.user?.name ??
                  "Unknown Consultant",
                date: slotInfo
                  ? formatDateFromSlot(slotInfo)
                  : getNoSlotMessage("Subscription"),
                image:
                  subscription.subscriptionPlan.consultantProfile?.user?.image,
                status: subscription.requestStatus.toString(),
                type: "Subscription" as const,
                isTentative: slotInfo?.isTentative ?? false,
                actualSlots: getValidAppointmentSlots({
                  ...subscription,
                  type: "Subscription",
                }),
                appointmentId: subscription.appointments?.[0]?.id,
                appointment: subscription.appointments?.[0] as
                  | TAppointment
                  | undefined,
                rawSlots,
                pendingPaymentUrl: subscription.pendingPaymentUrl,
              };
            }),
          )}
        />
      </motion.div>

      <motion.div variants={fadeInUp}>
        <DashboardCard
          title="Webinars"
          icon={Users}
          accentColor="amber"
          items={sortEventItems(
            webinars.map((webinar) => {
              const slotInfo = getActualNextSlotTime({
                ...webinar,
                type: "Webinar",
              });
              const rawSlots = getActualSlots({
                ...webinar,
                type: "Webinar",
              });

              // Determine booking status from appointment and waitlist
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

              return {
                id: webinar.id,
                title: webinar.webinarPlan.title,
                consultant:
                  webinar.webinarPlan.consultantProfile?.user?.name ??
                  "Unknown Consultant",
                date: slotInfo
                  ? formatDateFromSlot(slotInfo)
                  : getNoSlotMessage("Webinar"),
                image: webinar.webinarPlan.consultantProfile?.user?.image,
                status: webinar.status.toString(),
                type: "Webinar" as const,
                isTentative: slotInfo?.isTentative ?? false,
                actualSlots: getValidAppointmentSlots({
                  ...webinar,
                  type: "Webinar",
                }),
                appointmentId: webinar.appointment?.id,
                appointment: webinar.appointment as TAppointment | undefined,
                rawSlots,
                bookingStatus,
                waitlistPosition,
              };
            }),
          )}
        />
      </motion.div>

      <motion.div variants={fadeInUp}>
        <DashboardCard
          title="Classes"
          icon={BookOpen}
          accentColor="emerald"
          items={sortEventItems(
            classes.map((classItem) => {
              const slotInfo = getActualNextSlotTime({
                ...classItem,
                type: "Class",
              });
              const rawSlots = getActualSlots({
                ...classItem,
                type: "Class",
              });

              // Determine booking status from appointments and waitlist
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

              return {
                id: classItem.id,
                title: classItem.classPlan.title,
                consultant:
                  classItem.classPlan.consultantProfile?.user?.name ??
                  "Unknown Consultant",
                date: slotInfo
                  ? formatDateFromSlot(slotInfo)
                  : getNoSlotMessage("Class"),
                image: classItem.classPlan.consultantProfile?.user?.image,
                status: classItem.status.toString(),
                type: "Class" as const,
                isTentative: slotInfo?.isTentative ?? false,
                actualSlots: getValidAppointmentSlots({
                  ...classItem,
                  type: "Class",
                }),
                appointmentId: classItem.appointments?.[0]?.id,
                appointment: classItem.appointments?.[0] as
                  | TAppointment
                  | undefined,
                rawSlots,
                bookingStatus,
                waitlistPosition,
              };
            }),
          )}
        />
      </motion.div>
    </motion.div>
  );
}

function DashboardCard({
  title,
  icon: Icon,
  accentColor,
  items,
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
    if (!container || items.length === 0 || isMobile) {
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
  }, [items, updateScrollButtonStates, isMobile]);

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

  if (!items.length) {
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
            {items.length} {items.length === 1 ? "item" : "items"}
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
            {items.map((item) => (
              <div key={item.id}>
                <EventCard
                  title={item.title}
                  consultant={item.consultant}
                  date={item.date}
                  status={item.status}
                  image={item.image}
                  type={item.type}
                  isTentative={item.isTentative}
                  actualSlots={item.actualSlots}
                  appointmentId={item.appointmentId}
                  appointment={item.appointment}
                  rawSlots={item.rawSlots}
                  pendingPaymentUrl={item.pendingPaymentUrl}
                  bookingStatus={item.bookingStatus}
                  waitlistPosition={item.waitlistPosition}
                />
              </div>
            ))}
          </div>
        ) : (
          <div
            ref={scrollContainerRef}
            className="flex gap-4 overflow-x-auto pb-2 scrollbar-hide"
            style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}
          >
            {items.map((item) => (
              <div key={item.id} className="flex-shrink-0 w-[300px]">
                <EventCard
                  title={item.title}
                  consultant={item.consultant}
                  date={item.date}
                  status={item.status}
                  image={item.image}
                  type={item.type}
                  isTentative={item.isTentative}
                  actualSlots={item.actualSlots}
                  appointmentId={item.appointmentId}
                  appointment={item.appointment}
                  rawSlots={item.rawSlots}
                  pendingPaymentUrl={item.pendingPaymentUrl}
                  bookingStatus={item.bookingStatus}
                  waitlistPosition={item.waitlistPosition}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
