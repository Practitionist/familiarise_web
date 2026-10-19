import { z } from "zod";

import { SupportPriorityEnum } from "./enums";
import { CASE_TOPICS } from "@/lib/support/case-topic";

/**
 * The back-office Support inbox's wire contract. The client parses every
 * response with these, so a drifted field fails loudly instead of rendering
 * `undefined` into a money column.
 */

export const SupportCaseStatusEnum = z.enum([
  "OPEN",
  "IN_PROGRESS",
  "ESCALATED",
  "ON_HOLD",
  "RESOLVED",
  "CLOSED",
]);

export const SupportChannelEnum = z.enum(["SELF_SERVE", "AI", "HUMAN"]);

export const CaseTopicEnum = z.enum(CASE_TOPICS);

/** The derived SLA state; never stored, so it is read as a plain shape. */
export const SlaStateSchema = z.object({
  ackBreached: z.boolean(),
  resolutionBreached: z.boolean(),
  paused: z.boolean().optional(),
  msToAckDue: z.number().nullable(),
  msToResolutionDue: z.number().nullable(),
});

export const InboxRowSchema = z.object({
  key: z.string().min(1),
  kind: z.literal("case"),
  scope: z.enum(["session", "platform"]),
  requester: z.object({
    id: z.string(),
    name: z.string().nullable(),
    callbackRequested: z.boolean().optional(),
  }),
  subject: z.string(),
  reference: z.string().nullable(),
  topic: CaseTopicEnum,
  status: SupportCaseStatusEnum,
  priority: SupportPriorityEnum.nullable(),
  channel: SupportChannelEnum.nullable(),
  sla: SlaStateSchema.nullable(),
  assignee: z
    .object({ id: z.string(), name: z.string().nullable() })
    .nullable(),
  /** Paise. */
  amount: z.number().int().nullable(),
  currency: z.string().nullable(),
  lastActivityAt: z.string(),
});

export const InboxListResponseSchema = z.object({
  rows: z.array(InboxRowSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  truncated: z.boolean(),
});

export const InboxStatsSchema = z.object({
  openCases: z.number().int().nonnegative(),
  slaBreaches: z.number().int().nonnegative(),
  avgFirstResponseMs: z.number().int().nullable(),
  windowDays: z.number().int().positive(),
});

/** The bulk actions the queue's bulk bar can run over a selection. */
export const CASE_BULK_ACTIONS = ["ASSIGN_TO_ME", "RESOLVE"] as const;
export type CaseBulkAction = (typeof CASE_BULK_ACTIONS)[number];

export const CaseBulkActionEnum = z.enum(CASE_BULK_ACTIONS);

export const CaseBulkRequestSchema = z.object({
  action: CaseBulkActionEnum,
  /** Why the operator did it; the audit row keeps it. */
  reason: z.string().trim().min(5).max(1000),
  caseKeys: z.array(z.string().min(1).max(128)).min(1).max(100),
});

export const CaseBulkOutcomeSchema = z.object({
  caseKey: z.string(),
  status: z.enum(["SUCCEEDED", "FAILED"]),
  code: z.string().optional(),
  error: z.string().optional(),
});

export const CaseBulkResponseSchema = z.object({
  outcomes: z.array(CaseBulkOutcomeSchema),
});

/**
 * The case workspace: the person, the booking, the payment, the transcript
 * and the case's own event stream. The client parses the response with this,
 * so a field that drifts fails loudly instead of rendering `undefined`.
 */
const CaseAuthorSchema = z.enum(["USER", "BOT", "AGENT", "SYSTEM"]);

const TimelineItemSchema = z.object({
  id: z.string(),
  seq: z.number().int().optional(),
  author: CaseAuthorSchema,
  authorName: z.string().nullable(),
  body: z.string(),
  internal: z.boolean(),
  at: z.string(),
});

const CaseHistoryEventSchema = z.object({
  id: z.string(),
  kind: z.string(),
  fromValue: z.string().nullable(),
  toValue: z.string().nullable(),
  note: z.string().nullable(),
  actorName: z.string().nullable(),
  createdAt: z.string(),
});

const CaseBookingSchema = z.object({
  appointmentId: z.string(),
  kind: z.string(),
  title: z.string(),
  expertName: z.string().nullable(),
  learnerName: z.string().nullable(),
  firstStartsAt: z.string().nullable(),
  lastStartsAt: z.string().nullable(),
  status: z.string().nullable(),
});

const CasePaymentSchema = z.object({
  id: z.string(),
  /** Paise. */
  amount: z.number(),
  currency: z.string(),
  status: z.string(),
  createdAt: z.string(),
});

const SentryIssueSummarySchema = z.object({
  shortId: z.string(),
  title: z.string(),
  culprit: z.string().optional(),
  level: z.string().optional(),
  lastSeen: z.string().optional(),
  permalink: z.string(),
});

export const CaseWorkspaceSchema = z.object({
  key: z.string(),
  kind: z.literal("case"),
  caseId: z.string(),
  subject: z.string(),
  reference: z.string().nullable(),
  topic: CaseTopicEnum,
  status: SupportCaseStatusEnum,
  priority: SupportPriorityEnum.nullable(),
  channel: SupportChannelEnum.nullable(),
  assignee: z
    .object({ id: z.string(), name: z.string().nullable() })
    .nullable(),
  sla: SlaStateSchema.nullable(),
  ackDueAt: z.string().nullable(),
  resolutionDueAt: z.string().nullable(),
  lastMessageAt: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  handoffSummary: z.string().nullable().optional(),
  botPromises: z.array(z.string()).optional(),
  duplicateOpenCases: z
    .array(
      z.object({
        id: z.string(),
        reference: z.string(),
        title: z.string(),
        status: z.string(),
      }),
    )
    .optional(),
  events: z.array(CaseHistoryEventSchema).optional(),
  person: z.object({
    id: z.string(),
    name: z.string().nullable(),
    role: z.string().nullable(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    callbackRequested: z.boolean().optional(),
    joinedAt: z.string(),
  }),
  booking: CaseBookingSchema.nullable(),
  payment: CasePaymentSchema.nullable(),
  organization: z.object({ id: z.string(), name: z.string() }).nullable(),
  pastCases: z.array(
    z.object({
      key: z.string(),
      subject: z.string(),
      status: z.string(),
      at: z.string(),
    }),
  ),
  sentryIssues: z
    .object({
      configured: z.boolean(),
      issues: z.array(SentryIssueSummarySchema).nullable(),
    })
    .optional(),
  timeline: z.array(TimelineItemSchema),
  hasMore: z.boolean().optional(),
  nextBeforeSeq: z.number().int().nullable().optional(),
  attachments: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      url: z.string(),
      size: z.number(),
    }),
  ),
});

export const CaseWorkspaceResponseSchema = z.object({
  data: CaseWorkspaceSchema,
});

/** The same shapes, for the server that writes them. */
export type InboxRow = z.infer<typeof InboxRowSchema>;
export type InboxListResponse = z.infer<typeof InboxListResponseSchema>;
export type InboxStats = z.infer<typeof InboxStatsSchema>;
export type CaseBulkOutcome = z.infer<typeof CaseBulkOutcomeSchema>;
