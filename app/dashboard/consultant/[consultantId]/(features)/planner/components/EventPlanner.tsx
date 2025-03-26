"use client";

import {
  EventPlannerProps,
  WebinarEvent,
  ClassEvent,
  Event,
} from "../types/event";
import { EventPlannerForWebinar } from "./EventPlannerForWebinar";
import { EventPlannerForClass } from "./EventPlannerForClass";

type WebinarCallback = (data: Partial<WebinarEvent>) => void;
type ClassCallback = (data: Partial<ClassEvent>) => void;

// Add these type guards
function isWebinarEvent(event: Event | undefined): event is WebinarEvent {
  return event?.type === "webinar";
}

function isClassEvent(event: Event | undefined): event is ClassEvent {
  return event?.type === "class";
}

export function EventPlanner({
  eventType,
  initialData,
  isOpen,
  onClose,
  onSave,
  onSaved,
  isSaving,
  consultantId,
}: EventPlannerProps & {
  consultantId: string;
  onSaved?: WebinarCallback | ClassCallback;
}) {
  // Type safe callback selection based on event type
  if (eventType === "webinar") {
    // Use type assertion to ensure type safety
    const webinarSaveCallback = (onSave || onSaved) as WebinarCallback;

    if (!webinarSaveCallback) {
      console.error("No save callback provided to EventPlanner for webinar");
    }

    // Use the type guard to properly narrow the type
    const webinarInitialData = isWebinarEvent(initialData)
      ? initialData
      : undefined;

    return (
      <EventPlannerForWebinar
        isOpen={isOpen}
        onClose={onClose}
        onSave={webinarSaveCallback}
        initialData={webinarInitialData}
        isSaving={isSaving}
        consultantId={consultantId}
      />
    );
  } else {
    // Use type assertion to ensure type safety
    const classSaveCallback = (onSave || onSaved) as ClassCallback;

    if (!classSaveCallback) {
      console.error("No save callback provided to EventPlanner for class");
    }

    // Use the type guard to properly narrow the type
    const classInitialData = isClassEvent(initialData)
      ? initialData
      : undefined;

    return (
      <EventPlannerForClass
        isOpen={isOpen}
        onClose={onClose}
        onSave={classSaveCallback}
        initialData={classInitialData}
        isSaving={isSaving}
        consultantId={consultantId}
      />
    );
  }
}
