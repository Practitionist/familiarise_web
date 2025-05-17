"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import React, { useRef, useState, useEffect, useCallback } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";

interface OverviewProps {
  consultations: ConsultationWithPlan[];
  subscriptions: SubscriptionWithPlan[];
  webinars: WebinarWithPlan[];
  classes: ClassWithPlan[];
}

interface AppointmentSlot {
  startTime: Date;
  endTime: Date;
}

function getNoSlotMessage(type: string): string {
  return `No upcoming slots scheduled for this ${type.toLowerCase()}. Check details or wait for confirmation.`;
}

function formatDateFromSlot(slot: SlotOfAppointment | null): string {
  if (!slot) return "No upcoming slot";
  const date = new Date(slot.slotStartTimeInUTC);
  return date.toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function getValidAppointmentSlots(event: EventWithType): AppointmentSlot[] {
  const slots = getActualSlots(event);
  return slots.map((slot) => ({
    startTime: new Date(slot.slotStartTimeInUTC),
    endTime: slot.slotEndTimeInUTC
      ? new Date(slot.slotEndTimeInUTC)
      : new Date(slot.slotStartTimeInUTC),
  }));
}

export function Overview({
  consultations,
  subscriptions,
  classes,
  webinars,
}: Readonly<OverviewProps>) {
  return (
    <div className="space-y-8" data-testid="overview-grid">
      <DashboardCard
        title="Consultations"
        items={consultations.map((consultation) => {
          const slotInfo = getActualNextSlotTime({
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
            image: consultation.consultationPlan.consultantProfile?.user?.image,
            status: consultation.requestStatus.toString(),
            type: "Consultation" as const,
            isTentative: slotInfo?.isTentative ?? false,
            actualSlots: getValidAppointmentSlots({
              ...consultation,
              type: "Consultation",
            }),
            appointmentId: consultation.appointment?.id,
          };
        })}
      />
      <DashboardCard
        title="Subscriptions"
        items={subscriptions.map((subscription) => {
          const slotInfo = getActualNextSlotTime({
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
            image: subscription.subscriptionPlan.consultantProfile?.user?.image,
            status: subscription.requestStatus.toString(),
            type: "Subscription" as const,
            isTentative: slotInfo?.isTentative ?? false,
            actualSlots: getValidAppointmentSlots({
              ...subscription,
              type: "Subscription",
            }),
            appointmentId: subscription.appointments?.[0]?.id,
          };
        })}
      />
      <DashboardCard
        title="Webinars"
        items={webinars.map((webinar) => {
          const slotInfo = getActualNextSlotTime({
            ...webinar,
            type: "Webinar",
          });
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
          };
        })}
      />
      <DashboardCard
        title="Classes"
        items={classes.map((classItem) => {
          const slotInfo = getActualNextSlotTime({
            ...classItem,
            type: "Class",
          });

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
          };
        })}
      />
    </div>
  );
}

interface DashboardCardProps {
  title: string;
  items: {
    id: string;
    title: string;
    date: string;
    consultant: string;
    status?: string;
    image?: string | null;
    type: "Subscription" | "Class" | "Consultation" | "Webinar";
    isTentative: boolean;
    actualSlots?: AppointmentSlot[];
    appointmentId?: string;
  }[];
}

function DashboardCard({ title, items }: Readonly<DashboardCardProps>) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const SCROLL_AMOUNT = 384 + 16;

  const updateScrollButtonStates = useCallback(() => {
    if (scrollContainerRef.current) {
      const { scrollLeft, scrollWidth, clientWidth } =
        scrollContainerRef.current;
      setCanScrollLeft(scrollLeft > 5);
      setCanScrollRight(scrollLeft < scrollWidth - clientWidth - 5);
    }
  }, []);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || items.length === 0) {
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
  }, [items, updateScrollButtonStates]);

  const handleScroll = (direction: "left" | "right") => {
    if (scrollContainerRef.current) {
      const currentScroll = scrollContainerRef.current.scrollLeft;
      const newScroll =
        direction === "left"
          ? currentScroll - SCROLL_AMOUNT
          : currentScroll + SCROLL_AMOUNT;

      // Use smooth scrolling for button clicks
      scrollContainerRef.current.scrollTo({
        left: newScroll,
        behavior: "smooth",
      });

      setTimeout(updateScrollButtonStates, 300);
    }
  };

  if (!items.length) {
    return (
      <Card className="bg-gradient-to-br from-white via-white to-gray-50 border-gray-100 shadow-sm">
        <CardHeader>
          <CardTitle className="text-xl text-gray-800">{title}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-gray-500">No appointments found.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="relative overflow-hidden rounded-xl bg-gradient-to-br from-white via-white to-gray-50 border-gray-100 shadow-sm">
      <CardHeader className="relative z-10 flex flex-row justify-between items-center">
        <CardTitle className="text-xl text-gray-800">{title}</CardTitle>

        {/* Scroll Buttons */}
        {(canScrollLeft || canScrollRight) && (
          <div className="flex space-x-2">
            {canScrollLeft && (
              <Button
                variant="outline"
                size="icon"
                onClick={() => handleScroll("left")}
                className="rounded-full h-9 w-9 bg-white/90 backdrop-blur-sm shadow-sm hover:shadow-md transition-all border-gray-200"
                aria-label="Scroll left"
              >
                <ChevronLeftIcon className="h-5 w-5" />
              </Button>
            )}
            {canScrollRight && (
              <Button
                variant="outline"
                size="icon"
                onClick={() => handleScroll("right")}
                className="rounded-full h-9 w-9 bg-white/90 backdrop-blur-sm shadow-sm hover:shadow-md transition-all border-gray-200"
                aria-label="Scroll right"
              >
                <ChevronRightIcon className="h-5 w-5" />
              </Button>
            )}
          </div>
        )}
      </CardHeader>

      {/* Glossy top reflection effect */}
      <div className="absolute top-0 left-0 right-0 h-[20%] bg-gradient-to-b from-white/30 to-transparent pointer-events-none z-0"></div>

      <CardContent className="relative z-10">
        <div
          ref={scrollContainerRef}
          className="flex flex-row gap-4 overflow-x-auto pb-4 snap-x snap-mandatory 
                     [&::-webkit-scrollbar]:hidden [-ms-overflow-style:'none'] [scrollbar-width:'none']"
        >
          {items.map((item) => (
            <div key={item.id} className="snap-start">
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
              />
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
