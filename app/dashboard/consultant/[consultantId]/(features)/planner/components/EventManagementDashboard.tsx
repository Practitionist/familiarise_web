"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { EventCarousel } from "./EventCarousel";
import { EventPlanner } from "./EventPlanner";
import { WebinarEvent, ClassEvent, Event } from "../types/event";

interface Props {
  consultantId: string;
}

export function EventManagementDashboard({ consultantId }: Props) {
  const [webinars, setWebinars] = useState<WebinarEvent[]>([]);
  const [classes, setClasses] = useState<ClassEvent[]>([]);
  const [isWebinarDialogOpen, setIsWebinarDialogOpen] = useState(false);
  const [isClassDialogOpen, setIsClassDialogOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState<Event | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    const fetchEvents = async () => {
      try {
        setIsLoading(true);
        setError(null);

        const [webinarsRes, classesRes] = await Promise.all([
          fetch(`/api/events/webinars?consultantProfileId=${consultantId}`),
          fetch(`/api/events/classes?consultantProfileId=${consultantId}`),
        ]);

        if (!webinarsRes.ok || !classesRes.ok) {
          throw new Error("Failed to fetch events");
        }

        const webinarsData = await webinarsRes.json();
        const classesData = await classesRes.json();

        setWebinars(
          webinarsData.data.map((webinar: any) => ({
            id: webinar.id,
            type: "webinar" as const,
            webinarPlan: webinar.webinarPlan,
            appointment: webinar.appointment,
            waitlist: webinar.waitlist,
            meetingRoom: webinar.meetingRoom,
          })),
        );

        setClasses(
          classesData.data.map((classEvent: any) => ({
            id: classEvent.id,
            type: "class" as const,
            classPlan: classEvent.classPlan,
            appointments: classEvent.appointments,
            waitlist: classEvent.waitlist,
            meetingRoom: classEvent.meetingRoom,
          })),
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : "An error occurred");
        console.error("Error fetching events:", err);
      } finally {
        setIsLoading(false);
      }
    };

    fetchEvents();
  }, [consultantId]);

  const handleSaveWebinar = async (webinarData: Partial<WebinarEvent>) => {
    try {
      setIsSaving(true);
      const response = await fetch("/api/events/webinars", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...webinarData,
          consultantProfileId: consultantId,
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to save webinar");
      }

      const { data } = await response.json();
      const newWebinar: WebinarEvent = {
        id: data.id,
        type: "webinar",
        webinarPlan: data.webinarPlan,
        appointment: data.appointment,
        waitlist: data.waitlist,
        meetingRoom: data.meetingRoom,
      };

      if ("id" in webinarData && webinarData.id) {
        setWebinars(webinars.map((w) => (w.id === data.id ? newWebinar : w)));
      } else {
        setWebinars([...webinars, newWebinar]);
      }

      setIsWebinarDialogOpen(false);
      setEditingEvent(null);
    } catch (err) {
      console.error("Error saving webinar:", err);
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveClass = async (classData: Partial<ClassEvent>) => {
    try {
      setIsSaving(true);
      const response = await fetch("/api/events/classes", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...classData,
          consultantProfileId: consultantId,
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to save class");
      }

      const { data } = await response.json();
      const newClass: ClassEvent = {
        id: data.id,
        type: "class",
        classPlan: data.classPlan,
        appointments: data.appointments,
        waitlist: data.waitlist,
        meetingRoom: data.meetingRoom,
      };

      if ("id" in classData && classData.id) {
        setClasses(classes.map((c) => (c.id === data.id ? newClass : c)));
      } else {
        setClasses([...classes, newClass]);
      }

      setIsClassDialogOpen(false);
      setEditingEvent(null);
    } catch (err) {
      console.error("Error saving class:", err);
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
        onSave={handleSaveWebinar}
        eventType="webinar"
        initialData={editingEvent as WebinarEvent}
        isSaving={isSaving}
      />

      <EventPlanner
        isOpen={isClassDialogOpen}
        onClose={() => {
          setIsClassDialogOpen(false);
          setEditingEvent(null);
        }}
        onSave={handleSaveClass}
        eventType="class"
        initialData={editingEvent as ClassEvent}
        isSaving={isSaving}
      />
    </div>
  );
}
