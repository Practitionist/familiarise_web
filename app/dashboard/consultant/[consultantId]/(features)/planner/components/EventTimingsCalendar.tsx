"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";
import { addDays, format, isSameDay, startOfWeek } from "date-fns";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useParams } from "next/navigation";
import React, { useEffect, useState, useMemo } from "react";
import { AppointmentsType, ConsultantProfile, SlotOfAvailabilityWeekly, SlotOfAvailabilityCustom } from "@prisma/client";
import { Appointment, AppointmentSlot, TimeSlot } from "../types/calendar";
import { mapCustomSlots, mapWeeklySlots } from "../utils";

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface EventTimingsCalendarProps {
  isOpen: boolean;
  onClose: () => void;
  eventType: "webinar" | "class";
  eventId: string;
  callsPerWeek?: number;
  durationInMonths?: number;
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

  const getSlotStatus = (
    hour: number,
    date: Date,
    currentAvailableSlots: TimeSlot[],
    currentExistingAppointments: TimeSlot[]
  ) => {
    const localIntervalStartDate = new Date(date);
    localIntervalStartDate.setHours(hour, 0, 0, 0);
    const localIntervalEndDate = new Date(localIntervalStartDate);
    localIntervalEndDate.setHours(hour + 1, 0, 0, 0);

    const intervalStartDateUTC = new Date(localIntervalStartDate.toISOString());
    const intervalEndDateUTC = new Date(intervalStartDateUTC.getTime() + 60 * 60 * 1000);

    const isWithinAvailability = isOverlapping(
      intervalStartDateUTC,
      intervalEndDateUTC,
      currentAvailableSlots,
    );
    const isBooked = isOverlapping(
      intervalStartDateUTC,
      intervalEndDateUTC,
      currentExistingAppointments,
    );
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
      localStartTime: localIntervalStartDate,
      localEndTime: localIntervalEndDate,
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
          const slots: TimeSlot[] = data[0].slotsOfAppointment.map(
            (slot: AppointmentSlot) => ({
              startTime: new Date(slot.slotStartTimeInUTC),
              endTime: new Date(slot.slotEndTimeInUTC),
              isAvailable: true,
              isBooked: false,
            }),
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

    const currentExistingAppointments: TimeSlot[] = allAppointmentsRawData
      .flatMap((appointment: Appointment) => (appointment.slotsOfAppointment || []))
      .map((slot: AppointmentSlot): TimeSlot => ({
        startTime: new Date(slot.slotStartTimeInUTC),
        endTime: new Date(slot.slotEndTimeInUTC),
        isAvailable: false,
        isBooked: true,
      }))
      .filter(slot => slot.startTime < endOfView && slot.endTime > startOfView);

    return { availableSlots: currentAvailableSlots, existingAppointments: currentExistingAppointments };
  }, [consultantDetails, rawAvailabilitySlots, allAppointmentsRawData, currentDate, view]);

  const availableSlots = currentViewSlots.availableSlots;
  const existingAppointments = currentViewSlots.existingAppointments;
  const scheduleType = consultantDetails?.scheduleType;

  const handleSlotSelect = (hour: number, date: Date) => {
    const status = getSlotStatus(hour, date, availableSlots, existingAppointments);

    if (status.isDisabled) return;

    const slotUTCTimestamp = status.intervalStartUTCString;

    const newSlot: TimeSlot = {
      startTime: new Date(status.intervalStartUTCString),
      endTime: new Date(status.localEndTime.toISOString()),
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

      const requiredSlots = callsPerWeek * 4 * durationInMonths;
      if (selectedSlots.length >= requiredSlots) {
        toast({
          variant: "destructive",
          title: "Maximum slots reached",
          description: `You can only select ${requiredSlots} slots for this class (${callsPerWeek} calls/week × 4 weeks × ${durationInMonths} months)`,
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
                  slotStartTimeInUTC:
                    slot.originalSlot?.slotStartTimeInUTC || slot.startTime,
                  slotEndTimeInUTC:
                    slot.originalSlot?.slotEndTimeInUTC || slot.endTime,
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

  const renderTimeCell = (hour: number, date: Date) => {
    const status = getSlotStatus(hour, date, availableSlots, existingAppointments);
    const slotUTCTimestamp = status.intervalStartUTCString;

    const isCurrentlySelected = selectedSlots.some(
      (slot) => slot.startTime.toISOString() === slotUTCTimestamp
    );

    let cellClassName = `h-12 w-full relative transition-colors duration-150 ease-in-out border border-transparent rounded-sm text-xs px-1 py-0.5`;
    let buttonText = "";

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
        cellClassName += " bg-slate-300 cursor-not-allowed";
      }
    }

    return (
      <Button
        key={slotUTCTimestamp}
        variant={"ghost"}
        className={cellClassName}
        onClick={() => handleSlotSelect(hour, date)}
        disabled={status.isDisabled}
      >
        {buttonText}
      </Button>
    );
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

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-7xl">
        <DialogHeader>
          <DialogTitle>
            Manage {eventType === "webinar" ? "Webinar" : "Class"} Timings
          </DialogTitle>
          <DialogDescription>
            {eventType === "webinar"
              ? "Select one time slot for your webinar."
              : `Select ${callsPerWeek * 4 * durationInMonths} time slots for your class (${callsPerWeek} calls/week × 4 weeks × ${durationInMonths} months).`}
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
            <Button variant="outline" size="sm" onClick={navigatePrevious}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <div className="text-lg font-bold">
              {format(currentDate, "MMMM yyyy")}
            </div>
            <Button variant="outline" size="sm" onClick={navigateNext}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>

          {view === "week" ? (
            <>
              <div className="grid grid-cols-8 gap-1">
                <div className="w-20"></div>
                {weekDates.map((date, i) => (
                  <div key={i} className="text-center">
                    <div className="font-bold">{DAYS[i]}</div>
                    <div className="text-sm text-muted-foreground">
                      {format(date, "d")}
                    </div>
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-8 gap-1 h-[600px] overflow-y-auto">
                {HOURS.map((hour) => (
                  <React.Fragment key={hour}>
                    <div className="w-20 text-right pr-2 pt-1 text-sm sticky left-0 bg-background z-10">
                      {new Date(1970, 0, 1, hour).toLocaleTimeString([], {
                        hour: '2-digit', minute: '2-digit', hour12: false, timeZone: browserTimezone
                      })}
                    </div>
                    {weekDates.map((date, i) => (
                      <div key={i}>{renderTimeCell(hour, date)}</div>
                    ))}
                  </React.Fragment>
                ))}
              </div>
            </>
          ) : (
            <div className="grid grid-cols-7 gap-1 h-[600px] overflow-y-auto">
              {DAYS.map((day) => (
                <div key={day} className="text-center font-bold">
                  {day}
                </div>
              ))}
              {Array.from(
                {
                  length: new Date(
                    currentDate.getFullYear(),
                    currentDate.getMonth(),
                    1,
                  ).getDay(),
                },
                (_, i) => (
                  <div
                    key={`empty-start-${i}`}
                    className="min-h-[100px] border p-2 bg-gray-50/50"
                  />
                ),
              )}

              {Array.from(
                {
                  length: new Date(
                    currentDate.getFullYear(),
                    currentDate.getMonth() + 1,
                    0,
                  ).getDate(),
                },
                (_, i) => {
                  const date = new Date(
                    currentDate.getFullYear(),
                    currentDate.getMonth(),
                    i + 1,
                  );
                  const daySlots = availableSlots.filter((slot) =>
                    isSameDay(slot.startTime, date),
                  );
                  const bookedDaySlots = existingAppointments.filter((slot) =>
                    isSameDay(slot.startTime, date),
                  );
                  const selectedDaySlots = selectedSlots.filter((slot) =>
                    isSameDay(slot.startTime, date),
                  );

                  const displaySlots = daySlots.filter((availableSlot) => {
                    const isBookedOrPartially = bookedDaySlots.some(bookedSlot => {
                      return availableSlot.startTime < bookedSlot.endTime && availableSlot.endTime > bookedSlot.startTime;
                    });
                    return !isBookedOrPartially;
                  });

                  return (
                    <div
                      key={date.toISOString()}
                      className={`min-h-[100px] border p-2 ${isSameDay(date, new Date()) ? "ring-2 ring-primary" : ""
                        }`}
                    >
                      <div
                        className={`font-bold mb-1 ${isSameDay(date, new Date()) ? "text-primary" : ""
                          }`}
                      >
                        {i + 1}
                      </div>
                      <div className="space-y-1 overflow-y-auto max-h-[80px] scrollbar-thin">
                        {bookedDaySlots.map((slot) => (
                          <div
                            key={`booked-${slot.startTime.toISOString()}`}
                            className="text-xs bg-gray-200 p-1 rounded"
                          >
                            {format(slot.startTime, "HH:mm")} - Booked
                          </div>
                        ))}
                        {displaySlots.map((slot, j) => (
                          <Button
                            key={`avail-${j}`}
                            variant={
                              selectedDaySlots.some(
                                (s) =>
                                  s.startTime.getTime() ===
                                  slot.startTime.getTime(),
                              )
                                ? "default"
                                : "outline"
                            }
                            size="sm"
                            className="w-full text-xs justify-start"
                            onClick={() =>
                              handleSlotSelect(
                                slot.startTime.getHours(),
                                slot.startTime,
                              )
                            }
                            disabled={slot.endTime < new Date()}
                          >
                            {format(slot.startTime, "HH:mm")}
                          </Button>
                        ))}
                      </div>
                    </div>
                  );
                },
              )}
            </div>
          )}

          <div className="flex justify-between items-center mt-4">
            <div className="text-sm text-muted-foreground">
              Timezone: {browserTimezone}
            </div>
            <div className="text-sm ml-auto mr-4">
              Selected: {selectedSlots.length} /{" "}
              {eventType === "webinar"
                ? "1"
                : `${callsPerWeek * 4 * durationInMonths}`}{" "}
              slots
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
                  (eventType === "webinar" && selectedSlots.length !== 1) ||
                  (eventType === "class" &&
                    selectedSlots.length !==
                      callsPerWeek * 4 * durationInMonths)
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
