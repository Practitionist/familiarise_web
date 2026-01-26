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
import type { User } from "@prisma/client";

declare module "stream-chat" {
  /**
   * Custom user data extension for Stream Chat users.
   * These fields are added to the user object when creating/updating users.
   * Note: Stream Chat roles are strings (e.g., "admin", "user"), not Prisma enum values.
   */
  interface CustomUserData {
    // Stream Chat role (not Prisma role)
    // Email is also custom data we pass
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
  }

  /**
   * Custom message data extension for Stream Chat messages.
   */
  interface CustomMessageData {
    // Add custom message fields here if needed
  }

  /**
   * Custom attachment data extension for Stream Chat attachments.
   */
  interface CustomAttachmentData {
    // Add custom attachment fields here if needed
  }

  /**
   * Custom reaction data extension for Stream Chat reactions.
   */
  interface CustomReactionData {
    // Add custom reaction fields here if needed
  }

  /**
   * Custom event data extension for Stream Chat events.
   */
  interface CustomEventData {
    // Add custom event fields here if needed
  }

  /**
   * Custom command data extension for Stream Chat commands.
   */
  interface CustomCommandData {
    // Add custom command fields here if needed
  }

  /**
   * Custom poll option data extension.
   */
  interface CustomPollOptionData {
    // Add custom poll option fields here if needed
  }

  /**
   * Custom poll data extension.
   */
  interface CustomPollData {
    // Add custom poll fields here if needed
  }
}

/**
 * Application-level type for Stream Chat users.
 * Used throughout the app for type-safe user handling.
 */
export type StreamChatUser = {
  id: string;
  name?: string;
  image?: string;
  email?: string | null;
  role?: string; // Stream Chat role string (e.g., "admin", "user")
};

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
  | "webinar"
  | "class"
  | "consultation"
  | "subscription";
