"use client";

import {
  EventPlannerProps,
  WebinarEvent,
  ClassEvent,
  ConsultationPlanEvent,
  SubscriptionPlanEvent,
  Event,
} from "../types/event";
import { EventPlannerForWebinar } from "./EventPlannerForWebinar";
import { EventPlannerForClass } from "./EventPlannerForClass";
import { EventPlannerForConsultation } from "./EventPlannerForConsultation";
import { EventPlannerForSubscription } from "./EventPlannerForSubscription";

// Update callback types
type WebinarCallback = (
  data: Partial<WebinarEvent>,
  scheduledAt?: string | Date,
) => void;
type ClassCallback = (data: Partial<ClassEvent>, startDate?: string) => void;
type ConsultationCallback = (data: Partial<ConsultationPlanEvent>) => void;
type SubscriptionCallback = (data: Partial<SubscriptionPlanEvent>) => void;

// Add these type guards
function isWebinarEvent(event: Event | undefined): event is WebinarEvent {
  return event?.type === "webinar";
}

function isClassEvent(event: Event | undefined): event is ClassEvent {
  return event?.type === "class";
}

function isConsultationPlanEvent(
  event: Event | undefined,
): event is ConsultationPlanEvent {
  return event?.type === "consultation";
}

function isSubscriptionPlanEvent(
  event: Event | undefined,
): event is SubscriptionPlanEvent {
  return event?.type === "subscription";
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
  onSaved?:
    | WebinarCallback
    | ClassCallback
    | ConsultationCallback
    | SubscriptionCallback;
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

    // Create a wrapper around the save callback to handle topic formats if needed
    const handleWebinarSave = (
      data: Partial<WebinarEvent>,
      scheduledAt?: string | Date,
    ) => {
      // No need for additional validation as we're now using string[] directly

      // Call the original callback with both arguments
      webinarSaveCallback(data, scheduledAt);
    };

    return (
      <EventPlannerForWebinar
        isOpen={isOpen}
        onClose={onClose}
        onSave={handleWebinarSave}
        initialData={webinarInitialData}
        isSaving={isSaving}
        consultantId={consultantId}
      />
    );
  } else if (eventType === "class") {
    // Use type assertion to ensure type safety
    const classSaveCallback = (onSave || onSaved) as ClassCallback;

    if (!classSaveCallback) {
      console.error("No save callback provided to EventPlanner for class");
    }

    // Use the type guard to properly narrow the type
    const classInitialData = isClassEvent(initialData)
      ? initialData
      : undefined;

    // Create a wrapper around the save callback to handle topic formats if needed
    const handleClassSave = (data: Partial<ClassEvent>, startDate?: string) => {
      console.log(
        "EventPlanner - preparing to save class data:",
        JSON.stringify(data, null, 2),
      );
      console.log("EventPlanner - class startDate:", startDate);

      // No need for additional validation as we're now using string[] directly

      // Call the original callback with startDate
      classSaveCallback(data, startDate);
    };

    return (
      <EventPlannerForClass
        isOpen={isOpen}
        onClose={onClose}
        onSave={handleClassSave}
        initialData={classInitialData}
        isSaving={isSaving}
        consultantId={consultantId}
      />
    );
  } else if (eventType === "consultation") {
    // Use type assertion to ensure type safety
    const consultationSaveCallback = (onSave ||
      onSaved) as ConsultationCallback;

    if (!consultationSaveCallback) {
      console.error(
        "No save callback provided to EventPlanner for consultation",
      );
    }

    // Use the type guard to properly narrow the type
    const consultationInitialData = isConsultationPlanEvent(initialData)
      ? initialData
      : undefined;

    // Create a wrapper around the save callback
    const handleConsultationSave = (data: Partial<ConsultationPlanEvent>) => {
      console.log(
        "EventPlanner - preparing to save consultation data:",
        JSON.stringify(data, null, 2),
      );

      // Call the original callback
      consultationSaveCallback(data);
    };

    return (
      <EventPlannerForConsultation
        isOpen={isOpen}
        onClose={onClose}
        onSave={handleConsultationSave}
        initialData={consultationInitialData}
        isSaving={isSaving}
        consultantId={consultantId}
      />
    );
  } else if (eventType === "subscription") {
    // Use type assertion to ensure type safety
    const subscriptionSaveCallback = (onSave ||
      onSaved) as SubscriptionCallback;

    if (!subscriptionSaveCallback) {
      console.error(
        "No save callback provided to EventPlanner for subscription",
      );
    }

    // Use the type guard to properly narrow the type
    const subscriptionInitialData = isSubscriptionPlanEvent(initialData)
      ? initialData
      : undefined;

    // Create a wrapper around the save callback
    const handleSubscriptionSave = (data: Partial<SubscriptionPlanEvent>) => {
      console.log(
        "EventPlanner - preparing to save subscription data:",
        JSON.stringify(data, null, 2),
      );

      // Call the original callback
      subscriptionSaveCallback(data);
    };

    return (
      <EventPlannerForSubscription
        isOpen={isOpen}
        onClose={onClose}
        onSave={handleSubscriptionSave}
        initialData={subscriptionInitialData}
        isSaving={isSaving}
        consultantId={consultantId}
      />
    );
  }

  // Fallback - should not reach here with proper typing
  return null;
}
