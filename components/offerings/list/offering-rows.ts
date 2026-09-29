/**
 * #1527 §7.2 — the Offerings list's one row shape. The four offering types
 * arrive in three payloads (the planner's webinar/class instances and the two
 * 1:1 plan lists); this flattens them so the card, the filters and the search
 * read one thing.
 */

import type { ClassStatus, WebinarStatus } from "@prisma/client";

import type { Tone } from "@/lib/ui/tone";
import { formatCurrencyAmount } from "@/utils/formatting";
import { effectiveMaxParticipants } from "@/lib/events/capacity";
import type {
  ConsultationPlanEvent,
  Event,
  PlannerClassEvent,
  PlannerWebinarEvent,
  SubscriptionPlanEvent,
} from "@/types/planner-events";
import type { OfferingPlanType } from "@/lib/offerings/stats";
import { offeringStatKey } from "@/lib/offerings/stats";

export const OFFERING_TYPE_LABEL: Record<OfferingPlanType, string> = {
  consultation: "1:1",
  subscription: "Subscription",
  webinar: "Webinar",
  class: "Class",
};

/** The pill labels, in the spec's order (All is the unset filter). */
export const OFFERING_TYPE_FILTERS: {
  value: OfferingPlanType;
  label: string;
}[] = [
  { value: "consultation", label: "1:1" },
  { value: "subscription", label: "Subscriptions" },
  { value: "webinar", label: "Webinars" },
  { value: "class", label: "Classes" },
];

const PUBLIC_SEGMENT: Record<OfferingPlanType, string> = {
  consultation: "consultations",
  subscription: "subscriptions",
  webinar: "webinars",
  class: "classes",
};

/** The buyer-facing detail page; the owner's preview works on drafts too (Q4). */
export const publicOfferingHref = (type: OfferingPlanType, planId: string) =>
  `/explore/programs/plans/${PUBLIC_SEGMENT[type]}/${planId}`;

export interface OfferingStatusChip {
  label: string;
  tone: Tone;
}

export interface OfferingRow {
  /** `type:planId` for plans, `type:planId:instanceId` for group events. */
  key: string;
  /** Joins the row to its offering-stats entry. */
  statKey: string | null;
  type: OfferingPlanType;
  planId: string | undefined;
  /** The Webinar/Class row a group card stands for; delete and join act on it. */
  instanceId: string | undefined;
  title: string;
  description: string;
  priceText: string;
  durationText: string;
  status: OfferingStatusChip;
  isDraft: boolean;
  isArchived: boolean;
  isCollaborated: boolean;
  collaboratorRole: string | null;
  startsAt: Date | null;
  seats: { taken: number; capacity: number } | null;
  /** #1819 — a plan's batches, numbered by first session. */
  batch: { index: number; total: number } | null;
  trialEnabled: boolean;
  event: Event;
}

const PUBLISHED: OfferingStatusChip = { label: "Published", tone: "success" };
const DRAFT: OfferingStatusChip = { label: "Draft", tone: "neutral" };
const ARCHIVED: OfferingStatusChip = { label: "Archived", tone: "neutral" };

const EVENT_STATUS: Record<WebinarStatus | ClassStatus, OfferingStatusChip> = {
  DRAFT,
  SCHEDULED: PUBLISHED,
  IN_PROGRESS: { label: "Live", tone: "info" },
  COMPLETED: { label: "Completed", tone: "neutral" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
};

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

function planStatus(
  status: string | null | undefined,
  archivedAt: Date | string | null | undefined,
): OfferingStatusChip {
  if (archivedAt) return ARCHIVED;
  return status === "DRAFT" ? DRAFT : PUBLISHED;
}

function eventStatus(
  status: WebinarStatus | ClassStatus | null | undefined,
  archivedAt: Date | string | null | undefined,
): OfferingStatusChip {
  if (archivedAt) return ARCHIVED;
  return status ? EVENT_STATUS[status] : PUBLISHED;
}

function price(paise: number, currency: string | null | undefined): string {
  return formatCurrencyAmount(paise, currency ?? "INR");
}

function consultationRow(event: ConsultationPlanEvent): OfferingRow {
  const plan = event.consultationPlan;
  const planId = plan.id ?? event.id;
  const status = planStatus(plan.status, plan.archivedAt);
  return {
    key: `consultation:${planId ?? plan.title}`,
    statKey: planId ? offeringStatKey("consultation", planId) : null,
    type: "consultation",
    planId,
    instanceId: undefined,
    title: plan.title,
    description: plan.description ?? "",
    priceText: price(plan.price, plan.priceCurrency),
    durationText: plural(plan.durationInHours, "hour", "hours"),
    status,
    isDraft: status === DRAFT,
    isArchived: status === ARCHIVED,
    isCollaborated: false,
    collaboratorRole: null,
    startsAt: null,
    seats: null,
    batch: null,
    trialEnabled: false,
    event,
  };
}

function subscriptionRow(event: SubscriptionPlanEvent): OfferingRow {
  const plan = event.subscriptionPlan;
  const planId = plan.id ?? event.id;
  const status = planStatus(plan.status, plan.archivedAt);
  return {
    key: `subscription:${planId ?? plan.title}`,
    statKey: planId ? offeringStatKey("subscription", planId) : null,
    type: "subscription",
    planId,
    instanceId: undefined,
    title: plan.title,
    description: plan.description ?? "",
    priceText: `${price(plan.price, plan.priceCurrency)}/mo`,
    durationText: plural(plan.durationInMonths, "month", "months"),
    status,
    isDraft: status === DRAFT,
    isArchived: status === ARCHIVED,
    isCollaborated: false,
    collaboratorRole: null,
    startsAt: null,
    seats: null,
    batch: null,
    trialEnabled: plan.trialEnabled ?? false,
    event,
  };
}

/** The first live session, else the webinar's first slot row. */
function webinarStart(event: PlannerWebinarEvent): Date | null {
  const startsAt = event.appointment?.occurrences?.[0]?.startsAt;
  return startsAt ? new Date(startsAt) : null;
}

function webinarRow(
  event: PlannerWebinarEvent,
  participantCounts: Record<string, number>,
): OfferingRow {
  const plan = event.webinarPlan;
  const status = eventStatus(event.status, plan.archivedAt);
  return {
    key: `webinar:${plan.id}:${event.id}`,
    statKey: plan.id ? offeringStatKey("webinar", plan.id) : null,
    type: "webinar",
    planId: plan.id,
    instanceId: event.id,
    title: plan.title,
    description: plan.description ?? "",
    priceText: price(plan.price, plan.priceCurrency),
    durationText: plural(plan.durationInHours, "hour", "hours"),
    status,
    isDraft: status === DRAFT,
    isArchived: status === ARCHIVED,
    isCollaborated: event.isCollaborated,
    collaboratorRole: event.collaboratorRole ?? null,
    startsAt: webinarStart(event),
    seats: {
      taken: participantCounts[event.id ?? ""] ?? 0,
      capacity: effectiveMaxParticipants(event, plan),
    },
    batch: null,
    trialEnabled: false,
    event,
  };
}

/**
 * #1346 — `firstSessionAt` is the unwindowed first session; the planner's
 * slot rows are cut to a day either side of now.
 */
function classStart(event: PlannerClassEvent): Date | null {
  if (event.firstSessionAt) return new Date(event.firstSessionAt);
  return event.schedulingPeriodStartsAt
    ? new Date(event.schedulingPeriodStartsAt)
    : null;
}

function classRows(
  events: PlannerClassEvent[],
  participantCounts: Record<string, number>,
): OfferingRow[] {
  // #1819 — each Class row is one batch of its plan, numbered by start.
  const byPlan = new Map<string, PlannerClassEvent[]>();
  for (const event of events) {
    const list = byPlan.get(event.classPlan.id) ?? [];
    list.push(event);
    byPlan.set(event.classPlan.id, list);
  }
  const batchOf = new Map<string, { index: number; total: number }>();
  for (const list of byPlan.values()) {
    const ordered = [...list].sort(
      (a, b) =>
        (classStart(a)?.getTime() ?? Infinity) -
        (classStart(b)?.getTime() ?? Infinity),
    );
    ordered.forEach((event, i) =>
      batchOf.set(event.id, { index: i + 1, total: ordered.length }),
    );
  }
  return events.map((event) => {
    const plan = event.classPlan;
    const status = eventStatus(event.status, plan.archivedAt);
    const batch = batchOf.get(event.id) ?? null;
    return {
      key: `class:${plan.id}:${event.id}`,
      statKey: plan.id ? offeringStatKey("class", plan.id) : null,
      type: "class",
      planId: plan.id,
      instanceId: event.id,
      title: plan.title,
      description: plan.description ?? "",
      priceText: price(plan.price, plan.priceCurrency),
      durationText: plural(plan.durationInMonths, "month", "months"),
      status,
      isDraft: status === DRAFT,
      isArchived: status === ARCHIVED,
      isCollaborated: event.isCollaborated,
      collaboratorRole: event.collaboratorRole ?? null,
      startsAt: classStart(event),
      seats: {
        taken: participantCounts[event.id ?? ""] ?? 0,
        capacity: effectiveMaxParticipants(event, plan),
      },
      batch: batch && batch.total > 1 ? batch : null,
      trialEnabled: false,
      event,
    };
  });
}

export interface OfferingSources {
  consultationPlans: ConsultationPlanEvent[];
  subscriptionPlans: SubscriptionPlanEvent[];
  webinars: PlannerWebinarEvent[];
  classes: PlannerClassEvent[];
  participantCounts: Record<string, number>;
}

export function buildOfferingRows(sources: Readonly<OfferingSources>) {
  return [
    ...sources.consultationPlans.map(consultationRow),
    ...sources.subscriptionPlans.map(subscriptionRow),
    ...sources.webinars.map((w) => webinarRow(w, sources.participantCounts)),
    ...classRows(sources.classes, sources.participantCounts),
  ];
}

/** Type pill + search, the two URL-held filters. */
export function filterOfferingRows(
  rows: readonly OfferingRow[],
  type: string | null,
  query: string,
): OfferingRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter(
    (row) =>
      (!type || row.type === type) &&
      (!q ||
        row.title.toLowerCase().includes(q) ||
        row.description.toLowerCase().includes(q)),
  );
}
