/**
 * #1775 / #1704 / #1705 — the Requests inbox's pure half: the row shape the
 * read (lib/data/requests-inbox.ts) emits and the client renders, the URL
 * enums for tabs / chips / sort, and the deadline-bucket + sort rules the
 * read applies server-side. Prisma-free so the client component, the RSC
 * page and a jest pin share one definition (same posture as earnings-state).
 */

import type { SubscriptionEntitlement } from "@/lib/booking/entitlement";
import type {
  BookingPresentationInput,
  BookingStateKind,
} from "@/lib/dashboard/money-state";

export const INBOX_TYPES = ["consultation", "subscription", "trial"] as const;
export type InboxType = (typeof INBOX_TYPES)[number];

export const INBOX_CHIPS = [
  "answer-today",
  "awaiting-payment",
  "next-cycle",
  "declined",
] as const;
export type InboxChip = (typeof INBOX_CHIPS)[number];

/** Which chips a tab offers; a next cycle only exists on a subscription. */
export const CHIPS_FOR_TYPE: Record<InboxType, InboxChip[]> = {
  consultation: ["answer-today", "awaiting-payment", "declined"],
  subscription: ["answer-today", "awaiting-payment", "next-cycle", "declined"],
  trial: ["answer-today", "awaiting-payment", "declined"],
};

export const INBOX_SORTS = [
  "new",
  "old",
  "priority",
  "money",
  "deadline",
] as const;
export type InboxSort = (typeof INBOX_SORTS)[number];

export type InboxRowKind =
  | "consultation"
  | "subscription"
  | "trial"
  | "next-cycle";

/**
 * Where a row sits inside its tab. "Answer today" is under 24 h (or overdue)
 * or has no clock at all (a trial request never expires on its own, so it is
 * always due); "This week" is under 7 d; "Later" is the rest of the rows this
 * consultant must answer (a subscription hold runs 30 d); "Waiting on them"
 * is every row whose clock is the other party's.
 */
export const INBOX_BUCKETS = [
  "answer-today",
  "this-week",
  "later",
  "waiting-on-them",
] as const;
export type InboxBucket = (typeof INBOX_BUCKETS)[number];

/** A Date on the RSC seed, an ISO string after a JSON refetch. */
export type Stamp = Date | string;

export interface InboxSlot {
  startsAt: Stamp;
  endsAt: Stamp;
  isTentative: boolean;
  /** RESCHEDULED means startsAt is the time being moved AWAY from, not a request. */
  completionStatus: string | null;
}

export interface InboxProposal {
  id: string;
  status: string;
  reason: string | null;
  round: number;
  expiresAt: Stamp;
  initiatorRole: string;
  preferredTimeOfDay: string | null;
  preferredDays: string | null;
  proposedTimes: { startsAt: Stamp; endsAt: Stamp; round: number }[];
}

export interface InboxRowInput {
  /** The request row's own id (Consultation / Subscription / Trial). */
  id: string;
  kind: InboxRowKind;
  appointmentId: string | null;
  planTitle: string;
  requester: { name: string; image: string | null };
  requestedAt: Stamp;
  deadline: Stamp | null;
  bucket: InboxBucket;
  /** Plan price; null for a free trial. */
  amountPaise: number | null;
  currency: string;
  /** Built through lifecycleOf / planOf — never by hand. */
  presentation: BookingPresentationInput;
  names: { payer: string; consultant: string };
  hrefs: { detail: string | null; allocate: string | null };
  requestNotes: string | null;
  bookingSource: "DIRECT_CHECKOUT" | "REQUEST_SUBMITTED" | null;
  /** Every non-tombstoned occurrence on the wrapper (RESCHEDULED rows included). */
  slots: InboxSlot[];
  /** 30-minute atoms one approval must place; null when the plan cannot say. */
  requiredSlots: number | null;
  tentativeSlotCount: number;
  rescheduledSlotCount: number;
  /** The live reschedule proposal, if the consultee named times. */
  proposal: InboxProposal | null;
  schedulingPeriod: { start: Stamp; end: Stamp } | null;
  schedulingTimezone: string | null;
  /** #1766 — a subscription's one counter; drives "Schedule the next N · a of b booked". */
  entitlement: SubscriptionEntitlement | null;
  trial: { durationMinutes: number } | null;
}

export interface InboxMeta {
  total: number;
  page: number;
  limit: number;
  /** Rows per type tab (the default cohort, no chip), for the tab labels. */
  counts: Record<InboxType, number>;
}

export interface RequestsInboxPayload {
  rows: InboxRowInput[];
  meta: InboxMeta;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const toStampDate = (v: Stamp): Date =>
  v instanceof Date ? v : new Date(v);

/**
 * REQUESTED is the one state this consultant answers; it is banded by how
 * much of the hold is left. Every other state's clock is the other party's
 * (a pay link, a finished cycle) or has already run out.
 */
export function inboxBucketOf(
  row: { kind: InboxRowKind; deadline: Stamp | null },
  state: BookingStateKind,
  now: Date = new Date(),
): InboxBucket {
  if (row.kind === "next-cycle" || state !== "REQUESTED") {
    return "waiting-on-them";
  }
  if (row.deadline === null) return "answer-today";
  const left = toStampDate(row.deadline).getTime() - now.getTime();
  if (left < DAY_MS) return "answer-today";
  if (left < 7 * DAY_MS) return "this-week";
  return "later";
}

const BUCKET_RANK: Record<InboxBucket, number> = {
  "answer-today": 0,
  "this-week": 1,
  later: 2,
  "waiting-on-them": 3,
};

const deadlineMs = (row: InboxRowInput): number =>
  row.deadline === null
    ? Number.POSITIVE_INFINITY
    : toStampDate(row.deadline).getTime();
const requestedMs = (row: InboxRowInput): number =>
  toStampDate(row.requestedAt).getTime();
const amount = (row: InboxRowInput): number =>
  row.amountPaise ?? Number.NEGATIVE_INFINITY;

/** Stable: ties fall back to the request clock, then the id. */
export function sortInboxRows(
  rows: InboxRowInput[],
  sort: InboxSort,
): InboxRowInput[] {
  const tie = (a: InboxRowInput, b: InboxRowInput) =>
    requestedMs(b) - requestedMs(a) || a.id.localeCompare(b.id);
  const by: Record<InboxSort, (a: InboxRowInput, b: InboxRowInput) => number> =
    {
      new: (a, b) =>
        requestedMs(b) - requestedMs(a) || a.id.localeCompare(b.id),
      old: (a, b) =>
        requestedMs(a) - requestedMs(b) || a.id.localeCompare(b.id),
      deadline: (a, b) => deadlineMs(a) - deadlineMs(b) || tie(a, b),
      money: (a, b) => amount(b) - amount(a) || tie(a, b),
      priority: (a, b) =>
        BUCKET_RANK[a.bucket] - BUCKET_RANK[b.bucket] ||
        amount(b) - amount(a) ||
        deadlineMs(a) - deadlineMs(b) ||
        tie(a, b),
    };
  return [...rows].sort(by[sort]);
}

export function isInboxType(v: string | null | undefined): v is InboxType {
  return INBOX_TYPES.includes(v as InboxType);
}
export function isInboxChip(v: string | null | undefined): v is InboxChip {
  return INBOX_CHIPS.includes(v as InboxChip);
}
export function isInboxSort(v: string | null | undefined): v is InboxSort {
  return INBOX_SORTS.includes(v as InboxSort);
}

export const INBOX_DEFAULT_TYPE: InboxType = "consultation";
export const INBOX_DEFAULT_SORT: InboxSort = "priority";
export const INBOX_DEFAULT_LIMIT = 20;

export interface InboxQueryArgs {
  consultantProfileId: string;
  /** "personal" or an organisation id, as the URL carries it. */
  scope: string;
  type: InboxType;
  chip: InboxChip | null;
  sort: InboxSort;
  page: number;
}

/** The RSC seed and the client `useQuery` MUST build this identically. */
export function inboxQueryKey(args: InboxQueryArgs) {
  return [
    "requests-inbox",
    args.consultantProfileId,
    args.scope,
    args.type,
    args.chip,
    args.sort,
    args.page,
  ] as const;
}

/** The HTTP twin's query string for the same arguments. */
export function inboxQueryString(args: InboxQueryArgs): string {
  const params = new URLSearchParams({
    consultantProfileId: args.consultantProfileId,
    orgScope: args.scope,
    type: args.type,
    sort: args.sort,
    page: String(args.page),
    limit: String(INBOX_DEFAULT_LIMIT),
  });
  if (args.chip) params.set("chip", args.chip);
  return params.toString();
}

/** URL → inbox state; anything unknown falls to the default. */
export function readInboxParams(
  get: (key: string) => string | null,
): Pick<InboxQueryArgs, "type" | "chip" | "sort" | "page"> {
  const type = get("type");
  const chip = get("chip");
  const sort = get("sort");
  const page = Number.parseInt(get("page") ?? "1", 10);
  const safeType = isInboxType(type) ? type : INBOX_DEFAULT_TYPE;
  // A chip the tab does not offer is dropped, never sent.
  return {
    type: safeType,
    chip:
      isInboxChip(chip) && CHIPS_FOR_TYPE[safeType].includes(chip)
        ? chip
        : null,
    sort: isInboxSort(sort) ? sort : INBOX_DEFAULT_SORT,
    page: Number.isFinite(page) && page >= 1 ? page : 1,
  };
}
