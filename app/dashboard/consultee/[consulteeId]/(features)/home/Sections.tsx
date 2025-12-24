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
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
      <div className="lg:col-span-8 bg-white rounded-xl border border-zinc-200">
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

      <div className="lg:col-span-4">
        <div className="bg-white rounded-xl border border-zinc-200 p-6">
          <h3 className="text-lg font-semibold text-zinc-900 mb-4">
            Unlock Premium Features
          </h3>
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm text-zinc-600">
              <svg
                className="w-4 h-4 text-zinc-900"
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path
                  fillRule="evenodd"
                  d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                  clipRule="evenodd"
                />
              </svg>
              <span>Unlimited Access to Expert Sessions</span>
            </div>
            <div className="flex items-center gap-2 text-sm text-zinc-600">
              <svg
                className="w-4 h-4 text-zinc-900"
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path
                  fillRule="evenodd"
                  d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                  clipRule="evenodd"
                />
              </svg>
              <span>24/7 Priority Support</span>
            </div>
            <div className="flex items-center gap-2 text-sm text-zinc-600">
              <svg
                className="w-4 h-4 text-zinc-900"
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path
                  fillRule="evenodd"
                  d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                  clipRule="evenodd"
                />
              </svg>
              <span>Exclusive Webinars & Workshops</span>
            </div>
          </div>
          <div className="mt-6">
            <div className="flex items-baseline gap-1">
              <span className="text-2xl font-bold text-zinc-900">₹99</span>
              <span className="text-sm text-zinc-600">/month</span>
            </div>
            <p className="text-sm text-zinc-500 mt-1">
              Save 20% with annual billing
            </p>
          </div>
          <Button className="w-full mt-4 bg-zinc-900 hover:bg-zinc-800 text-white">
            Upgrade Now
          </Button>
        </div>
      </div>
    </div>
  );
}
