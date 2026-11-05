/**
 * Stream Chat v9 Module Augmentation
 *
 * This file extends the base Stream Chat types using module augmentation
 * as required by stream-chat v9.0.0+. The generics mechanism was removed
 * in v9 in favor of this pattern.
 *
 * @see https://getstream.io/chat/docs/sdk/react/guides/typescript_and_custom_data_types/
 */

import "stream-chat";

declare module "stream-chat" {
  /**
   * Custom user data extension for Stream Chat users.
   * These fields are added to the user object when creating/updating users.
   * Note: Stream Chat roles are strings (e.g., "admin", "user"), not Prisma enum values.
   */
  interface CustomUserData {
    // Never sent (see lib/stream/user-payload.ts); typed only so stream-sync can unset older copies.
    email?: string | null;
  }

  /**
   * Custom channel data extension for Stream Chat channels.
   * Used to link channels to app entities (events, appointments, etc.)
   */
  interface CustomChannelData {
    // Standard channel properties
    name?: string;
    image?: string;
    // Event channel linking
    webinar_id?: string;
    class_id?: string;
    consultation_id?: string;
    subscription_id?: string;
    // Custom channel flag
    custom?: boolean;
    // Channel metadata
    title?: string;
    description?: string;
    // DM pair channel linking
    dm_consultant_user_id?: string;
    dm_consultee_user_id?: string;
    // Org scope stamped on org-context channels
    organization_id?: string;
  }

  /**
   * Custom message data extension for Stream Chat messages.
   */
  interface CustomMessageData {
    /** Set on staff posts sent as the Familiarise Support user. */
    support_message?: boolean;
    /** Names a support system message: `support_joined` / `support_left`. */
    support_event?: "support_joined" | "support_left";
    /** The booking a DM message is tagged with; client-written, so it is only a lookup key. */
    booking_appointment_id?: string;
    custom?: { booking_appointment_id?: string };
  }
}

/**
 * Channel type identifiers used in the application.
 */
export type StreamChannelType =
  | "messaging" // DMs and general messaging
  | "team"; // Team channels (webinars, classes)

/**
 * Event channel types for linking to app entities.
 */
export type EventChannelType =
  "webinar" | "class" | "consultation" | "subscription";
