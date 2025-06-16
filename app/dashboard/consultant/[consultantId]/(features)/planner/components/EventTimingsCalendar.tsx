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
  const [sessionDuration, setSessionDuration] = useState<number>(1); // Default 1 hour

  // Fetch session duration based on event type and ID
  useEffect(() => {
    const fetchSessionDuration = async () => {
      try {
        const endpoint = eventType === "webinar" 
          ? `/api/events/webinars/${eventId}` 
          : `/api/events/classes/${eventId}`;
        
        const response = await fetch(endpoint);
        if (response.ok) {
          const data = await response.json();
          
          if (eventType === "webinar") {
            setSessionDuration(data.webinarPlan?.durationInHours || 1);
          } else {
            // For classes, use average of class content durations
            const classContents = data.classPlan?.classContents || [];
            if (classContents.length > 0) {
              const totalHours = classContents.reduce((sum: number, content: any) => sum + content.hoursAllotted, 0);
              setSessionDuration(totalHours / classContents.length);
            } else {
              setSessionDuration(1); // Default fallback
            }
          }
        }
      } catch (error) {
        console.warn("Failed to fetch session duration, using default:", error);
        setSessionDuration(1);
      }
    };

    fetchSessionDuration();
  }, [eventId, eventType]);

  const consultantId = params.consultantId?.toString() || "";
  const requiredSlots = eventType === "webinar" ? 1 : callsPerWeek * 2 * 4 * durationInMonths;

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
              ? "Select one 30-minute time slot for your webinar."
              : `Select ${requiredSlots} time slots (30-min each) for your class.`}
          </DialogDescription>
        </DialogHeader>
        
        <UnifiedCalendar
          consultantId={consultantId}
          eventType={eventType}
          eventId={eventId}
          durationInMonths={durationInMonths}
          callsPerWeek={callsPerWeek}
          sessionDurationInHours={sessionDuration}
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
