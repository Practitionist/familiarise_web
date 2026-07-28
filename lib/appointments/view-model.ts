import type { TAppointment } from "@/types/appointment";

/**
 * Normalized appointment view-model shared by the consultant and consultee
 * appointments surfaces. The two dashboards read very different shapes
 * (consultee: 5-type grouped union; consultant: flat TAppointment[] plus
 * trials/unscheduled side-queries) — each side has a mapper into this VM so
 * the list/hero/sheet/calendar components render one type.
 */

export type AppointmentKind =
  | "CONSULTATION"
  | "SUBSCRIPTION"
  | "WEBINAR"
  | "CLASS"
  | "TRIAL";

export type AppointmentBucket =
  | "upcoming"
  | "needsAction"
  | "past"
  | "cancelled";

export type NeedsActionReason =
  | "PAY_NOW"
  | "PENDING_APPROVAL"
  | "UNSCHEDULED"
  | "TENTATIVE";

/**
 * Minimal structural slot shape. Both Prisma's bare SlotOfAppointment and
 * the relation-carrying TSlotOfAppointment satisfy it, and API payloads may
 * deliver dates as ISO strings — consumers must go through `new Date(...)`.
 */
export interface SlotLike {
  id: string;
  appointmentId?: string | null;
  startsAt: Date | string;
  endsAt?: Date | string | null;
  isTentative: boolean;
  completionStatus?: string | null;
  meetingSession?: { id: string; endedAt: Date | string | null } | null;
}

export interface SessionVM {
  slotId: string;
  /** Owning appointment — differs per session inside subscription/class groups. */
  appointmentId: string | null;
  startsAt: Date;
  endsAt: Date | null;
  isTentative: boolean;
  /** Raw SlotCompletionStatus (CANCELLED/RESCHEDULED mark a dead session). */
  completionStatus: string | null;
  /** Meeting ended early by the host — session is over regardless of endsAt. */
  meetingEndedAt: Date | null;
}

export interface PersonVM {
  name: string;
  image: string | null;
}

export interface AppointmentVMRaw {
  /** What the existing action hooks (join/cancel/reschedule/timings) consume. */
  appointment?: TAppointment;
  /** Future/ongoing slots in action-hook shape (consultee useEventActions input). */
  rawSlots?: SlotLike[];
  /** All child appointments of a subscription/class group, sorted. */
  groupAppointments?: TAppointment[];
  /** The original role-specific list item (trial, unscheduled event, …). */
  source?: unknown;
}

export interface AppointmentVM {
  /** Stable row key — synthetic for unscheduled rows. */
  id: string;
  /** Null ⇒ no detail page exists for this row (Sheet-only). */
  appointmentId: string | null;
  kind: AppointmentKind;
  title: string;
  /** The "other side" — consultant for consultee views, consultee/host for consultant views. */
  counterpart: PersonVM;
  /** Normalized (uppercase) lifecycle status from the owning event's enum. */
  status: string;
  bucket: AppointmentBucket;
  needsActionReason: NeedsActionReason | null;
  /** Sort/day-group anchor: next upcoming session, else the most recent one. */
  nextAt: Date | null;
  /** Full session timeline (all slots, past + future), chronological. */
  sessions: SessionVM[];
  /** Multi-session (subscription/class) progress; null for one-off events. */
  group: { total: number; completed: number } | null;
  /** Secondary descriptor line (plan cadence, duration, …). */
  meta: string | null;
  organizationId: string | null;
  pendingPaymentUrl: string | null;
  collaborators: Array<PersonVM & { role: string }>;
  /** Consultant view: the viewer's own role on a collaborative event. */
  collaboratorRole: string | null;
  raw: AppointmentVMRaw;
}

export function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

export function toDateOrNull(
  value: Date | string | null | undefined,
): Date | null {
  return value === null || value === undefined ? null : toDate(value);
}

export function toSessionVM(slot: SlotLike): SessionVM {
  return {
    slotId: slot.id,
    appointmentId: slot.appointmentId ?? null,
    startsAt: toDate(slot.startsAt),
    endsAt: toDateOrNull(slot.endsAt),
    isTentative: slot.isTentative,
    completionStatus: slot.completionStatus ?? null,
    meetingEndedAt: toDateOrNull(slot.meetingSession?.endedAt),
  };
}

export function sortSessions(sessions: SessionVM[]): SessionVM[] {
  return [...sessions].sort(
    (a, b) => a.startsAt.getTime() - b.startsAt.getTime(),
  );
}
