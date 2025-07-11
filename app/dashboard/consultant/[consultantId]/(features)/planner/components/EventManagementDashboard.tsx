"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { EventCarousel } from "./EventCarousel";
import { EventPlanner } from "./EventPlanner";
import { WebinarEvent, ClassEvent, Event } from "../types/event";
import { PlannerService } from "../services/planner";
import { useToast } from "@/hooks/use-toast";
import { useWebinarMutations, useClassMutations, usePlannerRefresh } from "../../../hooks/usePlanner";

interface PlannerData {
  webinars: any[];
  classes: any[];
  participantCounts: Record<string, number>;
}
import { addMonths, startOfMonth, endOfMonth } from "date-fns";

interface Props {
  consultantId: string;
  initialData?: PlannerData;
}

export function EventManagementDashboard({ consultantId, initialData }: Readonly<Props>) {
  const [webinars, setWebinars] = useState<WebinarEvent[]>(initialData?.webinars || []);
  const [classes, setClasses] = useState<ClassEvent[]>(initialData?.classes || []);
  const [isWebinarDialogOpen, setIsWebinarDialogOpen] = useState(false);
  const [isClassDialogOpen, setIsClassDialogOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState<Event | null>(null);
  const [isLoading, setIsLoading] = useState(!initialData);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const { toast } = useToast();
  
  // React Query mutations
  const { deleteWebinar } = useWebinarMutations(consultantId);
  const { deleteClass } = useClassMutations(consultantId);
  const { refreshPlanner } = usePlannerRefresh(consultantId);
  const [currentDate, setCurrentDate] = useState(new Date());

  // Fetch events on load only if no initial data
  useEffect(() => {
    if (initialData) {
      setWebinars(initialData.webinars);
      setClasses(initialData.classes);
      setIsLoading(false);
      return;
    }

    const fetchEvents = async () => {
      try {
        setIsLoading(true);
        setError(null);

        const startDate = startOfMonth(currentDate);
        const endDate = endOfMonth(currentDate);

        // Use the service to fetch data
        const [fetchedWebinars, fetchedClasses] = await Promise.all([
          PlannerService.fetchWebinars(consultantId),
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
  }, [consultantId, initialData, currentDate]);

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

      // Refresh planner data with React Query
      refreshPlanner();
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

      // Refresh planner data with React Query
      refreshPlanner();
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

  // Handle webinar delete event using React Query
  const handleWebinarDelete = async (webinarId: string) => {
    console.log(`EventManagementDashboard - Deleting webinar: ${webinarId}`);
    deleteWebinar.mutate(webinarId);
  };

  // Handle class delete event using React Query
  const handleClassDelete = async (classId: string) => {
    console.log(`EventManagementDashboard - Deleting class: ${classId}`);
    deleteClass.mutate(classId);
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
          participantCounts={initialData?.participantCounts || {}}
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
          participantCounts={initialData?.participantCounts || {}}
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
