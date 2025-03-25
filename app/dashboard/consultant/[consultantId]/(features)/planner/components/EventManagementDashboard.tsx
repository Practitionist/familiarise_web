"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { EventCarousel } from "./EventCarousel";
import { EventPlanner } from "./EventPlanner";
import { WebinarEvent, ClassEvent, Event } from "../types/event";
import { PlannerService } from "../services/planner";

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

  // Fetch events on load
  useEffect(() => {
    const fetchEvents = async () => {
      try {
        setIsLoading(true);
        setError(null);

        // Use the service to fetch data
        const [fetchedWebinars, fetchedClasses] = await Promise.all([
          PlannerService.fetchWebinars(consultantId),
          PlannerService.fetchClasses(consultantId),
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
  }, [consultantId]);

  // Handle webinar saved event
  const handleWebinarSaved = (newWebinar: Partial<WebinarEvent>) => {
    if (!newWebinar.id) return; // Guard against missing ID

    if (editingEvent && editingEvent.type === "webinar") {
      // Update existing webinar
      setWebinars(
        webinars.map((w) =>
          w.id === newWebinar.id
            ? ({ ...w, ...newWebinar } as WebinarEvent)
            : w,
        ),
      );
    } else {
      // Add new webinar
      setWebinars([...webinars, newWebinar as WebinarEvent]);
    }
    setIsWebinarDialogOpen(false);
    setEditingEvent(null);
  };

  // Handle class saved event
  const handleClassSaved = (newClass: Partial<ClassEvent>) => {
    if (!newClass.id) return; // Guard against missing ID

    if (editingEvent && editingEvent.type === "class") {
      // Update existing class
      setClasses(
        classes.map((c) =>
          c.id === newClass.id ? ({ ...c, ...newClass } as ClassEvent) : c,
        ),
      );
    } else {
      // Add new class
      setClasses([...classes, newClass as ClassEvent]);
    }
    setIsClassDialogOpen(false);
    setEditingEvent(null);
  };

  const handleEditWebinar = (webinar: WebinarEvent) => {
    setEditingEvent(webinar);
    setIsWebinarDialogOpen(true);
  };

  const handleEditClass = (classEvent: ClassEvent) => {
    setEditingEvent(classEvent);
    setIsClassDialogOpen(true);
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
