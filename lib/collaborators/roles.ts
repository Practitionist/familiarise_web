import type { CollaboratorRole, CollaboratorTier } from "@prisma/client";

/**
 * The one co-presenter a plan may carry. Its own module so call, recording
 * and access code can read it without the service's notification graph.
 */
export const PRESENTER_ROLES: readonly CollaboratorRole[] = [
  "CO_HOST",
  "CO_INSTRUCTOR",
];

/** Host controls (end for everyone, record) reach presenters only. */
export function isPresenterRole(role: CollaboratorRole): boolean {
  return PRESENTER_ROLES.includes(role);
}

/** The tier a role grants; written on every create and change of role. */
export function tierForRole(role: CollaboratorRole): CollaboratorTier {
  return isPresenterRole(role) ? "PRESENTER" : "CREW";
}

/** Crew who join a session able to speak, show video and share a screen; other crew join as attendees. */
export const SPEAKING_CREW_ROLES: readonly CollaboratorRole[] = [
  "GUEST_SPEAKER",
  "GUEST_LECTURER",
  "TEACHING_ASSISTANT",
];

export function isSpeakingCrew(role: CollaboratorRole): boolean {
  return SPEAKING_CREW_ROLES.includes(role);
}

export type CollaboratorRoleInfo = {
  label: string;
  summary: string;
  can: readonly string[];
};

const PRESENTER_CAN = [
  "Presents with the host and can record or end the session",
  "Sees who is attending and the attendance record",
  "Joins the team chat and moderates each session's chat",
] as const;

const SPEAKING_CAN = [
  "Joins each session able to speak, show video and share a screen",
  "Joins the team chat and each session's chat",
] as const;

const SUPPORT_CAN = [
  "Joins each session as an attendee",
  "Joins the team chat and each session's chat",
] as const;

/** What each role is called and what it grants, for the screens and the emails. */
export const ROLE_INFO: Record<CollaboratorRole, CollaboratorRoleInfo> = {
  CO_HOST: {
    label: "Co-host",
    summary: "Runs the webinar alongside the host.",
    can: PRESENTER_CAN,
  },
  CO_INSTRUCTOR: {
    label: "Co-instructor",
    summary: "Teaches the class alongside the instructor.",
    can: PRESENTER_CAN,
  },
  GUEST_SPEAKER: {
    label: "Guest speaker",
    summary: "Speaks during the webinar.",
    can: SPEAKING_CAN,
  },
  GUEST_LECTURER: {
    label: "Guest lecturer",
    summary: "Teaches part of the class.",
    can: SPEAKING_CAN,
  },
  TEACHING_ASSISTANT: {
    label: "Teaching assistant",
    summary: "Helps learners during the class.",
    can: SPEAKING_CAN,
  },
  MODERATOR: {
    label: "Moderator",
    summary: "Keeps the session's chat in order.",
    can: [
      "Moderates each session's chat",
      "Joins each session as an attendee",
      "Joins the team chat",
    ],
  },
  TECHNICAL_SUPPORT: {
    label: "Technical support",
    summary: "Helps with setup and troubleshooting.",
    can: SUPPORT_CAN,
  },
  CONTENT_CREATOR: {
    label: "Content creator",
    summary: "Prepares the class material.",
    can: SUPPORT_CAN,
  },
};
