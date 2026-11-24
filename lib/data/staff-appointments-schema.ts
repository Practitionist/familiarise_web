/**
 * The staff appointments payload as a Zod schema, shared by the reader that
 * builds it and the screen that parses it. Client-safe: no Prisma here.
 */

import {
  AppointmentStatus,
  BookingSource,
  ClassStatus,
  Currency,
  PaymentGateway,
  PaymentStatus,
  RescheduleInitiatorRole,
  RescheduleRequestStatus,
  TrialStatus,
  WebinarStatus,
} from "@prisma/client";
import { z } from "zod";

/** The row's kind, lowercased from `AppointmentsType`. */
export const STAFF_APPOINTMENT_TYPES = [
  "consultation",
  "subscription",
  "webinar",
  "class",
  "trial",
] as const;
export type StaffAppointmentType = (typeof STAFF_APPOINTMENT_TYPES)[number];

/** The row's status: its lifecycle row's stored status, lowercased. */
const LIFECYCLE_STATUSES = new Set(
  [AppointmentStatus, TrialStatus, WebinarStatus, ClassStatus].flatMap((e) =>
    Object.values(e).map((v) => v.toLowerCase()),
  ),
);

export const STAFF_ISSUE_TYPES = [
  "Removed",
  "Cancelled",
  "Payment pending",
] as const;

const participantSchema = z
  .object({
    id: z.string(),
    name: z.string().nullable(),
    email: z.string().nullable(),
    avatar: z.string().nullable(),
  })
  .nullable();

export const staffAppointmentSchema = z.object({
  id: z.string(),
  type: z.enum(STAFF_APPOINTMENT_TYPES),
  title: z.string(),
  consultant: participantSchema,
  consultee: participantSchema,
  scheduledAt: z.string(),
  endsAt: z.string().optional(),
  duration: z.number(),
  status: z.string().refine((v) => LIFECYCLE_STATUSES.has(v), {
    message: "not a booking status",
  }),
  /** DIRECT_CHECKOUT or REQUEST_SUBMITTED for a 1:1 or plan; null otherwise. */
  bookingSource: z.nativeEnum(BookingSource).nullable(),
  /** Nothing is charged for this booking, so it has no payment to wait for. */
  free: z.boolean(),
  /** The booking was soft-deleted; it is still listed, marked removed. */
  removed: z.boolean(),
  /** A session is parked for ops, so the booking waits on that decision. */
  awaitingDecision: z.boolean(),
  hasIssue: z.boolean(),
  issueType: z.enum(STAFF_ISSUE_TYPES).nullable(),
  payment: z
    .object({
      id: z.string(),
      amount: z.number(),
      currency: z.nativeEnum(Currency),
      status: z.nativeEnum(PaymentStatus),
      gateway: z.nativeEnum(PaymentGateway),
      /** When a pending order's pay window closes. */
      expiresAt: z.string().nullable().optional(),
    })
    .nullable(),
  /** An open reschedule proposal (pending review or countered). */
  reschedule: z
    .object({
      status: z.nativeEnum(RescheduleRequestStatus),
      initiatorRole: z.nativeEnum(RescheduleInitiatorRole),
      expiresAt: z.string(),
    })
    .nullable(),
  createdAt: z.string(),
});
export type StaffAppointment = z.infer<typeof staffAppointmentSchema>;

export const staffAppointmentsPayloadSchema = z.object({
  appointments: z.array(staffAppointmentSchema),
  counts: z.object({
    all: z.number(),
    issues: z.number(),
    scheduled: z.number(),
    completed: z.number(),
  }),
  pagination: z.object({
    total: z.number(),
    page: z.number(),
    limit: z.number(),
    totalPages: z.number(),
    hasMore: z.boolean(),
  }),
});
export type StaffAppointmentsPayload = z.infer<
  typeof staffAppointmentsPayloadSchema
>;
