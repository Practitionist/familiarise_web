/**
 * The staff appointments payload as a Zod schema, shared by the reader that
 * builds it and the screen that parses it. Client-safe: no Prisma here.
 */

import { z } from "zod";

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
  type: z.string(),
  title: z.string(),
  consultant: participantSchema,
  consultee: participantSchema,
  scheduledAt: z.string(),
  endsAt: z.string().optional(),
  duration: z.number(),
  status: z.string(),
  /** DIRECT_CHECKOUT or REQUEST_SUBMITTED for a 1:1 or plan; null otherwise. */
  bookingSource: z.string().nullable(),
  /** Nothing is charged for this booking, so it has no payment to wait for. */
  free: z.boolean(),
  /** The booking was soft-deleted; it is still listed, marked removed. */
  removed: z.boolean(),
  hasIssue: z.boolean(),
  issueType: z.string().nullable(),
  payment: z
    .object({
      id: z.string(),
      amount: z.number(),
      currency: z.string(),
      status: z.string(),
      gateway: z.string(),
      /** When a pending order's pay window closes. */
      expiresAt: z.string().nullable().optional(),
    })
    .nullable(),
  /** An open reschedule proposal (pending review or countered). */
  reschedule: z
    .object({
      status: z.string(),
      initiatorRole: z.string(),
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
