/**
 * The moderation queue's response bodies as Zod schemas, shared by the routes
 * that build them and `ModerationPage`, which parses every body so a malformed
 * 200 shows the error state. Client-safe: no Prisma client, only its enums.
 */

import {
  ModerationActionType,
  ModerationReportStatus,
  ModerationReportType,
  ReviewActor,
  UserRole,
} from "@prisma/client";
import { z } from "zod";

import { LinkedReportCaseSchema } from "@/schemas/moderation";

const instant = z
  .union([z.string(), z.date()])
  .transform((v) => (typeof v === "string" ? v : v.toISOString()));
const optionalInstant = instant.nullable();

const stepStatus = z.enum(["ok", "failed", "skipped", "gave_up"]);
export type ModerationStepStatus = z.infer<typeof stepStatus>;

/** The persisted outcome of an action's side-effects (`lib/moderation/side-effects.ts`). */
export const moderationSideEffectsSchema = z
  .object({
    sessionsRevoked: z.number().optional(),
    earningsHeld: z.number().optional(),
    profilesUnverified: z.number().optional(),
    reviewRemoved: z.boolean().optional(),
    banExpires: z.string().nullable().optional(),
    cancellations: z
      .object({
        engagementsCancelled: z.number().optional(),
        refundsIssued: z.number().optional(),
      })
      .optional(),
    collaborationsRemoved: z
      .array(z.object({ planType: z.string(), planId: z.string() }))
      .optional(),
    collaboratorRevocation: stepStatus.optional(),
    stream: stepStatus.optional(),
    streamAttempts: z.number().optional(),
    notification: stepStatus.optional(),
    errors: z.array(z.string()).optional(),
  })
  .passthrough();
export type ModerationSideEffects = z.infer<typeof moderationSideEffectsSchema>;

/** A stored side-effect summary (a JSON column): read as the schema, or null when it is not one. */
const storedSideEffects = z
  .unknown()
  .transform((v): ModerationSideEffects | null => {
    const parsed = moderationSideEffectsSchema.safeParse(v);
    return parsed.success ? parsed.data : null;
  });

const latestActionSchema = z.object({
  id: z.string(),
  actionType: z.nativeEnum(ModerationActionType),
  createdAt: instant,
  sideEffects: storedSideEffects,
  notes: z.string().nullable(),
  takenBy: z.object({ name: z.string().nullable() }).nullable(),
});
export type ModerationLatestAction = z.infer<typeof latestActionSchema>;

const reviewSubjectSchema = z.object({
  id: z.string(),
  rating: z.number(),
  reviewDescription: z.string().nullable(),
  appointmentId: z.string().nullable(),
  consultantProfile: z.object({
    user: z.object({ name: z.string().nullable() }),
  }),
});

const reportPersonSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  email: z.string(),
  image: z.string().nullable(),
  role: z.nativeEnum(UserRole),
});

/** One report as `GET /api/staff/moderation/reports` lists it. */
export const moderationReportItemSchema = z.object({
  id: z.string(),
  type: z.nativeEnum(ModerationReportType),
  status: z.nativeEnum(ModerationReportStatus),
  reason: z.string(),
  description: z.string().nullable(),
  contentText: z.string().nullable(),
  contentUrl: z.string().nullable(),
  streamMessageId: z.string().nullable(),
  streamChannelCid: z.string().nullable(),
  reportCount: z.number(),
  reportedBy: reportPersonSchema,
  targetUser: reportPersonSchema.extend({
    banned: z.boolean().nullable(),
    banExpires: optionalInstant,
  }),
  reviewId: z.string().nullable(),
  review: reviewSubjectSchema.nullable(),
  contextSignals: z
    .object({
      hasRefund: z.boolean(),
      hasOpenTicket: z.boolean(),
      hasDispute: z.boolean(),
    })
    .nullable(),
  organizationId: z.string().nullable(),
  assignedToId: z.string().nullable(),
  actionCount: z.number(),
  latestAction: latestActionSchema.nullable(),
  supportCase: LinkedReportCaseSchema.nullable(),
  createdAt: instant,
  resolvedAt: optionalInstant,
});
export type ModerationReport = z.infer<typeof moderationReportItemSchema>;

const pageMeta = z.object({
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  limit: z.number().int().positive(),
  totalPages: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});

export const moderationReportsPageSchema = z.object({
  reports: z.array(moderationReportItemSchema),
  counts: z.object({
    total: z.number(),
    pending: z.number(),
    underReview: z.number(),
    dismissed: z.number(),
    actionTaken: z.number(),
    escalated: z.number(),
  }),
  capabilities: z.object({ canModerateUsers: z.boolean() }),
  pagination: pageMeta,
});
export type ModerationReportsPage = z.infer<typeof moderationReportsPageSchema>;
/** What the route builds: instants may still be Dates. */
export type ModerationReportsPageInput = z.input<
  typeof moderationReportsPageSchema
>;

/** `GET /api/staff/moderation/reports/[reportId]`: the history and booking context the drawer reads. */
export const moderationReportDetailSchema = z.object({
  report: z.object({
    id: z.string(),
    actions: z.array(
      z.object({
        id: z.string(),
        actionType: z.nativeEnum(ModerationActionType),
        notes: z.string().nullable(),
        createdAt: instant,
        sideEffects: storedSideEffects,
        // A departed staff account leaves this null, not the row.
        takenBy: z
          .object({
            id: z.string(),
            name: z.string().nullable(),
            email: z.string(),
          })
          .nullable(),
      }),
    ),
    supportCase: LinkedReportCaseSchema.nullable(),
    bookingContext: z
      .object({
        appointmentId: z.string(),
        appointmentStatus: z.string(),
        refundCount: z.number(),
        latestRefundStatus: z.string().nullable(),
        hasDispute: z.boolean(),
        openSupportCount: z.number(),
        signals: z.array(z.string()),
      })
      .nullable(),
    exclusionDropsBelowGate: z.boolean(),
  }),
});
export type ModerationReportDetail = z.infer<
  typeof moderationReportDetailSchema
>["report"];

const reviewActionSchema = z.object({
  actionType: z.nativeEnum(ModerationActionType),
  notes: z.string().nullable(),
  createdAt: instant,
  takenBy: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
});

/**
 * One review on the moderation queue. The reviewer's name is sent to staff
 * even when the review is anonymous to the public; the screen says so.
 */
export const moderationReviewItemSchema = z.object({
  id: z.string(),
  rating: z.number(),
  reviewDescription: z.string().nullable(),
  consultant: z.object({
    profileId: z.string(),
    name: z.string().nullable(),
    email: z.string(),
    image: z.string().nullable(),
  }),
  reviewer: z.object({
    profileId: z.string(),
    name: z.string().nullable(),
    image: z.string().nullable(),
  }),
  createdAt: instant,
  deletedAt: optionalInstant,
  removedBy: z.nativeEnum(ReviewActor).nullable(),
  isAnonymous: z.boolean(),
  replyBody: z.string().nullable(),
  repliedAt: optionalInstant,
  replyDeletedAt: optionalInstant,
  replyRemovedBy: z.nativeEnum(ReviewActor).nullable(),
  editedAt: optionalInstant,
  moderationActions: z.array(reviewActionSchema),
});
export type ModerationReview = z.infer<typeof moderationReviewItemSchema>;

export const moderationReviewsPageSchema = z.object({
  reviews: z.array(moderationReviewItemSchema),
  distribution: z.record(z.number()),
  pagination: pageMeta,
});
export type ModerationReviewsPageInput = z.input<
  typeof moderationReviewsPageSchema
>;

/** The four stat-card counters, inside the stats route's `stats` envelope. */
export const moderationStatsSchema = z.object({
  pendingReports: z.number().int().nonnegative(),
  pendingProfiles: z.number().int().nonnegative(),
  pendingReviews: z.number().int().nonnegative(),
  resolvedToday: z.number().int().nonnegative(),
});
export type ModerationStats = z.infer<typeof moderationStatsSchema>;

export const moderationStatsBodySchema = z.object({
  stats: moderationStatsSchema,
  reportsByType: z.array(
    z.object({ type: z.nativeEnum(ModerationReportType), count: z.number() }),
  ),
  actionsByType: z.array(
    z.object({
      actionType: z.nativeEnum(ModerationActionType),
      count: z.number(),
    }),
  ),
  period: z.object({
    days: z.number(),
    startDate: instant,
    endDate: instant,
  }),
});
export type ModerationStatsBody = z.input<typeof moderationStatsBodySchema>;
