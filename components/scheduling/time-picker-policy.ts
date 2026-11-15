import type { AppointmentsType } from "@prisma/client";
import type { SubscriptionEntitlementInput } from "@/lib/booking/entitlement";
import type { GridLead } from "@/lib/scheduling/allocationService";
import type { OccurrenceLike } from "@/lib/appointments/view-model";
import { RESCHEDULE_MIN_LEAD_HOURS } from "@/lib/booking/lead-time";
import { supportsProposals } from "@/lib/booking/reschedule-proposals";

/**
 * The four surfaces that place slots on a consultant's calendar, expressed as
 * data.
 *
 * They differ in how much notice a session needs, whether anything is being
 * released, and who owns the submit — not in structure. Threading those as
 * boolean props through one component is how `EventPlanner` reached 3,890
 * lines, so the differences live here and `TimePicker` only ever reads fields.
 */

export type TimePickerPolicyKind =
  | "ALLOCATE"
  | "RESCHEDULE_CONSULTEE"
  | "RESCHEDULE_CONSULTANT"
  | "MANAGE_TIMINGS"
  | "REBOOK_INCIDENT";

/**
 * How the initiator would like the replacement placed when they name no time
 * (#1065). Two independent axes so "weekday mornings" is sayable, and both are
 * scored by the allocator rather than filtered on — the worst case of a
 * preference nobody can meet is a less-liked time, never a failed allocation.
 */
export interface SlotPreference {
  preferredTimeOfDay?: "MORNING" | "AFTERNOON" | "EVENING";
  preferredDays?: "WEEKDAYS" | "WEEKENDS";
}

/**
 * The picker's lowercase event types against the Prisma enum the policy layer
 * speaks. A total map rather than a cast, so adding an event type is a compile
 * error here instead of a silent `false` at runtime.
 */
const APPOINTMENT_TYPE: Record<
  TimePickerSubject["eventType"],
  AppointmentsType
> = {
  consultation: "CONSULTATION",
  subscription: "SUBSCRIPTION",
  webinar: "WEBINAR",
  class: "CLASS",
};

/**
 * Whether a stated preference would survive being submitted for this booking.
 *
 * The reschedule API only opens a RescheduleRequest for the kinds that support
 * proposals, and a group event has no single counterparty to state one on
 * behalf of — so on a webinar or class the server discards a preference with no
 * row, no error and no feedback. Asking for something that is silently dropped
 * is worse than not being asked, so the control does not render there. Reads
 * the SAME predicate the route gates on rather than restating the rule.
 */
export function acceptsSlotPreference(
  eventType: TimePickerSubject["eventType"],
): boolean {
  return supportsProposals(APPOINTMENT_TYPE[eventType]);
}

export interface TimePickerSubmission {
  /** Sessions being released. Undefined = every session of the booking. */
  slotIds?: string[];
  /** Times asked for. Absent = "any time works". */
  proposedSlots?: { startsAt: string; endsAt: string }[];
  /** Only ever set alongside an absent `proposedSlots` — naming a time says it. */
  preference?: SlotPreference;
  /** The zone the picker showed times in, for naming them back in a refusal. */
  displayZone?: string;
  /** Sent as `Idempotency-Key`: the same submission repeated reuses it. */
  idempotencyKey?: string;
}

export interface TimePickerPolicy {
  kind: TimePickerPolicyKind;
  /**
   * Notice a session needs before it may be moved. Zero is not "no rule": a
   * pending request was never scheduled and a consultant's own event instance
   * strands nobody, so neither has a counterparty to give notice to.
   */
  minLeadHours: number;
  /** The writer this picker submits to; the grid paints "too soon" by its lead time. */
  lead: GridLead;
  /**
   * Whether this surface releases sessions that already exist. Showing
   * released slots and offering a release step are the same condition, so it
   * is one field rather than two that can disagree.
   */
  showReleasedSlots: boolean;
  /**
   * Primary submit copy. Read only when `calendarMode` is "select" — the
   * allocate grid ships its own footer and labels its own buttons.
   */
  submitLabel: string;
  /**
   * Release WITHOUT naming a time, for the consultee only and never for a
   * session under 24 hours away: the counterparty then places the session.
   */
  allowReleaseWithoutTime: boolean;
  /**
   * "allocate" hands the submit to the grid's own buttons, which POST the
   * allocation themselves; "select" collects times and leaves the POST here.
   */
  calendarMode: "select" | "allocate";
  /**
   * Refuse the allocation when the event already holds confirmed slots
   * (#837). Fresh allocations only — a partial reschedule legitimately has
   * some, which is why the subject supplies the "is it fresh" half.
   */
  appliesInitialAllocationGuard: boolean;
  /** One line above the grid; the only place the two roles read differently. */
  pickerHint: string;
  /** Shown instead of the release-without-time option when a moving session is under 24 hours away. */
  shortNoticeHint?: string;
  onSubmit: (submission: TimePickerSubmission) => void | Promise<void>;
  /** The grid reported a 409 — someone else allocated this first. */
  onConflict?: () => void;
}

/**
 * What is being placed. Pure scheduling data: the surrounding page or dialog
 * owns its own title and description, so no copy lives here.
 */
export interface TimePickerSubject {
  /** Whose availability grid is drawn. */
  consultantProfileId: string;
  eventType: "consultation" | "subscription" | "webinar" | "class";
  /** Consultation/Subscription/Webinar/Class id — what the grid keys on. */
  eventId?: string;
  /**
   * The other party, so the grid greys out times they are already booked at:
   * allocation rejects those, and painting them green only fails at submit.
   * Absent under MANAGE_TIMINGS — a consultant's own instance has no
   * counterparty to conflict with.
   */
  counterpartUserId?: string;
  /** Consultations and webinars: the length of the one session. */
  durationInHours?: number;
  /** Subscriptions and classes: the length of each session. */
  sessionDurationInHours?: number;
  sessionsPerWeek?: number;
  durationInMonths?: number;
  totalSessions?: number;
  /** Defines the limit day/week buckets (ADR B9). */
  schedulingTimezone?: string;
  /** The plan's scheduling period; the grid clamps selection to it. */
  allowedStart?: Date;
  allowedEnd?: Date;
  /**
   * A subscription reschedule: the plan's counter inputs, so the picker clamps
   * to the plan week the server would place into once the moved sessions are
   * released (`rescheduleWindow`).
   */
  rescheduleEntitlement?: Omit<SubscriptionEntitlementInput, "now">;
  /** Existing sessions, for the release step. */
  slots?: OccurrenceLike[];
  /** A session is already released and awaiting a new time. */
  hasReleasedSlots?: boolean;
  /**
   * Who the task is for (allocate page only) — rendered into the hint line
   * so the page needs no separate heading for it.
   */
  consulteeName?: string;
}

type PolicyHandlers = Pick<TimePickerPolicy, "onSubmit"> &
  Partial<Pick<TimePickerPolicy, "onConflict">>;

/**
 * A consultant placing a pending request, or released sessions; released ones
 * keep 24 hours' notice, as the allocator holds them (`replacementLeadMs`).
 */
export function allocatePolicy(
  handlers: PolicyHandlers,
  { settled, replacing = false }: { settled: boolean; replacing?: boolean },
): TimePickerPolicy {
  return {
    kind: "ALLOCATE",
    minLeadHours: 0,
    lead: replacing
      ? { purpose: "reschedule" }
      : { purpose: "allocate", unpaid: !settled },
    showReleasedSlots: false,
    submitLabel: "Save times",
    allowReleaseWithoutTime: false,
    calendarMode: "allocate",
    appliesInitialAllocationGuard: true,
    pickerHint:
      "Choose the times for this booking. Green is free for both of you; anything else is already taken.",
    ...handlers,
  };
}

/**
 * A consultee moving a live booking of theirs. Sessions and new times under
 * 24 hours away are offered: the expert must accept those before the session.
 */
export function rescheduleConsulteePolicy(
  handlers: PolicyHandlers,
  { settled }: { settled: boolean },
): TimePickerPolicy {
  return {
    kind: "RESCHEDULE_CONSULTEE",
    minLeadHours: 0,
    // The lead the server's proposal check uses: 2 hours while unpaid.
    lead: { purpose: "allocate", unpaid: !settled },
    showReleasedSlots: true,
    submitLabel: "Request this time",
    allowReleaseWithoutTime: true,
    calendarMode: "select",
    appliesInitialAllocationGuard: false,
    pickerHint: `Green means your expert is free. A green time at least ${RESCHEDULE_MIN_LEAD_HOURS} hours away confirms straight away; anything else is sent to your expert to accept.`,
    shortNoticeHint: `This session starts within ${RESCHEDULE_MIN_LEAD_HOURS} hours, so no new time confirms by itself: your expert has to accept it at least 15 minutes before the session starts; if they don't, the session keeps its time.`,
    ...handlers,
  };
}

/** A consultant moving a booking they deliver. */
export function rescheduleConsultantPolicy(
  handlers: PolicyHandlers,
  { settled }: { settled: boolean },
): TimePickerPolicy {
  return {
    kind: "RESCHEDULE_CONSULTANT",
    minLeadHours: 0,
    lead: { purpose: "allocate", unpaid: !settled },
    showReleasedSlots: true,
    submitLabel: "Propose this time",
    // The expert names times; the client accepts one or the session stays.
    allowReleaseWithoutTime: false,
    calendarMode: "select",
    appliesInitialAllocationGuard: false,
    pickerHint:
      "Green means you are free. Whatever you propose is sent to your client to accept; until they do, the session keeps its time.",
    shortNoticeHint: `This session starts within ${RESCHEDULE_MIN_LEAD_HOURS} hours: your client has to accept the new time at least 15 minutes before the session starts; if they don't, the session keeps its time.`,
    ...handlers,
  };
}

/** A learner rebooking an outage-voided 1:1 free; nothing is released and the time confirms at once. */
export function rebookIncidentPolicy(
  handlers: PolicyHandlers,
): TimePickerPolicy {
  return {
    kind: "REBOOK_INCIDENT",
    minLeadHours: 0,
    lead: { purpose: "book" },
    showReleasedSlots: false,
    submitLabel: "Rebook free",
    allowReleaseWithoutTime: false,
    calendarMode: "select",
    appliesInitialAllocationGuard: false,
    pickerHint:
      "Green means your expert is free. Choosing a time confirms it straight away, at no charge.",
    ...handlers,
  };
}

/** A consultant setting the times of their own event instance. */
export function manageTimingsPolicy(
  handlers: PolicyHandlers,
): TimePickerPolicy {
  return {
    kind: "MANAGE_TIMINGS",
    minLeadHours: 0,
    lead: { purpose: "allocate" },
    showReleasedSlots: false,
    submitLabel: "Save timings",
    allowReleaseWithoutTime: false,
    calendarMode: "allocate",
    appliesInitialAllocationGuard: false,
    pickerHint:
      "Choose when this runs. Green is free on your calendar; anything else is already taken.",
    ...handlers,
  };
}
