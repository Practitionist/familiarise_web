"use client";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { TimeSlot, getSlotStatus } from "../utils/calendarUtils";
import { Appointment } from "../utils/calendarUtils";

interface SlotButtonProps {
  interval: { hour: number; minute: number };
  date: Date;
  availableSlots: TimeSlot[];
  existingAppointments: Appointment[];
  selectedSlots: TimeSlot[];
  mode: "select" | "view";
  onSlotClick?: (slot: TimeSlot) => void;
  isSlotSelected: (slot: TimeSlot) => boolean;
  intervalMinutes?: number;
}

export function SlotButton({
  interval,
  date,
  availableSlots,
  existingAppointments,
  selectedSlots,
  mode,
  onSlotClick,
  isSlotSelected,
  intervalMinutes = 30,
}: SlotButtonProps) {
  // Get slot status
  const status = getSlotStatus(
    interval,
    date,
    availableSlots,
    existingAppointments,
    intervalMinutes,
  );

  // Create slot object
  const slot: TimeSlot = {
    startTime: new Date(date.getTime()),
    endTime: new Date(date.getTime()),
    isAvailable: status.isAvailable,
    isBooked: status.isBooked,
    isPartiallyBooked: status.isPartiallyBooked,
    isConflicting: status.isConflicting,
  };

  // Set proper times
  slot.startTime.setHours(interval.hour, interval.minute, 0, 0);
  slot.endTime.setHours(interval.hour, interval.minute + intervalMinutes, 0, 0);

  const isCurrentlySelected = isSlotSelected(slot);

  // Determine button state and styling
  let cellClassName = "h-7 w-full text-xs font-medium border transition-colors duration-150";
  let buttonText = "";
  let isDisabled = false;
  let tooltipContent = "";

  // Handle past slots (not available and in past)
  if (!status.isAvailable && !status.isBooked && status.isInPast) {
    return (
      <div className="h-7 w-full bg-gray-100 border border-gray-200 rounded-sm" />
    );
  }

  // Determine styling based on status
  if (
    (status.isBooked || status.isPartiallyBooked) &&
    !isCurrentlySelected
  ) {
    // Booked slots
    if (status.isBooked) {
      cellClassName += " bg-gray-700 text-gray-100 cursor-not-allowed";
      buttonText = "Booked";
    }
  } else if (isCurrentlySelected) {
    // Selected slots - should be BLACK per requirements
    cellClassName += " bg-black text-white cursor-pointer hover:bg-gray-800";
    buttonText = "Selected";
  } else if (status.isBooked) {
    // Fully booked
    cellClassName += " bg-gray-700 text-gray-100 cursor-not-allowed";
    buttonText = "Booked";
  } else if (status.isPartiallyBooked) {
    // Partially booked - YELLOW per requirements
    cellClassName += " bg-yellow-400 text-yellow-900 cursor-not-allowed";
    isDisabled = true;
    buttonText = "Partially Booked";
  } else if (status.isAvailable) {
    // Available slots - GREEN per requirements
    if (mode === "select") {
      cellClassName += " bg-green-300 text-green-950 hover:bg-green-400 border-green-400";
      buttonText = "Available";
    } else {
      cellClassName += " bg-green-300 text-green-950 opacity-50 cursor-not-allowed border-green-400";
      buttonText = "Available";
      isDisabled = true;
    }
  } else {
    // Not available
    cellClassName += " bg-gray-300 text-gray-700 cursor-not-allowed opacity-70";
    isDisabled = true;
  }

  // Set up tooltip
  if (status.overlappingAppointments.length > 0) {
    const appointmentTitles = status.overlappingAppointments
      .map((apt) => apt.title)
      .join(", ");
    tooltipContent = `Overlapping: ${appointmentTitles}`;
  } else if (status.isAvailable && mode === "select") {
    tooltipContent = "Click to select this slot";
  } else if (!status.isAvailable) {
    tooltipContent = "Not available for booking";
  }

  const shouldDisable =
    isDisabled ||
    (status.isInPast && !isCurrentlySelected && mode !== "view");

  const handleClick = () => {
    if (shouldDisable || !onSlotClick) return;
    onSlotClick(slot);
  };

  const buttonElement = (
    <Button
      variant="outline"
      size="sm"
      className={cellClassName}
      onClick={handleClick}
      disabled={shouldDisable}
    >
      {buttonText}
    </Button>
  );

  if (tooltipContent) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            {buttonElement}
          </TooltipTrigger>
          <TooltipContent>
            <p>{tooltipContent}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return buttonElement;
}