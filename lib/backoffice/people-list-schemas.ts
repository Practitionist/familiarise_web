/**
 * The back-office people and comms lists' response bodies as Zod schemas,
 * shared by the routes that build them and the screens that parse them.
 * Client-safe: no Prisma client, only its enums.
 */

import {
  FundingSource,
  LeadStatus,
  NewsletterSource,
  NewsletterStatus,
  OrgStatus,
  PlatformFeedbackStatus,
  ProfileVerificationStatus,
  UserRole,
} from "@prisma/client";
import { z } from "zod";

const pageMeta = z.object({
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  limit: z.number().int().positive(),
  totalPages: z.number().int().nonnegative(),
});

const verificationDocumentSchema = z.object({
  id: z.string(),
  fileName: z.string(),
  originalName: z.string(),
  fileSize: z.number(),
  mimeType: z.string(),
  description: z.string().nullable(),
});

const verificationConsultantSchema = z.object({
  profileId: z.string(),
  userId: z.string(),
  name: z.string().nullable(),
  email: z.string(),
  image: z.string().nullable(),
  linkedinUrl: z.string().nullable(),
  bio: z.string().nullable(),
  domain: z.string(),
  subDomains: z.array(z.object({ id: z.string(), name: z.string() })),
  experience: z.number().nullable(),
  headline: z.string().nullable(),
  description: z.string().nullable(),
  isVerified: z.boolean(),
  verificationStatus: z.string(),
  workExperiences: z.array(
    z.object({
      id: z.string(),
      company: z.string(),
      title: z.string(),
      startDate: z.string(),
      endDate: z.string().nullable(),
      current: z.boolean(),
    }),
  ),
  education: z.array(
    z.object({
      id: z.string(),
      institution: z.string(),
      degree: z.string(),
      field: z.string(),
      startYear: z.number(),
      endYear: z.number().nullable(),
    }),
  ),
  certifications: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      issuer: z.string(),
      issueDate: z.string(),
    }),
  ),
});

/** One request in the expert verification queue; documents carry no stored URL. */
export const verificationItemSchema = z.object({
  id: z.string(),
  status: z.nativeEnum(ProfileVerificationStatus),
  submittedAt: z.string(),
  notes: z.string().nullable(),
  rejectionReason: z.string().nullable().optional(),
  feedbackDetails: z.string().nullable().optional(),
  consultant: verificationConsultantSchema,
  documents: z.array(verificationDocumentSchema),
  reviewedAt: z.string().nullable(),
  reviewedById: z.string().nullable(),
  reviewNotes: z.string().nullable(),
});
export type VerificationItem = z.infer<typeof verificationItemSchema>;

export const verificationQueuePageSchema = z.object({
  verifications: z.array(verificationItemSchema),
  counts: z.object({
    total: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    approved: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
    needsInfo: z.number().int().nonnegative(),
  }),
  pagination: pageMeta.extend({ hasMore: z.boolean() }),
});
export type VerificationQueuePage = z.infer<typeof verificationQueuePageSchema>;

export const organizationListItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  status: z.nativeEnum(OrgStatus),
  canSponsor: z.boolean(),
  canHost: z.boolean(),
  billingEmail: z.string().nullable(),
  createdAt: z.string(),
  billingAccount: z
    .object({ id: z.string(), fundingSource: z.nativeEnum(FundingSource) })
    .nullable(),
  _count: z.object({ memberships: z.number(), contracts: z.number() }),
});
export type OrganizationListItem = z.infer<typeof organizationListItemSchema>;

export const organizationListPageSchema = z.object({
  data: z.array(organizationListItemSchema),
  pagination: z.object({
    total: z.number().int().nonnegative(),
    page: z.number().int().positive(),
    limit: z.number().int().positive(),
    pages: z.number().int().nonnegative(),
  }),
});
export type OrganizationListPage = z.infer<typeof organizationListPageSchema>;

export const subscriberPageSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      email: z.string(),
      name: z.string().nullable(),
      status: z.nativeEnum(NewsletterStatus),
      source: z.nativeEnum(NewsletterSource),
      tags: z.array(z.string()),
      confirmedAt: z.string().nullable(),
      unsubscribedAt: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  perPage: z.number().int().positive(),
  stats: z.object({
    PENDING: z.number(),
    SUBSCRIBED: z.number(),
    UNSUBSCRIBED: z.number(),
    BOUNCED: z.number(),
  } satisfies Record<NewsletterStatus, z.ZodNumber>),
});
export type SubscriberPage = z.infer<typeof subscriberPageSchema>;

/** `POST /api/admin/newsletter/broadcast` with `mode: "preview"`. */
export const audiencePreviewSchema = z.object({
  matching: z.number(),
  sendable: z.number(),
  skippedNoConsent: z.number(),
  skippedSuppressed: z.number(),
  skippedHeld: z.number(),
  limit: z.number(),
});
export type AudiencePreview = z.infer<typeof audiencePreviewSchema>;

/** A send's answer from the audited broadcast door. */
export const broadcastResultSchema = z.object({
  sent: z.number(),
  failed: z.number(),
  total: z.number(),
});

export const leadPageSchema = z.object({
  leads: z.array(
    z.object({
      id: z.string(),
      sourceCategory: z.string(),
      companyName: z.string().nullable(),
      contactName: z.string(),
      contactEmail: z.string(),
      phone: z.string().nullable(),
      subject: z.string(),
      message: z.string(),
      status: z.nativeEnum(LeadStatus),
      createdAt: z.string(),
    }),
  ),
  nextCursor: z.string().nullable(),
});
export type LeadRow = z.infer<typeof leadPageSchema>["leads"][number];

/** One page of `GET /api/admin/users`. */
export const userListPageSchema = z.object({
  users: z.array(
    z.object({
      id: z.string(),
      name: z.string().nullable(),
      email: z.string().nullable(),
      image: z.string().nullable(),
      role: z.nativeEnum(UserRole).nullable(),
      onboardingCompleted: z.boolean().nullable(),
      createdAt: z.string(),
    }),
  ),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  totalPages: z.number().int().nonnegative(),
});
export type UserListItem = z.infer<typeof userListPageSchema>["users"][number];

/** Feedback about the product, as the staff feedback list sends it. */
export const platformFeedbackSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  rating: z.number().nullable(),
  category: z.string().nullable(),
  status: z.nativeEnum(PlatformFeedbackStatus),
  user: z.object({
    id: z.string(),
    name: z.string().nullable(),
    email: z.string().nullable(),
    image: z.string().nullable(),
  }),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PlatformFeedback = z.infer<typeof platformFeedbackSchema>;

export const feedbackCountsSchema = z.object({
  total: z.number(),
  pending: z.number(),
  acknowledged: z.number(),
  inProgress: z.number(),
  resolved: z.number(),
  closed: z.number(),
});
export type FeedbackCounts = z.infer<typeof feedbackCountsSchema>;

export const feedbackPageSchema = z.object({
  feedbacks: z.array(platformFeedbackSchema),
  counts: feedbackCountsSchema,
  pagination: pageMeta,
});

const instant = z
  .union([z.string(), z.date()])
  .transform((v) => (typeof v === "string" ? v : v.toISOString()));

export const announcementSchema = z.object({
  id: z.string(),
  title: z.string(),
  content: z.string(),
  isActive: z.boolean(),
  startDate: instant.nullable(),
  endDate: instant.nullable(),
  backgroundColor: z.string().nullable(),
  textColor: z.string().nullable(),
  linkUrl: z.string().nullable(),
  linkText: z.string().nullable(),
  createdAt: instant,
});
export type Announcement = z.infer<typeof announcementSchema>;

/** One page of `GET /api/announcements/manage`. */
export const announcementPageSchema = z.object({
  success: z.literal(true),
  data: z.array(announcementSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  limit: z.number().int().positive(),
});
export type AnnouncementPageInput = z.input<typeof announcementPageSchema>;

const namedPerson = z.object({
  id: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
});

/** One take-rate schedule, with the maker and the checker named. */
export const feeScheduleSchema = z.object({
  id: z.string(),
  marketplaceBps: z.number().int(),
  ownLinkBps: z.number().int(),
  effectiveFrom: instant,
  approvedAt: instant.nullable(),
  createdAt: instant,
  reason: z.string().nullable(),
  maker: namedPerson,
  checker: namedPerson.nullable(),
});
export type FeeSchedule = z.infer<typeof feeScheduleSchema>;

/** One page of `GET /api/admin/fee-schedules`, with the rates in force now. */
export const feeSchedulePageSchema = z.object({
  schedules: z.array(feeScheduleSchema),
  active: z.object({
    marketplaceBps: z.number().int(),
    ownLinkBps: z.number().int(),
  }),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  limit: z.number().int().positive(),
});
export type FeeSchedulePageInput = z.input<typeof feeSchedulePageSchema>;
