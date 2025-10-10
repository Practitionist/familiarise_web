"use client";

import type {
  IAppointment,
  ISlotOfAppointment,
} from "@/app/dashboard/consultant/[consultantId]/types";
import type { SlotOfAppointment } from "@prisma/client";
import { ArrowLeftIcon, ArrowRightIcon } from "assets/icons";
import { Button } from "components/ui/button";
import { useRef } from "react";
import type { EventWithType } from "../../utils/getMetadata";
import { MonthlyEventCard, SlotCard } from "./SessionCards";

interface UpcomingSectionProps {
  readonly slots: {
    appointment: IAppointment;
    slot: ISlotOfAppointment;
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
    <div className="bg-white rounded-2xl shadow-lg border border-gray-100 overflow-hidden">
      <div className="flex justify-between items-center px-6 py-5 border-b border-gray-100 bg-gradient-to-r from-gray-50 to-white">
        <h2 className="text-xl font-bold text-gray-900">Upcoming Sessions</h2>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="icon"
            onClick={() => scrollCarousel("left")}
            className="h-9 w-9 rounded-full hover:bg-blue-50 hover:border-blue-300 hover:text-blue-600 transition-all duration-200 shadow-sm"
            data-testid="prev-upcoming"
          >
            <ArrowLeftIcon className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={() => scrollCarousel("right")}
            className="h-9 w-9 rounded-full hover:bg-blue-50 hover:border-blue-300 hover:text-blue-600 transition-all duration-200 shadow-sm"
            data-testid="next-upcoming"
          >
            <ArrowRightIcon className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <div
        ref={carouselRef}
        className="flex overflow-x-auto gap-6 px-6 py-6 scrollbar-hide scroll-smooth"
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
          <div className="w-full text-center py-12">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-gray-100 mb-3">
              <svg className="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            </div>
            <p className="text-gray-500 font-medium">No upcoming sessions</p>
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
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
      <div className="lg:col-span-8 bg-white rounded-2xl shadow-lg border border-gray-100 overflow-hidden">
        <div className="flex justify-between items-center px-6 py-5 border-b border-gray-100 bg-gradient-to-r from-gray-50 to-white">
          <h2 className="text-xl font-bold text-gray-900">
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
              className="h-9 w-9 rounded-full hover:bg-blue-50 hover:border-blue-300 hover:text-blue-600 transition-all duration-200 shadow-sm"
              data-testid="prev-month"
            >
              <ArrowLeftIcon className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              onClick={onNextMonth}
              className="h-9 w-9 rounded-full hover:bg-blue-50 hover:border-blue-300 hover:text-blue-600 transition-all duration-200 shadow-sm"
              data-testid="next-month"
            >
              <ArrowRightIcon className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <div
          className="divide-y divide-gray-100 max-h-[600px] overflow-y-auto custom-scrollbar"
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
            <div className="text-center py-12">
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-gray-100 mb-3">
                <svg className="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
              </div>
              <p className="text-gray-500 font-medium">No sessions this month</p>
            </div>
          )}
        </div>
      </div>

      <div className="lg:col-span-4">
        <div className="relative overflow-hidden bg-gradient-to-br from-blue-600 via-indigo-600 to-purple-600 rounded-2xl p-6 shadow-xl">
          <div className="absolute inset-0 bg-grid-white/10"></div>
          <div className="relative z-10">
            <h3 className="text-xl font-bold mb-4 text-white">
              Unlock Premium Features
            </h3>
            <div className="space-y-3 mb-6">
              <div className="flex items-center gap-3 text-sm text-white">
                <div className="flex-shrink-0 w-6 h-6 rounded-full bg-white/20 flex items-center justify-center">
                  <svg
                    className="w-4 h-4 text-white"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                  >
                    <path
                      fillRule="evenodd"
                      d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                      clipRule="evenodd"
                    />
                  </svg>
                </div>
                <span className="font-medium">Unlimited Access to Expert Sessions</span>
              </div>
              <div className="flex items-center gap-3 text-sm text-white">
                <div className="flex-shrink-0 w-6 h-6 rounded-full bg-white/20 flex items-center justify-center">
                  <svg
                    className="w-4 h-4 text-white"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                  >
                    <path
                      fillRule="evenodd"
                      d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                      clipRule="evenodd"
                    />
                  </svg>
                </div>
                <span className="font-medium">24/7 Priority Support</span>
              </div>
              <div className="flex items-center gap-3 text-sm text-white">
                <div className="flex-shrink-0 w-6 h-6 rounded-full bg-white/20 flex items-center justify-center">
                  <svg
                    className="w-4 h-4 text-white"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                  >
                    <path
                      fillRule="evenodd"
                      d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                      clipRule="evenodd"
                    />
                  </svg>
                </div>
                <span className="font-medium">Exclusive Webinars & Workshops</span>
              </div>
            </div>
            <div className="bg-white/10 backdrop-blur-sm rounded-xl p-4 mb-4">
              <div className="flex items-baseline gap-2">
                <span className="text-3xl font-bold text-white">$99</span>
                <span className="text-sm text-blue-100">/month</span>
              </div>
              <p className="text-sm text-blue-100 mt-1 font-medium">
                Save 20% with annual billing
              </p>
            </div>
            <Button className="w-full bg-white text-blue-600 hover:bg-blue-50 font-bold shadow-lg hover:shadow-xl transition-all duration-200 hover:scale-105">
              Upgrade Now
            </Button>
          </div>
          <div className="absolute -right-10 -bottom-10 w-40 h-40 bg-white/10 rounded-full blur-3xl"></div>
        </div>
      </div>
    </div>
  );
}
