/**
 * The title a back-office money row gives its booking, read in the row's own
 * joined query. There is no title column: the plan behind the booking names it.
 * `appointmentHeadline` serves screens that also name the booking's people.
 */

import type { AppointmentsType, Prisma } from "@prisma/client";

const TITLE = { select: { title: true } } as const;

/** The plan titles a booking title reads; join it with `relationLoadStrategy: "join"`. */
export const BOOKING_TITLE_SELECT = {
  id: true,
  appointmentType: true,
  consultation: { select: { consultationPlan: TITLE } },
  subscription: { select: { subscriptionPlan: TITLE } },
  webinar: { select: { webinarPlan: TITLE } },
  class: { select: { classPlan: TITLE } },
  trial: { select: { subscriptionPlan: TITLE } },
} satisfies Prisma.AppointmentSelect;

type Titled<K extends string> = { [P in K]: { title: string } } | null;

export interface BookingTitleInput {
  id: string;
  appointmentType: AppointmentsType;
  consultation: Titled<"consultationPlan">;
  subscription: Titled<"subscriptionPlan">;
  webinar: Titled<"webinarPlan">;
  class: Titled<"classPlan">;
  trial: Titled<"subscriptionPlan">;
}

/** A booking as a money row names it: its id, its kind and its plan's title. */
export interface BookingRef {
  id: string;
  type: AppointmentsType;
  title: string;
}

const REMOVED_TITLE: Record<AppointmentsType, string> = {
  CONSULTATION: "Consultation (record removed)",
  SUBSCRIPTION: "Subscription (record removed)",
  WEBINAR: "Webinar (record removed)",
  CLASS: "Class (record removed)",
  TRIAL: "Trial (record removed)",
};

/** The plan title behind a booking; says so when its lifecycle row is gone. */
export function bookingTitleOf(a: BookingTitleInput): string {
  const title =
    a.consultation?.consultationPlan.title ??
    a.subscription?.subscriptionPlan.title ??
    a.webinar?.webinarPlan.title ??
    a.class?.classPlan.title ??
    a.trial?.subscriptionPlan.title;
  return title?.trim() || REMOVED_TITLE[a.appointmentType];
}

export function bookingRefOf(
  a: BookingTitleInput | null | undefined,
): BookingRef | null {
  return a
    ? { id: a.id, type: a.appointmentType, title: bookingTitleOf(a) }
    : null;
}
