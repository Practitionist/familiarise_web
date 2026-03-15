"use client";

import type { TAppointment, TSlotOfAppointment } from "@/types/appointment";
import type { SlotOfAppointment } from "@prisma/client";
import { ArrowLeftIcon, ArrowRightIcon } from "assets/icons";
import { Button } from "components/ui/button";
import { useRef } from "react";
import type { EventWithType } from "../../utils/getMetadata";
import { MonthlyEventCard, SlotCard } from "./SessionCards";

interface UpcomingSectionProps {
  readonly slots: {
    appointment: TAppointment;
    slot: TSlotOfAppointment;
    isTentative: boolean;
  }[];
}

export function UpcomingSection({ slots }: Readonly<UpcomingSectionProps>) {
  const carouselRef = useRef<HTMLDivElement>(null);

  const scrollCarousel = (direction: "left" | "right") => {
    if (carouselRef.current) {
      const scrollAmount = 300;
      const newScrollLeft =
        carouselRef.current.scrollLeft +
        (direction === "left" ? -scrollAmount : scrollAmount);
      carouselRef.current.scrollTo({
        left: newScrollLeft,
        behavior: "smooth",
      });
    }
  };

  return (
    <div className="bg-white rounded-xl border border-zinc-200">
      <div className="flex justify-between items-center px-6 py-4 border-b border-zinc-100">
        <h2 className="text-lg font-semibold text-zinc-900">
          Upcoming Sessions
        </h2>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="icon"
            onClick={() => scrollCarousel("left")}
            className="h-8 w-8 rounded-full"
            data-testid="prev-upcoming"
          >
            <ArrowLeftIcon className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={() => scrollCarousel("right")}
            className="h-8 w-8 rounded-full"
            data-testid="next-upcoming"
          >
            <ArrowRightIcon className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <div
        ref={carouselRef}
        className="flex overflow-x-auto gap-6 px-6 pb-6 pt-4 scrollbar-hide scroll-smooth"
        style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}
        data-testid="upcoming-slot-list"
      >
        {slots.map((item, index) => (
          <div
            key={item.slot.id}
            className={`flex-none ${index === 0 ? "w-[400px]" : "w-[300px]"}`}
            data-testid={`${item.appointment.appointmentType.toLowerCase()}-${item.appointment.id}-${item.slot.id}`}
          >
            <SlotCard
              appointment={item.appointment}
              slot={item.slot}
              isTentative={item.isTentative}
              isFirst={index === 0}
            />
          </div>
        ))}
        {slots.length === 0 && (
          <div className="w-full text-center py-8">
            <p className="text-zinc-500">No upcoming sessions</p>
          </div>
        )}
      </div>
    </div>
  );
}

interface MonthlySectionProps {
  readonly currentMonth: Date;
  readonly events: {
    event: EventWithType;
    slots: (SlotOfAppointment & { isPast?: boolean; isCancelled?: boolean })[];
  }[];
  readonly onPreviousMonth: () => void;
  readonly onNextMonth: () => void;
}

export function MonthlySection({
  currentMonth,
  events,
  onPreviousMonth,
  onNextMonth,
}: Readonly<MonthlySectionProps>) {
  return (
    <div className="bg-white rounded-xl border border-zinc-200">
      <div className="flex justify-between items-center px-6 py-4 border-b border-zinc-100">
        <h2 className="text-lg font-semibold text-zinc-900">
          {currentMonth.toLocaleString("default", {
            month: "long",
            year: "numeric",
          })}
        </h2>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="icon"
            onClick={onPreviousMonth}
            className="h-8 w-8 rounded-full"
            data-testid="prev-month"
          >
            <ArrowLeftIcon className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={onNextMonth}
            className="h-8 w-8 rounded-full"
            data-testid="next-month"
          >
            <ArrowRightIcon className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <div
        className="divide-y divide-zinc-100 max-h-[600px] overflow-y-auto"
        data-testid="monthly-slot-list"
      >
        {events.map(({ event, slots }) => (
          <div
            key={`${event.id}-${slots[0]?.id}`}
            data-testid={`${event.type.toLowerCase()}-${event.id}`}
          >
            <MonthlyEventCard event={event} slots={slots} />
          </div>
        ))}
        {events.length === 0 && (
          <div className="text-center py-8">
            <p className="text-zinc-500">No sessions this month</p>
          </div>
        )}
      </div>
    </div>
  );
}
