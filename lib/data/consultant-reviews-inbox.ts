import "server-only";

import type { Prisma, ReviewTrack } from "@prisma/client";

import prisma from "@/lib/prisma";
import { getConsultantReviewTracks } from "@/lib/data/consultant-detail";
import type { TReviewTrackPresence } from "@/types/review";

/**
 * #1527 Q5 / #1300 — the consultant's own Reviews inbox: every live review of
 * them, newest first, with the two published scores side by side. An
 * anonymous reviewer stays anonymous here too: no name and no offering, which
 * would name them to the one person who knows who booked what.
 */

export const REVIEWS_PAGE_SIZE = 20;

export interface OwnReviewRow {
  id: string;
  rating: number;
  body: string | null;
  createdAt: string;
  editedAt: string | null;
  track: ReviewTrack | null;
  reviewer: { name: string | null; image: string | null } | null;
  offeringTitle: string | null;
  reply: { body: string; repliedAt: string | null } | null;
  /** Moderation took the last reply down; only support can reopen it. */
  replyRemovedByModeration: boolean;
}

export interface OwnReviewsPage {
  rows: OwnReviewRow[];
  nextCursor: string | null;
  /** First page only: the published scores and which tracks exist. */
  summary?: {
    publishedRatingOneToOne: number | null;
    publishedRatingGroup: number | null;
    ratedClientsOneToOne: number;
    ratedEventsGroup: number;
    tracks: TReviewTrackPresence;
    needsReply: number;
  };
}

/** A live review with no live reply that the consultant may still write. */
export const NEEDS_REPLY_WHERE = {
  OR: [
    { replyBody: null },
    { replyDeletedAt: { not: null }, replyRemovedBy: "AUTHOR" },
  ],
} satisfies Prisma.ConsultantReviewWhereInput;

const ROW_SELECT = {
  id: true,
  rating: true,
  reviewDescription: true,
  createdAt: true,
  editedAt: true,
  isAnonymous: true,
  track: true,
  replyBody: true,
  repliedAt: true,
  replyDeletedAt: true,
  replyRemovedBy: true,
  consulteeProfile: {
    select: { user: { select: { name: true, image: true } } },
  },
  appointment: {
    select: {
      consultation: {
        select: { consultationPlan: { select: { title: true } } },
      },
      subscription: {
        select: { subscriptionPlan: { select: { title: true } } },
      },
      webinar: { select: { webinarPlan: { select: { title: true } } } },
      class: { select: { classPlan: { select: { title: true } } } },
    },
  },
} satisfies Prisma.ConsultantReviewSelect;

type ReviewRecord = Prisma.ConsultantReviewGetPayload<{
  select: typeof ROW_SELECT;
}>;

function offeringTitle(appointment: ReviewRecord["appointment"]) {
  return (
    appointment?.consultation?.consultationPlan.title ??
    appointment?.subscription?.subscriptionPlan.title ??
    appointment?.webinar?.webinarPlan.title ??
    appointment?.class?.classPlan.title ??
    null
  );
}

export function toOwnReviewRow(r: ReviewRecord): OwnReviewRow {
  const replyLive = r.replyBody !== null && r.replyDeletedAt === null;
  return {
    id: r.id,
    rating: r.rating,
    body: r.reviewDescription,
    createdAt: r.createdAt.toISOString(),
    editedAt: r.editedAt?.toISOString() ?? null,
    track: r.track,
    reviewer: r.isAnonymous
      ? null
      : {
          name: r.consulteeProfile.user.name,
          image: r.consulteeProfile.user.image,
        },
    offeringTitle: r.isAnonymous ? null : offeringTitle(r.appointment),
    reply: replyLive
      ? {
          body: r.replyBody ?? "",
          repliedAt: r.repliedAt?.toISOString() ?? null,
        }
      : null,
    replyRemovedByModeration:
      r.replyDeletedAt !== null && r.replyRemovedBy === "MODERATION",
  };
}

export async function readOwnReviews(args: {
  consultantProfileId: string;
  cursor?: string | null;
  rating?: number | null;
  needsReply?: boolean;
  limit?: number;
}): Promise<OwnReviewsPage> {
  const limit = args.limit ?? REVIEWS_PAGE_SIZE;
  const base: Prisma.ConsultantReviewWhereInput = {
    consultantProfileId: args.consultantProfileId,
    // #693 — a review moderation removed is gone for its subject too.
    deletedAt: null,
  };
  const records = await prisma.consultantReview.findMany({
    where: {
      ...base,
      ...(args.rating ? { rating: args.rating } : {}),
      ...(args.needsReply ? NEEDS_REPLY_WHERE : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(args.cursor ? { cursor: { id: args.cursor }, skip: 1 } : {}),
    select: ROW_SELECT,
  });
  const page = records.slice(0, limit);
  const result: OwnReviewsPage = {
    rows: page.map(toOwnReviewRow),
    nextCursor: records.length > limit ? (page.at(-1)?.id ?? null) : null,
  };
  if (args.cursor) return result;

  const profile = await prisma.consultantProfile.findUnique({
    where: { id: args.consultantProfileId },
    select: {
      publishedRatingOneToOne: true,
      publishedRatingGroup: true,
      ratedClientsOneToOne: true,
      ratedEventsGroup: true,
    },
  });
  const tracks = await getConsultantReviewTracks(args.consultantProfileId);
  const needsReply = await prisma.consultantReview.count({
    where: { ...base, ...NEEDS_REPLY_WHERE },
  });
  result.summary = {
    publishedRatingOneToOne: profile?.publishedRatingOneToOne ?? null,
    publishedRatingGroup: profile?.publishedRatingGroup ?? null,
    ratedClientsOneToOne: profile?.ratedClientsOneToOne ?? 0,
    ratedEventsGroup: profile?.ratedEventsGroup ?? 0,
    tracks,
    needsReply,
  };
  return result;
}
