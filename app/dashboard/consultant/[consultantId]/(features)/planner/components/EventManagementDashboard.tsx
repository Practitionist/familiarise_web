"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { EventCarousel } from "./EventCarousel";
import { EventPlanner } from "./EventPlanner";
import { WebinarEvent, ClassEvent, Event } from "../types/event";
import { PlannerService } from "../services/planner";
import { useToast } from "@/hooks/use-toast";
import { addMonths, startOfMonth, endOfMonth } from "date-fns";

interface Props {
  consultantId: string;
}

export function EventManagementDashboard({ consultantId }: Readonly<Props>) {
  const [webinars, setWebinars] = useState<WebinarEvent[]>([]);
  const [classes, setClasses] = useState<ClassEvent[]>([]);
  const [isWebinarDialogOpen, setIsWebinarDialogOpen] = useState(false);
  const [isClassDialogOpen, setIsClassDialogOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState<Event | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const { toast } = useToast();
  const [currentDate, setCurrentDate] = useState(new Date());

  // Fetch events on load
  useEffect(() => {
    const fetchEvents = async () => {
      try {
        setIsLoading(true);
        setError(null);

        const startDate = startOfMonth(currentDate);
        const endDate = endOfMonth(currentDate);

        // Use the service to fetch data
        const [fetchedWebinars, fetchedClasses] = await Promise.all([
          PlannerService.fetchWebinars(consultantId, startDate, endDate),
          PlannerService.fetchClasses(consultantId, startDate, endDate),
        ]);

        setWebinars(fetchedWebinars);
        setClasses(fetchedClasses);
      } catch (err) {
        setError(err instanceof Error ? err.message : "An error occurred");
        console.error("Error fetching events:", err);
      } finally {
        setIsLoading(false);
      }
    };

    fetchEvents();
  }, [consultantId, currentDate]);

  // Handle webinar saved event
  const handleWebinarSaved = async (
    data: Partial<WebinarEvent>,
    scheduledAt?: string | Date,
  ) => {
    try {
      setIsSaving(true);
      console.log("EventManagementDashboard - Saving webinar:", {
        data,
        scheduledAt,
      });

      const savedWebinar = await PlannerService.saveWebinar(
        data,
        scheduledAt,
        consultantId,
      );
      console.log("Webinar saved successfully:", savedWebinar);

      // Then fetch updated webinars list
      const updatedWebinars = await PlannerService.fetchWebinars(consultantId);
      setWebinars(updatedWebinars);
      setIsWebinarDialogOpen(false);
      setEditingEvent(null);
    } catch (error) {
      console.error("Error saving/refreshing webinar:", error);
      // Re-throw the error so it can be handled by the form
      throw error;
    } finally {
      setIsSaving(false);
    }
  };

  // Handle class saved event
  const handleClassSaved = async (data: Partial<ClassEvent>) => {
    try {
      setIsSaving(true);
      console.log("EventManagementDashboard - Saving class:", data);

      // First save the class
      const savedClass = await PlannerService.saveClass(data, consultantId);
      console.log("Class saved successfully:", savedClass);

      // Then fetch updated classes list
      const updatedClasses = await PlannerService.fetchClasses(consultantId);
      setClasses(updatedClasses);
      setIsClassDialogOpen(false);
      setEditingEvent(null);
    } catch (error) {
      console.error("Error saving/refreshing class:", error);
      throw error; // Propagate error to form handler
    } finally {
      setIsSaving(false);
    }
  };

  const handleEditWebinar = (webinar: WebinarEvent) => {
    setEditingEvent(webinar);
    setIsWebinarDialogOpen(true);
  };

  const handleEditClass = (classEvent: ClassEvent) => {
    setEditingEvent(classEvent);
    setIsClassDialogOpen(true);
  };

  // Handle webinar delete event
  const handleWebinarDelete = async (webinarId: string) => {
    console.log(`EventManagementDashboard - Deleting webinar: ${webinarId}`);
    try {
      const response = await fetch(
        `/api/events/webinars/crud-with-plan/${webinarId}`,
        {
          method: "DELETE",
        },
      );

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to delete webinar");
      }

      const result = await response.json();
      toast({
        title: "Success",
        description: result.message || "Webinar deleted successfully.",
      });

      // Refresh the list
      setWebinars((prev) => prev.filter((w) => w.id !== webinarId));
    } catch (error) {
      console.error("Error deleting webinar:", error);
      toast({
        title: "Error",
        description:
          error instanceof Error ? error.message : "Failed to delete webinar.",
        variant: "destructive",
      });
      // Re-throw or handle as needed
      throw error;
    }
  };

  // Handle class delete event
  const handleClassDelete = async (classId: string) => {
    console.log(`EventManagementDashboard - Deleting class: ${classId}`);
    try {
      const response = await fetch(
        `/api/events/classes/crud-with-plan/${classId}`,
        {
          method: "DELETE",
        },
      );

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to delete class");
      }

      const result = await response.json();
      toast({
        title: "Success",
        description: result.message || "Class deleted successfully.",
      });

      // Refresh the list
      setClasses((prev) => prev.filter((c) => c.id !== classId));
    } catch (error) {
      console.error("Error deleting class:", error);
      toast({
        title: "Error",
        description:
          error instanceof Error ? error.message : "Failed to delete class.",
        variant: "destructive",
      });
      // Re-throw or handle as needed
      throw error;
    }
  };

  const handleMonthChange = (direction: "prev" | "next") => {
    setCurrentDate((prevDate) =>
      addMonths(prevDate, direction === "prev" ? -1 : 1),
    );
  };

  if (error) {
    return (
      <div className="container mx-auto p-4">
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">
          {error}
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="container mx-auto p-4">
        <div className="animate-pulse space-y-8">
          <div className="h-8 bg-gray-200 rounded w-1/4"></div>
          <div className="space-y-4">
            <div className="h-4 bg-gray-200 rounded w-1/3"></div>
            <div className="h-32 bg-gray-200 rounded"></div>
          </div>
          <div className="space-y-4">
            <div className="h-4 bg-gray-200 rounded w-1/3"></div>
            <div className="h-32 bg-gray-200 rounded"></div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-4">
      <h1 className="text-3xl font-bold mb-8">Event Management Dashboard</h1>

      <div className="flex justify-between items-center mb-4">
        <h2 className="text-2xl font-semibold">
          {currentDate.toLocaleString("default", {
            month: "long",
            year: "numeric",
          })}
        </h2>
        <div className="space-x-2">
          <Button onClick={() => handleMonthChange("prev")}>Previous</Button>
          <Button onClick={() => handleMonthChange("next")}>Next</Button>
        </div>
      </div>

      <div className="mb-8">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-2xl font-semibold">Webinars</h2>
          <Button onClick={() => setIsWebinarDialogOpen(true)}>
            Create New Webinar
          </Button>
        </div>
        <EventCarousel
          events={webinars}
          onEdit={handleEditWebinar}
          onDelete={handleWebinarDelete}
          eventType="webinar"
        />
      </div>

      <div className="mb-8">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-2xl font-semibold">Classes</h2>
          <Button onClick={() => setIsClassDialogOpen(true)}>
            Create New Class
          </Button>
        </div>
        <EventCarousel
          events={classes}
          onEdit={handleEditClass}
          onDelete={handleClassDelete}
          eventType="class"
        />
      </div>

      <EventPlanner
        isOpen={isWebinarDialogOpen}
        onClose={() => {
          setIsWebinarDialogOpen(false);
          setEditingEvent(null);
        }}
        onSaved={handleWebinarSaved}
        eventType="webinar"
        initialData={editingEvent as WebinarEvent}
        consultantId={consultantId}
      />

      <EventPlanner
        isOpen={isClassDialogOpen}
        onClose={() => {
          setIsClassDialogOpen(false);
          setEditingEvent(null);
        }}
        onSaved={handleClassSaved}
        eventType="class"
        initialData={editingEvent as ClassEvent}
        consultantId={consultantId}
      />
    </div>
  );
}
