import type { Prisma } from "@prisma/client";

import type { OfferingPlanType } from "./stats";

/**
 * #1527 decision 6 / #1846 — the one definition of "nothing has ever touched
 * this offering". The DELETE routes put it inside their `deleteMany` WHERE
 * (lib/booking/offering-delete.ts), and the Offerings card's `canDelete` read
 * (lib/data/offering-stats.ts) runs the same fragments as a query, so the card
 * cannot offer a Delete the server refuses. Anything touched gets Archive.
 *
 * History is a booking, a payment or a seat of ANY status: every Payment,
 * PENDING and FAILED included, cascades with its appointment, and a seat that
 * was released still records that someone held it.
 */

/** An event appointment with a payment or a consultee seat, ever. */
const APPOINTMENT_HAS_HISTORY = {
  OR: [
    { payment: { some: {} } },
    { participants: { some: { role: "CONSULTEE" } } },
  ],
} satisfies Prisma.AppointmentWhereInput;

/** A webinar or class instance that has history. */
export const TOUCHED_EVENT = {
  appointment: { is: APPOINTMENT_HAS_HISTORY },
} satisfies Prisma.WebinarWhereInput & Prisma.ClassWhereInput;

/** The in-WHERE guard for deleting one webinar or class instance. */
export const UNTOUCHED_EVENT = {
  NOT: TOUCHED_EVENT,
} satisfies Prisma.WebinarWhereInput & Prisma.ClassWhereInput;

/** The in-WHERE guard for a consultation plan: no request row of any status. */
export const UNTOUCHED_CONSULTATION_PLAN = {
  consultations: { none: {} },
} satisfies Prisma.ConsultationPlanWhereInput;

/**
 * The in-WHERE guard for a subscription plan: no request and no trial (Trial's
 * plan key is RESTRICT, so a trial made the old delete fail as a 500).
 */
export const UNTOUCHED_SUBSCRIPTION_PLAN = {
  subscriptions: { none: {} },
  trials: { none: {} },
} satisfies Prisma.SubscriptionPlanWhereInput;

/**
 * The plan-level form the card reads. A group offering is deletable only while
 * none of its instances is touched, which is the instance guard above applied
 * to every instance the card could delete.
 */
export const UNTOUCHED_PLAN = {
  consultation: UNTOUCHED_CONSULTATION_PLAN,
  subscription: UNTOUCHED_SUBSCRIPTION_PLAN,
  webinar: { webinars: { none: TOUCHED_EVENT } },
  class: { classes: { none: TOUCHED_EVENT } },
} satisfies Record<OfferingPlanType, object>;
