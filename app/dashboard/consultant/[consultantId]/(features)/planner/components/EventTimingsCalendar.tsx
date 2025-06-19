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
import { useParams } from "next/navigation";
import { useState, useEffect } from "react";
import { UnifiedCalendar } from "../../shared/components/UnifiedCalendar";
import { TimeSlot } from "../../shared/utils/calendarUtils";

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
  const [selectedSlots, setSelectedSlots] = useState<TimeSlot[]>([]);
  const [saving, setSaving] = useState(false);

  const consultantId = params.consultantId?.toString() || "";
  // For elongated slots, we don't need to calculate specific slot counts
  // The UnifiedCalendar will handle session duration requirements
  const requiredSlots = eventType === "webinar" ? 1 : callsPerWeek * durationInMonths;

  const handleAllocationComplete = (result: any) => {
    toast({
      title: "Success",
      description: "Timings allocated successfully",
    });
    onClose();
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
              ? "Select consecutive time slots matching your webinar duration."
              : `Create ${requiredSlots} complete session${requiredSlots !== 1 ? 's' : ''} by selecting 5 consecutive time slots for each 2.5-hour session.`}
          </DialogDescription>
        </DialogHeader>
        
        <UnifiedCalendar
          consultantId={consultantId}
          eventType={eventType}
          eventId={eventId}
          durationInMonths={durationInMonths}
          callsPerWeek={callsPerWeek}
          mode="allocate"
          onAllocationComplete={handleAllocationComplete}
          showAllocationButtons={true}
          className="min-h-[500px]"
        />
        
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
