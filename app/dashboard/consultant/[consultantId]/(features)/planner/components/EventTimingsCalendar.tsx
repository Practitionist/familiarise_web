"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useToast } from "@/components/ui/use-toast";
import { addDays, format, isSameDay, startOfWeek } from "date-fns";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useParams } from "next/navigation";
import React, { useEffect, useState, useMemo } from "react";
import { AppointmentsType, ConsultantProfile, SlotOfAvailabilityWeekly, SlotOfAvailabilityCustom } from "@prisma/client";
import { Appointment, AppointmentSlot, TimeSlot } from "../types/calendar";
import { mapCustomSlots, mapWeeklySlots } from "../utils";

// Define intervals similar to TimingsCalendar
const INTERVALS_PER_HOUR = 2; // 30-minute intervals
const TOTAL_INTERVALS = 24 * INTERVALS_PER_HOUR;
const INTERVALS = Array.from({ length: TOTAL_INTERVALS }, (_, i) => {
  const hour = Math.floor(i / INTERVALS_PER_HOUR);
  const minute = (i % INTERVALS_PER_HOUR) * (60 / INTERVALS_PER_HOUR);
  return { hour, minute };
});

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface EventTimingsCalendarProps {
  isOpen: boolean;
  onClose: () => void;
  eventType: "webinar" | "class";
  eventId: string;
  callsPerWeek?: number;
  durationInMonths?: number;
}

// Extend TimeSlot to include optional appointment details for tooltips
interface DetailedTimeSlot extends TimeSlot {
  appointmentDetails?: {
    id: string;
    type: AppointmentsType;
    title: string;
  };
}

export function EventTimingsCalendar({
  isOpen,
  onClose,
  eventType,
  eventId,
  callsPerWeek = 1,
  durationInMonths = 1,
}: EventTimingsCalendarProps) {
  const params = useParams();
  const { toast } = useToast();
  const [currentDate, setCurrentDate] = useState(new Date());
  const [view, setView] = useState<"week" | "month">("week");
  const [consultantDetails, setConsultantDetails] = useState<ConsultantProfile | null>(null);
  const [allAppointmentsRawData, setAllAppointmentsRawData] = useState<Appointment[]>([]);
  const [selectedSlots, setSelectedSlots] = useState<TimeSlot[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [browserTimezone] = useState(() =>
    typeof window !== "undefined"
      ? Intl.DateTimeFormat().resolvedOptions().timeZone
      : "UTC",
  );
  const [rawAvailabilitySlots, setRawAvailabilitySlots] = useState<{ weekly: SlotOfAvailabilityWeekly[], custom: SlotOfAvailabilityCustom[] }>({ weekly: [], custom: [] });

  const startDate = startOfWeek(currentDate);
  const weekDates = [...Array(7)].map((_, i) => addDays(startDate, i));

  const isOverlapping = (
    intervalStart: Date,
    intervalEnd: Date,
    slotList: TimeSlot[] = [],
  ): boolean => {
    return slotList.some((slot) => {
      const slotStart = slot.startTime instanceof Date ? slot.startTime : new Date(slot.startTime);
      const slotEnd = slot.endTime instanceof Date ? slot.endTime : new Date(slot.endTime);
      return intervalStart < slotEnd && intervalEnd > slotStart;
    });
  };

  // Helper function to find overlapping appointments
  const findOverlappingAppointments = (
    intervalStart: Date,
    intervalEnd: Date,
    slotList: DetailedTimeSlot[] = [],
  ): DetailedTimeSlot[] => {
    return slotList.filter((slot) => {
      const slotStart = slot.startTime instanceof Date ? slot.startTime : new Date(slot.startTime);
      const slotEnd = slot.endTime instanceof Date ? slot.endTime : new Date(slot.endTime);
      return intervalStart < slotEnd && intervalEnd > slotStart;
    });
  };

  const getSlotStatus = (
    interval: { hour: number; minute: number },
    date: Date,
    currentAvailableSlots: TimeSlot[],
    currentExistingAppointments: DetailedTimeSlot[]
  ) => {
    const localIntervalStartDate = new Date(date);
    localIntervalStartDate.setHours(interval.hour, interval.minute, 0, 0);
    const localIntervalEndDate = new Date(localIntervalStartDate);
    localIntervalEndDate.setMinutes(localIntervalStartDate.getMinutes() + 30);

    const intervalStartDateUTC = new Date(localIntervalStartDate.toISOString());
    const intervalEndDateUTC = new Date(localIntervalEndDate.toISOString());

    // Find all appointments overlapping this specific interval
    const overlappingAppointments = findOverlappingAppointments(
        intervalStartDateUTC,
        intervalEndDateUTC,
        currentExistingAppointments
    );

    const isWithinAvailability = isOverlapping(
      intervalStartDateUTC,
      intervalEndDateUTC,
      currentAvailableSlots,
    );
    // isBooked is true if there are ANY overlapping appointments
    const isBooked = overlappingAppointments.length > 0;
    const isPartiallyBooked = isWithinAvailability && isBooked;

    const now = new Date();
    const isInPast = localIntervalEndDate < now;

    const isDisabled = !isWithinAvailability || isBooked || isInPast;

    return {
      isAvailable: isWithinAvailability && !isBooked,
      isBooked: isBooked && !isWithinAvailability,
      isPartiallyBooked,
      isDisabled,
      isInPast,
      intervalStartUTCString: intervalStartDateUTC.toISOString(),
      intervalEndUTCString: intervalEndDateUTC.toISOString(),
      localStartTime: localIntervalStartDate,
      localEndTime: localIntervalEndDate,
      overlappingAppointments: overlappingAppointments,
    };
  };

  const fetchData = async () => {
    if (!isOpen || !eventId || !params.consultantId) {
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const consultantId = params.consultantId.toString();
      const appointmentSearchParams = new URLSearchParams({ consultantProfileId: consultantId });
      const weeklyAvailabilityParams = new URLSearchParams({ consultantProfileId: consultantId });
      const customAvailabilityParams = new URLSearchParams({ consultantProfileId: consultantId });

      const [
        consultantResponse,
        appointmentsResponse,
        weeklyAvailabilityResponse,
        customAvailabilityResponse,
      ] = await Promise.all([
        fetch(`/api/user/consultants/${consultantId}`),
        fetch(`/api/slots/appointments?${appointmentSearchParams}`),
        fetch(`/api/slots/availability/weekly?${weeklyAvailabilityParams}`),
        fetch(`/api/slots/availability/custom?${customAvailabilityParams}`),
      ]);

      if (consultantResponse.ok) {
        const { data } = await consultantResponse.json();
        if (!data) throw new Error("Consultant not found");
        setConsultantDetails(data);
      } else {
        throw new Error("Failed to fetch consultant data");
      }

      let weeklySlotsRaw: any[] = [];
      let customSlotsRaw: any[] = [];
      if (weeklyAvailabilityResponse.ok) {
        const { data } = await weeklyAvailabilityResponse.json();
        weeklySlotsRaw = data || [];
      }
      if (customAvailabilityResponse.ok) {
        const { data } = await customAvailabilityResponse.json();
        customSlotsRaw = data || [];
      }
      setRawAvailabilitySlots({ weekly: weeklySlotsRaw, custom: customSlotsRaw });

      if (appointmentsResponse.ok) {
        const { data } = await appointmentsResponse.json();
        setAllAppointmentsRawData(data || []);
      } else {
        throw new Error("Failed to fetch appointments data");
      }
    } catch (error) {
      console.error("Error fetching data:", error);
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to fetch calendar data",
      });
      setConsultantDetails(null);
      setAllAppointmentsRawData([]);
      setRawAvailabilitySlots({ weekly: [], custom: [] });
    } finally {
      setLoading(false);
    }
  };

  const fetchEventSlots = async () => {
    if (!isOpen || !eventId) return;
    try {
      const params = new URLSearchParams({
        type: eventType.toUpperCase(),
      });

      if (eventType === "webinar") {
        params.append("webinarId", eventId);
      } else {
        params.append("classId", eventId);
      }

      const response = await fetch(`/api/slots/appointments?${params}`);

      if (response.ok) {
        const { data } = await response.json();
        if (data && data.length > 0 && data[0].slotsOfAppointment?.length > 0) {
          const slots: TimeSlot[] = data[0].slotsOfAppointment.flatMap(
            (slot: AppointmentSlot) => {
              const start = new Date(slot.slotStartTimeInUTC);
              const end = new Date(slot.slotEndTimeInUTC);
              const durationMinutes = (end.getTime() - start.getTime()) / (1000 * 60);
              const numIntervals = Math.round(durationMinutes / 30);

              const intervalSlots: TimeSlot[] = [];
              for (let i = 0; i < numIntervals; i++) {
                const intervalStart = new Date(start.getTime() + i * 30 * 60 * 1000);
                const intervalEnd = new Date(intervalStart.getTime() + 30 * 60 * 1000);
                intervalSlots.push({
                  startTime: intervalStart,
                  endTime: intervalEnd,
                  isAvailable: true,
                  isBooked: false,
                });
              }
              return intervalSlots;
            }
          );
          setSelectedSlots(slots);

          if (slots.length > 0) {
            setCurrentDate(new Date(slots[0].startTime));
          }
        }
      }
    } catch (error) {
      console.error("Error fetching event slots:", error);
    }
  };

  useEffect(() => {
    fetchData();
    fetchEventSlots();

    return () => {
      if (!isOpen) {
        setSelectedSlots([]);
        setCurrentDate(new Date());
        setConsultantDetails(null);
        setAllAppointmentsRawData([]);
        setRawAvailabilitySlots({ weekly: [], custom: [] });
      }
    };
  }, [isOpen, eventId, params.consultantId, eventType]);

  const currentViewSlots = useMemo(() => {
    const startOfView = view === 'week' ? startOfWeek(currentDate) : new Date(currentDate.getFullYear(), currentDate.getMonth(), 1);
    const endOfView = view === 'week'
      ? addDays(startOfView, 7)
      : new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0, 23, 59, 59, 999);

    let currentAvailableSlots: TimeSlot[] = [];
    const scheduleType = consultantDetails?.scheduleType;

    if (consultantDetails) {
      const consultantDataForMapping = {
        ...consultantDetails,
        slotsOfAvailabilityWeekly: rawAvailabilitySlots.weekly as SlotOfAvailabilityWeekly[],
        slotsOfAvailabilityCustom: rawAvailabilitySlots.custom as SlotOfAvailabilityCustom[],
      };

      if (scheduleType === "WEEKLY") {
        currentAvailableSlots = mapWeeklySlots(consultantDataForMapping, currentDate, view);
      } else if (scheduleType === "CUSTOM") {
        const allCustomSlots = mapCustomSlots(consultantDataForMapping);
        currentAvailableSlots = allCustomSlots.filter(slot => slot.startTime < endOfView && slot.endTime > startOfView);
      }
    }

    // Map raw appointments to DetailedTimeSlot, including necessary details
    const currentExistingAppointments: DetailedTimeSlot[] = allAppointmentsRawData
       .flatMap((appointment: any) => { // Use 'any' for now, assuming API returns nested data
         return (appointment.slotsOfAppointment || []).map((slot: AppointmentSlot): DetailedTimeSlot => {
             let title = "Unknown Appointment";
             // Construct title based on appointment type (assuming nested data exists)
             if (appointment.appointmentType === "CLASS" && appointment.class?.name) {
                 title = `Class: ${appointment.class.name}`;
             } else if (appointment.appointmentType === "WEBINAR" && appointment.webinar?.title) {
                 title = `Webinar: ${appointment.webinar.title}`;
             } else if (appointment.appointmentType === "CONSULTATION" && appointment.consultationRequest?.service?.name) {
                 title = `Consultation: ${appointment.consultationRequest.service.name}`;
                 if (appointment.consultationRequest.user?.name) {
                     title += ` with ${appointment.consultationRequest.user.name}`;
                 }
             } else if (appointment.appointmentType === "SUBSCRIPTION" && appointment.subscription?.user?.name) {
                 title = `Subscription: ${appointment.subscription.user.name}`;
             }

             return {
                 startTime: new Date(slot.slotStartTimeInUTC),
                 endTime: new Date(slot.slotEndTimeInUTC),
                 isAvailable: false,
                 isBooked: true,
                 appointmentDetails: {
                     id: appointment.id,
                     type: appointment.appointmentType,
                     title: title,
                 },
             };
         });
       })
       .filter(slot => slot.startTime < endOfView && slot.endTime > startOfView);

    return { availableSlots: currentAvailableSlots, existingAppointments: currentExistingAppointments };
  }, [consultantDetails, rawAvailabilitySlots, allAppointmentsRawData, currentDate, view]);

  const availableSlots = currentViewSlots.availableSlots;
  const existingAppointments = currentViewSlots.existingAppointments;
  const scheduleType = consultantDetails?.scheduleType;

  const handleSlotSelect = (interval: { hour: number; minute: number }, date: Date) => {
    const status = getSlotStatus(interval, date, availableSlots, existingAppointments);

    if (status.isDisabled) return;

    const slotUTCTimestamp = status.intervalStartUTCString;

    const newSlot: TimeSlot = {
      startTime: new Date(status.intervalStartUTCString),
      endTime: new Date(status.intervalEndUTCString),
      isAvailable: true,
      isBooked: false,
    };

    const isSelected = selectedSlots.some(
      (slot) => slot.startTime.toISOString() === slotUTCTimestamp
    );

    if (isSelected) {
      setSelectedSlots(
        selectedSlots.filter(
          (slot) => slot.startTime.toISOString() !== slotUTCTimestamp
        ),
      );
    } else {
      if (eventType === "webinar") {
        setSelectedSlots([newSlot]);
        return;
      }

      const requiredSlots = callsPerWeek * 2 * 4 * durationInMonths;
      if (selectedSlots.length >= requiredSlots) {
        toast({
          variant: "destructive",
          title: "Maximum slots reached",
          description: `You can only select ${requiredSlots} slots (30-min each) for this class.`,
        });
        return;
      }
      setSelectedSlots([...selectedSlots, newSlot].sort((a, b) => a.startTime.getTime() - b.startTime.getTime()));
    }
  };

  const handleSave = async () => {
    try {
      setSaving(true);

      const params = new URLSearchParams({
        type: eventType.toUpperCase(),
      });

      if (eventType === "webinar") {
        params.append("webinarId", eventId);
      } else {
        params.append("classId", eventId);
      }

      const existingResponse = await fetch(`/api/slots/appointments?${params}`);

      if (existingResponse.ok) {
        const { data } = await existingResponse.json();
        const existingAppointment = data?.[0];

        let response;
        if (existingAppointment) {
          response = await fetch(
            `/api/slots/appointments/${existingAppointment.id}`,
            {
              method: "PATCH",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                slotsOfAppointment: {
                  deleteMany: {},
                  createMany: {
                    data: selectedSlots.map((slot) => ({
                      slotStartTimeInUTC:
                        slot.originalSlot?.slotStartTimeInUTC ||
                        slot.startTime.toISOString(),
                      slotEndTimeInUTC:
                        slot.originalSlot?.slotEndTimeInUTC ||
                        slot.endTime.toISOString(),
                    })),
                  },
                },
              }),
            },
          );
        } else {
          response = await fetch(`/api/slots/appointments`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              appointmentType: eventType.toUpperCase() as AppointmentsType,
              [eventType]: { connect: { id: eventId } },
              slotsOfAppointment: {
                create: selectedSlots.map((slot) => ({
                  slotStartTimeInUTC: slot.startTime.toISOString(),
                  slotEndTimeInUTC: slot.endTime.toISOString(),
                })),
              },
            }),
          });
        }

        if (!response.ok) {
          throw new Error("Failed to save timings");
        }
      }

      toast({
        title: "Success",
        description: "Timings saved successfully",
      });
      onClose();
    } catch (error) {
      console.error("Error saving timings:", error);
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to save timings",
      });
    } finally {
      setSaving(false);
    }
  };

  const navigatePrevious = () => {
    if (view === "week") {
      setCurrentDate(new Date(currentDate.setDate(currentDate.getDate() - 7)));
    } else {
      setCurrentDate(
        new Date(currentDate.setMonth(currentDate.getMonth() - 1)),
      );
    }
  };

  const navigateNext = () => {
    if (view === "week") {
      setCurrentDate(new Date(currentDate.setDate(currentDate.getDate() + 7)));
    } else {
      setCurrentDate(
        new Date(currentDate.setMonth(currentDate.getMonth() + 1)),
      );
    }
  };

  // Updated to handle 30-minute intervals and add Tooltip
  const renderTimeCell = (interval: { hour: number; minute: number }, date: Date) => {
    const status = getSlotStatus(interval, date, availableSlots, existingAppointments);
    const slotUTCTimestamp = status.intervalStartUTCString;
    const isCurrentlySelected = selectedSlots.some(
      (slot) => slot.startTime.toISOString() === slotUTCTimestamp
    );

    // Log status for debugging
    if (status.isBooked || status.isPartiallyBooked) {
        console.log(`Slot Status [${format(date, 'yyyy-MM-dd')} ${interval.hour}:${interval.minute}]`, status);
    }

    let cellClassName = `h-8 w-full relative transition-colors duration-150 ease-in-out border border-transparent rounded-sm text-[10px] leading-tight px-1 py-0.5`;
    let buttonText = "";
    const showTooltip = status.isBooked || status.isPartiallyBooked;

    if (isCurrentlySelected) {
      cellClassName += " bg-primary text-primary-foreground hover:bg-primary/90 border-primary-darker";
      buttonText = "Selected";
    } else if (status.isPartiallyBooked) {
      cellClassName += " bg-yellow-400 text-yellow-900 cursor-not-allowed";
      buttonText = "Partially Booked";
    } else if (status.isBooked) {
      cellClassName += " bg-slate-400 text-slate-800 cursor-not-allowed";
      buttonText = "Booked";
    } else if (status.isAvailable) {
      if (status.isInPast) {
        cellClassName += " bg-green-300 text-green-950 opacity-50 cursor-not-allowed border-green-400";
        buttonText = "Available";
      } else {
        cellClassName += " bg-green-300 text-green-950 hover:bg-green-400 border-green-400";
        buttonText = "Available";
      }
    } else {
      if (status.isInPast) {
        cellClassName += " bg-gray-300 text-gray-700 cursor-not-allowed opacity-70";
      } else {
        cellClassName += " bg-slate-200 cursor-not-allowed";
      }
    }

    const buttonElement = (
      <Button
        key={slotUTCTimestamp}
        variant={"ghost"}
        className={cellClassName}
        onClick={() => handleSlotSelect(interval, date)}
        disabled={status.isDisabled && !isCurrentlySelected}
      >
        {buttonText}
      </Button>
    );

    if (showTooltip && status.overlappingAppointments.length > 0) {
        // Button inside tooltip trigger should not be disabled itself for hover to work
        const tooltipButtonElement = (
            <Button
                key={slotUTCTimestamp}
                variant={"ghost"}
                className={cellClassName}
                // The click handler still respects the original logic
                onClick={() => handleSlotSelect(interval, date)}
                // Explicitly NOT disabled here; parent TooltipTrigger handles interaction
                disabled={false}
              >
                {buttonText}
              </Button>
        );

        return (
            <TooltipProvider delayDuration={200}>
                <Tooltip>
                    <TooltipTrigger asChild>
                        {/* Use the non-disabled button version for the trigger */}
                        {tooltipButtonElement}
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs text-xs" side="top" align="center">
                        <div className="flex flex-col gap-1">
                            {status.overlappingAppointments.map((appSlot) => (
                                <div key={appSlot.appointmentDetails?.id + appSlot.startTime.toISOString()} className="border-b border-border last:border-b-0 pb-1 mb-1 last:pb-0 last:mb-0">
                                    <p className="font-semibold">{appSlot.appointmentDetails?.title || "Booked Slot"}</p>
                                    <p className="text-muted-foreground">
                                        {appSlot.appointmentDetails?.type}
                                    </p>
                                    <p className="text-muted-foreground">
                                        {format(appSlot.startTime, "HH:mm")} - {format(appSlot.endTime, "HH:mm")}
                                    </p>
                                </div>
                            ))}
                        </div>
                    </TooltipContent>
                </Tooltip>
            </TooltipProvider>
        );
    }

    // Render original button (with potential disabled state) if not showing tooltip
    return buttonElement;
  };

  if (loading) {
    return (
      <Dialog open={isOpen} onOpenChange={onClose}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Loading your calendar...</DialogTitle>
            <DialogDescription>
              Please wait while we fetch your calendar data...
            </DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    );
  }

  if (!loading && !consultantDetails) {
    return (
      <Dialog open={isOpen} onOpenChange={onClose}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Error Loading Data</DialogTitle>
            <DialogDescription>
              Could not load consultant or availability data. Please try again later.
            </DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    );
  }

  if (!loading && consultantDetails && scheduleType !== 'WEEKLY' && scheduleType !== 'CUSTOM') {
    return (
      <Dialog open={isOpen} onOpenChange={onClose}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>No Availability Found</DialogTitle>
            <DialogDescription>
              No availability slots were found for this consultant. Please configure availability in settings.
            </DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    );
  }

  const requiredTotalSlots = eventType === "webinar" ? 1 : (callsPerWeek * 2 * 4 * durationInMonths);

  const renderMonthView = () => {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    const firstDayOfMonth = new Date(year, month, 1).getDay();
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const countAvailableSlotsForDay = (date: Date): number => {
      let count = 0;
      const dayStart = new Date(date);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(date);
      dayEnd.setHours(23, 59, 59, 999);

      const dayAvailableSlots = availableSlots.filter(slot =>
        slot.startTime < dayEnd && slot.endTime > dayStart);
      const dayExistingAppointments = existingAppointments.filter(slot =>
        slot.startTime < dayEnd && slot.endTime > dayStart);

      for (const interval of INTERVALS) {
        const status = getSlotStatus(interval, date, dayAvailableSlots, dayExistingAppointments);
        if (status.isAvailable && !status.isInPast) {
          count++;
        }
      }
      return count;
    };

    return (
      <div className="grid grid-cols-7 gap-1 h-[600px] overflow-y-auto">
        {DAYS.map((day) => (
          <div key={day} className="text-center font-bold p-2">
            {day.slice(0,3)}
          </div>
        ))}
        {Array.from({ length: firstDayOfMonth }, (_, i) => (
          <div key={`empty-start-${i}`} className="min-h-[100px] border bg-gray-50/50" />
        ))}
        {Array.from({ length: new Date(year, month + 1, 0).getDate() }, (_, i) => {
          const date = new Date(year, month, i + 1);
          const isCurrentDay = isSameDay(date, now);
          const isPastDay = date < today;
          const availableCount = isPastDay ? 0 : countAvailableSlotsForDay(date);

          return (
            <div
              key={date.toISOString()}
              className={`min-h-[100px] border p-1 flex flex-col ${isCurrentDay ? "ring-2 ring-primary" : ""} ${isPastDay ? "bg-gray-100 text-gray-400" : "bg-white"}`}
            >
              <div className={`font-bold mb-1 text-xs ${isCurrentDay ? "text-primary" : ""} ${isPastDay ? "" : "text-gray-700"}`}>
                {i + 1}
              </div>
              <div className="flex-grow flex items-center justify-center">
                {!isPastDay && availableCount > 0 && (
                  <Badge variant="outline" className="text-[10px] p-1">
                    {availableCount} slots
                  </Badge>
                )}
                {!isPastDay && availableCount === 0 && (
                  <span className="text-xs text-muted-foreground">No Slots</span>
                )}
                {isPastDay && <span className="text-xs text-muted-foreground"></span>}
              </div>
            </div>
          );
        })}
        {Array.from({ length: (7 - (firstDayOfMonth + new Date(year, month + 1, 0).getDate()) % 7) % 7 }, (_, i) => (
          <div key={`empty-end-${i}`} className="min-h-[100px] border bg-gray-50/50" />
        ))}
      </div>
    );
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-7xl">
        <DialogHeader>
          <DialogTitle>
            Manage {eventType === "webinar" ? "Webinar" : "Class"} Timings
          </DialogTitle>
          <DialogDescription>
            {eventType === "webinar"
              ? "Select one 30-minute time slot for your webinar."
              : `Select ${requiredTotalSlots} time slots (30-min each) for your class.`}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex justify-between items-center gap-4">
            <div className="flex gap-2">
              <Button
                variant={view === "week" ? "default" : "outline"}
                size="sm"
                onClick={() => setView("week")}
              >
                Week
              </Button>
              <Button
                variant={view === "month" ? "default" : "outline"}
                size="sm"
                onClick={() => setView("month")}
              >
                Month
              </Button>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={navigatePrevious}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <div className="text-lg font-bold text-center min-w-[150px]">
                {view === 'week'
                  ? `${format(weekDates[0], "MMM d")} - ${format(weekDates[6], "MMM d, yyyy")}`
                  : format(currentDate, "MMMM yyyy")
                }
              </div>
              <Button variant="outline" size="sm" onClick={navigateNext}>
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
            <div className="w-20"></div>
          </div>

          {view === "week" ? (
            <div className="flex flex-col h-[calc(100vh-20rem)] md:h-[65vh] max-h-[700px]">
              <div className="grid grid-cols-8 gap-0.5 md:gap-1 sticky top-0 bg-background z-20 pb-1">
                <div className="w-14 md:w-20"></div>
                {weekDates.map((date, index) => {
                  const isToday = isSameDay(date, new Date());
                  return (
                    <div key={DAYS[index]} className="text-center p-1 md:p-2">
                      <div className={`font-bold text-xs md:text-base ${isToday ? "text-primary" : ""}`}>
                        {DAYS[index].slice(0, 3)}
                      </div>
                      <div className="text-xs md:text-sm text-muted-foreground">
                        {format(date, "d")}
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="flex-1 overflow-y-auto scrollbar-thin">
                {INTERVALS.map((interval, i) => (
                  <div key={`interval-row-${interval.hour}-${interval.minute}`} className="grid grid-cols-8 gap-0.5 md:gap-1">
                    <div className="w-14 md:w-20">
                      {/* Display time label for every interval */}
                      { (
                        <div className="h-8 text-right pr-2 pt-0.5 text-[10px] md:text-sm flex items-start justify-end" >
                          {new Date(1970, 0, 1, interval.hour, interval.minute).toLocaleTimeString(
                            [], { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: browserTimezone }
                          )}
                        </div>
                      )}
                    </div>
                    {weekDates.map((date) => (
                      <div key={date.toISOString()} className="col-span-1">
                        {renderTimeCell(interval, date)}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            renderMonthView()
          )}

          <div className="flex items-center mt-4 gap-4">
            <div className="text-sm">
              Selected: {selectedSlots.length} / {requiredTotalSlots} slots
            </div>
            <div className="text-sm text-muted-foreground ml-auto">
              Timezone: {browserTimezone}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button
                onClick={handleSave}
                disabled={
                  selectedSlots.length === 0 ||
                  saving ||
                  selectedSlots.length !== requiredTotalSlots
                }
              >
                {saving ? "Saving..." : "Save Timings"}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
