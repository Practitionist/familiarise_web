"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useParams } from "next/navigation";
import { UnifiedCalendar } from "../../shared/components/UnifiedCalendar";
import { TAppointment } from "@/types/appointment";

interface EventTimingsCalendarProps {
  isOpen: boolean;
  onClose: () => void;
  appointment: TAppointment;
}

export function EventTimingsCalendar({
  isOpen,
  onClose,
  appointment,
}: EventTimingsCalendarProps) {
  const params = useParams();
  const { toast } = useToast();

  const consultantId = params.consultantId?.toString() || "";

  // Extract event details from appointment
  const getEventDetails = (appointment: TAppointment) => {
    switch (appointment.appointmentType) {
      case "CONSULTATION":
        return {
          eventType: "consultation" as const,
          eventId: appointment.consultation?.id || "",
          callsPerWeek: 1,
          durationInMonths: 1,
          durationInHours: appointment.consultation?.consultationPlan?.durationInHours || 1,
          title: appointment.consultation?.consultationPlan?.title || "Consultation",
        };
      case "SUBSCRIPTION":
        return {
          eventType: "subscription" as const,
          eventId: appointment.subscription?.id || "",
          callsPerWeek: appointment.subscription?.subscriptionPlan?.callsPerWeek || 1,
          durationInMonths: appointment.subscription?.subscriptionPlan?.durationInMonths || 1,
          durationInHours: appointment.subscription?.subscriptionPlan?.sessionDurationInHours || 1,
          title: appointment.subscription?.subscriptionPlan?.title || "Subscription",
        };
      case "WEBINAR":
        return {
          eventType: "webinar" as const,
          eventId: appointment.webinar?.id || "",
          callsPerWeek: 1,
          durationInMonths: 1,
          durationInHours: appointment.webinar?.webinarPlan?.durationInHours || 1,
          title: appointment.webinar?.webinarPlan?.title || "Webinar",
        };
      case "CLASS":
        return {
          eventType: "class" as const,
          eventId: appointment.class?.id || "",
          callsPerWeek: appointment.class?.classPlan?.callsPerWeek || 1,
          durationInMonths: appointment.class?.classPlan?.durationInMonths || 1,
          durationInHours: 2.5, // Default class session duration
          title: appointment.class?.classPlan?.title || "Class",
        };
      default:
        return {
          eventType: "consultation" as const,
          eventId: "",
          callsPerWeek: 1,
          durationInMonths: 1,
          durationInHours: 1,
          title: "Event",
        };
    }
  };

  const eventDetails = getEventDetails(appointment);

  const handleAllocationComplete = () => {
    toast({
      title: "Success",
      description: "Timings allocated successfully",
    });
    onClose();
  };

  const getDescriptionText = () => {
    switch (appointment.appointmentType) {
      case "CONSULTATION":
        return "Select time slots for your consultation session.";
      case "SUBSCRIPTION":
        return `Schedule ${eventDetails.callsPerWeek} call${eventDetails.callsPerWeek !== 1 ? "s" : ""} per week for ${eventDetails.durationInMonths} month${eventDetails.durationInMonths !== 1 ? "s" : ""}.`;
      case "WEBINAR":
        return "Select consecutive time slots matching your webinar duration.";
      case "CLASS":
        return "Schedule class sessions by selecting appropriate time slots.";
      default:
        return "Select time slots for your event.";
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-7xl">
        <DialogHeader>
          <DialogTitle>
            Manage {eventDetails.title} Timings
          </DialogTitle>
          <DialogDescription>
            {getDescriptionText()}
          </DialogDescription>
        </DialogHeader>

        <UnifiedCalendar
          consultantId={consultantId}
          eventType={eventDetails.eventType}
          eventId={eventDetails.eventId}
          durationInMonths={eventDetails.durationInMonths}
          callsPerWeek={eventDetails.callsPerWeek}
          sessionDurationInHours={eventDetails.durationInHours}
          mode="allocate"
          onAllocationComplete={handleAllocationComplete}
          showAllocationButtons={true}
          className="min-h-[500px]"
        />

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}