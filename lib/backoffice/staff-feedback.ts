import type { Prisma } from "@prisma/client";

/**
 * The two shapes a platform-feedback row is read in.
 *
 * The staff read carries the operator's own note; the author's read must not,
 * because the note is written for the moderation team and never for the
 * person who wrote the feedback. One definition of each, so a column added
 * to the table cannot leak into the author's read by accident.
 */

/** The staff read: the whole row, plus the author. */
export const STAFF_FEEDBACK_SELECT = {
  id: true,
  userId: true,
  title: true,
  description: true,
  rating: true,
  category: true,
  status: true,
  staffNote: true,
  createdAt: true,
  updatedAt: true,
  user: {
    select: {
      id: true,
      name: true,
      email: true,
      image: true,
      phone: true,
      createdAt: true,
    },
  },
} satisfies Prisma.PlatformFeedbackSelect;

/** The author's read: the same row WITHOUT the staff note. */
export const AUTHOR_FEEDBACK_SELECT = {
  id: true,
  userId: true,
  title: true,
  description: true,
  rating: true,
  category: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.PlatformFeedbackSelect;
