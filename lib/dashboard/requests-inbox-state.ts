/**
 * The Requests inbox's pure half: the row shape the read
 * (lib/data/requests-inbox.ts) emits and the client renders, the URL enums
 * for tabs / chips / sort / cursor, and the bucket + sort rules the read
 * applies server-side. Prisma-free so the client component, the RSC page and
 * a jest pin share one definition.
 */

import { z } from "zod";

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
  subscription: ["answer-today", "next-cycle", "declined"],
  trial: ["awaiting-payment"],
};

export const INBOX_SORTS = [
  "new",
  "old",
  "priority",
  "money",
  "deadline",
] as const;
export type InboxSort = (typeof INBOX_SORTS)[number];

/**
 * Sorts on the request clock page through SQL keyset cursors over every row
 * when the view reads one source. The ranked sorts order by derived fields
 * (bucket, money, the effective deadline), and several sources cannot be
 * merged at the column's precision, so those page an in-memory window.
 */
export const INBOX_CURSOR_SORTS = ["new", "old"] as const;
export type InboxCursorSort = (typeof INBOX_CURSOR_SORTS)[number];
export const isCursorSort = (sort: InboxSort): sort is InboxCursorSort =>
  (INBOX_CURSOR_SORTS as readonly string[]).includes(sort);

/** How many rows a ranked sort holds: "Showing the 200 most urgent". */
export const INBOX_RANKED_WINDOW = 200;

export type InboxRowKind =
  "consultation" | "subscription" | "trial" | "next-cycle";

/**
 * Where a row sits inside its tab. "Answer today" is under 24 h (or overdue)
 * or has no clock at all (a trial request never expires on its own, so it is
 * always due); "This week" is under 7 d; "Later" is the rest of the rows this
 * consultant must answer (a subscription hold runs 30 d); "Waiting on the client"
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

/** The 30-minute atoms the tentative rows hold, the unit `requiredSlots` counts in. */
export function tentativeAtomsOf(slots: readonly InboxSlot[]): number {
  return slots
    .filter((s) => s.isTentative)
    .reduce(
      (n, s) =>
        n +
        Math.max(
          1,
          Math.ceil(
            (new Date(s.endsAt).getTime() - new Date(s.startsAt).getTime()) /
              1_800_000,
          ),
        ),
      0,
    );
}

export interface InboxProposal {
  id: string;
  status: string;
  reason: string | null;
  expiresAt: Stamp;
  initiatorRole: string;
  preferredTimeOfDay: string | null;
  preferredDays: string | null;
  proposedTimes: { startsAt: Stamp; endsAt: Stamp }[];
}

export interface InboxRowInput {
  /** The request row's own id (Consultation / Subscription / Trial). */
  id: string;
  kind: InboxRowKind;
  appointmentId: string | null;
  /** The server-validated manual reminder window; links and email stay server-side. */
  reminderExpiresAt: Stamp | null;
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
  /** Tentative rows, the unit the allocate route's stale-tab check compares. */
  tentativeSlotCount: number;
  rescheduledSlotCount: number;
  /** The live reschedule proposal, if the consultee named times. */
  proposal: InboxProposal | null;
  schedulingPeriod: { start: Stamp; end: Stamp } | null;
  schedulingTimezone: string | null;
  /** A subscription's one counter; drives "Schedule the next N · a of b booked". */
  entitlement: SubscriptionEntitlement | null;
  /** The learner's user id lets the trial picker grey out their busy times. */
  trial: { durationMinutes: number; consulteeUserId: string } | null;
  /**
   * The buyer is paying for a direct checkout right now: shown so the held
   * slot makes sense, never answerable and never counted.
   */
  checkoutHold: { expiresAt: Stamp } | null;
  /** The requested time is too close or gone; it can only be re-timed or declined. */
  requestedStartPassed: boolean;
}

export interface InboxMeta {
  /** Every row this view holds (a separate count, not a scan length). */
  total: number;
  limit: number;
  /** Rows per type tab (the default cohort, no chip), for the tab labels. */
  counts: Record<InboxType, number>;
  /** "cursor": a time sort over one source, paged in SQL; otherwise a ranked window. */
  paging: "cursor" | "ranked";
  /** Cursor paging: the cursor for the next page, null on the last one. */
  nextCursor: string | null;
  /** Ranked paging: the page inside the window. Always 1 for cursor paging. */
  page: number;
  /** Ranked paging: rows the window holds (≤ INBOX_RANKED_WINDOW). */
  windowSize: number;
  /** Ranked paging: rows per bucket across the whole window, for the headers. */
  bucketTotals: Record<InboxBucket, number> | null;
}

export interface RequestsInboxPayload {
  rows: InboxRowInput[];
  meta: InboxMeta;
}

const countsSchema = z.object({
  consultation: z.number(),
  subscription: z.number(),
  trial: z.number(),
});

const requestsInboxPayloadSchema = z.object({
  rows: z.array(
    z.custom<InboxRowInput>(
      (v) => typeof v === "object" && v !== null && "id" in v && "kind" in v,
    ),
  ),
  meta: z.object({
    total: z.number(),
    limit: z.number(),
    counts: countsSchema,
    paging: z.enum(["cursor", "ranked"]),
    nextCursor: z.string().nullable(),
    page: z.number(),
    windowSize: z.number(),
    bucketTotals: z
      .object({
        "answer-today": z.number(),
        "this-week": z.number(),
        later: z.number(),
        "waiting-on-them": z.number(),
      })
      .nullable(),
  }),
});

/** The HTTP twin's 200 body; a malformed one fails the query (and its Retry) instead of the render. */
export function parseRequestsInboxPayload(body: unknown): RequestsInboxPayload {
  const parsed = requestsInboxPayloadSchema.safeParse(body);
  if (!parsed.success) throw new Error("Requests could not be read.");
  return parsed.data;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const toStampDate = (v: Stamp): Date =>
  v instanceof Date ? v : new Date(v);

/**
 * Bucketed by who acts next. A request to answer (REQUESTED) or sessions to
 * schedule (a paid plan's cycle 1, or its open week) is the consultant's, banded
 * by how much of its clock is left; a pay link or a checkout in progress is the
 * client's.
 */
export function inboxBucketOf(
  row: {
    kind: InboxRowKind;
    deadline: Stamp | null;
    checkoutHold?: InboxRowInput["checkoutHold"];
    requestedStartPassed?: boolean;
  },
  state: BookingStateKind,
  now: Date = new Date(),
  /** The consultant must schedule sessions next (a paid plan's week, cycle 1 included). */
  schedulesNext = false,
): InboxBucket {
  if (row.checkoutHold) return "waiting-on-them";
  if (schedulesNext) {
    // A plan week with no clock of its own is still this week's work.
    if (row.deadline === null) return "this-week";
  } else if (row.kind === "next-cycle" || state !== "REQUESTED") {
    return "waiting-on-them";
  }
  if (row.requestedStartPassed || row.deadline === null) return "answer-today";
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

/** A link without `type` opens the default tab, or the first tab with rows when the default has none. */
export function landingInboxType(counts: Record<InboxType, number>): InboxType {
  if (counts[INBOX_DEFAULT_TYPE] > 0) return INBOX_DEFAULT_TYPE;
  return INBOX_TYPES.find((type) => counts[type] > 0) ?? INBOX_DEFAULT_TYPE;
}
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
  /** Cursor sorts: the last row of the previous page; null on the first. */
  after: string | null;
  /** A deep-linked request: ranked sorts open the page that holds it. */
  focus: string | null;
}

/** A keyset position: the request clock, then the id as the tiebreaker. */
export interface InboxCursor {
  requestedAt: Date;
  id: string;
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const CURSOR_PATTERN = /^(\d{1,15})\.([A-Za-z0-9_-]{1,64})$/;

/** `<epoch ms>.<id>`: opaque to the user, safe in a URL. */
export function encodeInboxCursor(row: {
  requestedAt: Stamp;
  id: string;
}): string {
  return `${toStampDate(row.requestedAt).getTime()}.${row.id}`;
}

/** Null for anything that is not a cursor this module wrote. */
export function decodeInboxCursor(
  raw: string | null | undefined,
): InboxCursor | null {
  const match = raw ? CURSOR_PATTERN.exec(raw) : null;
  if (!match) return null;
  return { requestedAt: new Date(Number(match[1])), id: match[2] };
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
    args.after,
    args.focus,
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
  if (args.after) params.set("after", args.after);
  if (args.focus) params.set("focus", args.focus);
  return params.toString();
}

/** URL → inbox state; anything unknown falls to the default (`fallbackType` for the tab). */
export function readInboxParams(
  get: (key: string) => string | null,
  fallbackType: InboxType = INBOX_DEFAULT_TYPE,
): Pick<InboxQueryArgs, "type" | "chip" | "sort" | "page" | "after" | "focus"> {
  const type = get("type");
  const chip = get("chip");
  const sort = get("sort");
  const page = Number.parseInt(get("page") ?? "1", 10);
  const after = get("after");
  const focus = get("focus");
  const safeType = isInboxType(type) ? type : fallbackType;
  const safeSort = isInboxSort(sort) ? sort : INBOX_DEFAULT_SORT;
  // A chip the tab does not offer is dropped, never sent.
  return {
    type: safeType,
    chip:
      isInboxChip(chip) && CHIPS_FOR_TYPE[safeType].includes(chip)
        ? chip
        : null,
    sort: safeSort,
    page: Number.isFinite(page) && page >= 1 ? page : 1,
    // A cursor only means something to a cursor sort.
    after: isCursorSort(safeSort) && decodeInboxCursor(after) ? after : null,
    focus: focus && ID_PATTERN.test(focus) ? focus : null,
  };
}

export interface InboxParamsPatch {
  type?: InboxType;
  chip?: InboxChip | null;
  sort?: InboxSort;
  page?: number;
  after?: string | null;
}

/**
 * The next search string after a tab / chip / sort / page / cursor change. A
 * type change clears the chip; any change resets the page and the cursor
 * unless it sets them; page 1, a cleared chip and the first cursor page are
 * absent, not "null". `focus` is dropped; other keys pass through.
 */
export function nextInboxSearch(
  current: string,
  patch: InboxParamsPatch,
): string {
  const next = new URLSearchParams(current);
  // A deep-linked row is highlighted once; any tab/chip/sort/page change ends it.
  next.delete("focus");
  const apply = (key: string, value: string | null) => {
    if (value === null) next.delete(key);
    else next.set(key, value);
  };
  apply("page", null);
  apply("after", null);
  if (patch.type !== undefined) {
    apply("type", patch.type);
    apply("chip", null);
  }
  if (patch.chip !== undefined) apply("chip", patch.chip);
  if (patch.sort !== undefined) apply("sort", patch.sort);
  if (patch.page !== undefined) {
    apply("page", patch.page <= 1 ? null : String(patch.page));
  }
  if (patch.after !== undefined) apply("after", patch.after);
  return next.toString();
}
