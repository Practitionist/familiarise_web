import { z } from "zod";
import { CASE_TOPICS } from "@/lib/support/case-topic";
import type { OwnTicketCase } from "@/types/support-case";

/** The customer's read of their own case (`GET /api/support/requests/c_<id>`). */
export const OwnTicketCaseSchema: z.ZodType<OwnTicketCase> = z.object({
  key: z.string(),
  caseId: z.string(),
  appointmentId: z.string().nullish(),
  filedByOrganizationNotice: z.boolean().optional(),
  canReply: z.boolean().optional(),
  viewerIsPresenter: z.boolean().optional(),
  subject: z.string(),
  reference: z.string().nullable(),
  topic: z.enum(CASE_TOPICS),
  status: z.string(),
  ackDueAt: z.string().nullish(),
  acknowledgedAt: z.string().nullish(),
  resolvedAt: z.string().nullish(),
  csatRating: z.number().nullish(),
  createdAt: z.string(),
  payment: z
    .object({
      id: z.string(),
      amount: z.number(),
      currency: z.string(),
      status: z.string(),
      createdAt: z.string(),
    })
    .nullable(),
  organization: z.object({ id: z.string(), name: z.string() }).nullable(),
  timeline: z.array(
    z.object({
      id: z.string(),
      seq: z.number().optional(),
      author: z.enum(["USER", "BOT", "AGENT", "SYSTEM"]),
      authorName: z.string().nullable(),
      body: z.string(),
      internal: z.boolean(),
      actorKind: z.literal("PRESENTER").optional(),
      at: z.string(),
    }),
  ),
  hasMore: z.boolean().optional(),
  nextBeforeSeq: z.number().nullish(),
});
