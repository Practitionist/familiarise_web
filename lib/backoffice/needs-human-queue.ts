/**
 * The decision queue's paging and sort contract, shared by the card that asks
 * and the route that parses. Client-safe: no Prisma here.
 */

import type {
  AppointmentsType,
  OccurrenceCompletionStatus,
  OccurrenceOutcome,
} from "@prisma/client";
import { z } from "zod";

import type { PersonLike } from "./person";

export const NEEDS_HUMAN_PAGE_SIZE = 20;

/** The columns the queue may sort by; `outcomeAt` is when the session started waiting. */
export const NEEDS_HUMAN_SORT_KEYS = [
  "endsAt",
  "startsAt",
  "outcomeAt",
  "lostMinutes",
] as const;
export type NeedsHumanSortKey = (typeof NEEDS_HUMAN_SORT_KEYS)[number];

export interface NeedsHumanSort {
  key: NeedsHumanSortKey;
  dir: "asc" | "desc";
}

/** Oldest first, so sessions parked longest lead the first page. */
export const NEEDS_HUMAN_DEFAULT_SORT: NeedsHumanSort = {
  key: "endsAt",
  dir: "asc",
};

const SORT_TOKENS = [
  "endsAt",
  "-endsAt",
  "startsAt",
  "-startsAt",
  "outcomeAt",
  "-outcomeAt",
  "lostMinutes",
  "-lostMinutes",
] as const;

const sortOf = (token: (typeof SORT_TOKENS)[number]): NeedsHumanSort => {
  const desc = token.startsWith("-");
  const key = z
    .enum(NEEDS_HUMAN_SORT_KEYS)
    .parse(desc ? token.slice(1) : token);
  return { key, dir: desc ? "desc" : "asc" };
};

/** `?page` is a positive integer; `?sort` is a whitelisted key, `-` for descending. */
export const needsHumanQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  sort: z.enum(SORT_TOKENS).default("endsAt").transform(sortOf),
});

/** The query string the queue card sends for one page and sort. */
export function needsHumanQueueSearch(
  page: number,
  sort: NeedsHumanSort,
): string {
  const params = new URLSearchParams({
    page: String(page),
    sort: sort.dir === "desc" ? `-${sort.key}` : sort.key,
  });
  return params.toString();
}

/** One parked session with the booking it belongs to, as the route returns it. */
export interface NeedsHumanItem {
  id: string;
  appointmentId: string;
  startsAt: string;
  endsAt: string;
  outcomeAt: string | null;
  completionStatus: OccurrenceCompletionStatus;
  outcome: OccurrenceOutcome | null;
  lostMinutes: number | null;
  endedReason: string | null;
  /** Parked over 7 days; its booking's settlement is waiting on it. */
  aged: boolean;
  booking: {
    type: AppointmentsType;
    title: string;
    expert: PersonLike | null;
    /** The 1:1 learner; null on a webinar or class, which carries `attendeeLabel`. */
    learner: PersonLike | null;
    attendeeLabel: string | null;
    removed: boolean;
  };
}

export interface NeedsHumanPage {
  items: NeedsHumanItem[];
  total: number;
  page: number;
  pageSize: number;
}
