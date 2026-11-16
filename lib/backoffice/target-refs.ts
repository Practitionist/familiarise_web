/**
 * What an audit row, a proposal or a support payment points at, in words: the
 * person and the booking behind a User, Payment, Appointment or session id.
 * One batched read per kind present on the page, so at most four statements.
 */

import prisma from "@/lib/prisma";
import { BOOKING_TITLE_SELECT, bookingRefOf } from "@/lib/data/booking-title";
import type { TargetRef } from "./money-list-schemas";

export const targetKey = (kind: string, id: string) => `${kind}:${id}`;

const PERSON = { select: { id: true, name: true, email: true } } as const;

/** The resolvable targets of a page, keyed by `targetKey`; other kinds are absent. */
export async function resolveTargets(
  targets: readonly { kind: string; id: string }[],
): Promise<Map<string, TargetRef>> {
  const idsOf = (kind: string) => [
    ...new Set(targets.filter((t) => t.kind === kind).map((t) => t.id)),
  ];
  const userIds = idsOf("User");
  const paymentIds = idsOf("Payment");
  const appointmentIds = idsOf("Appointment");
  const occurrenceIds = idsOf("AppointmentOccurrence");

  // In sequence: the pool may hold one connection.
  const users = userIds.length
    ? await prisma.user.findMany({
        where: { id: { in: userIds } },
        select: PERSON.select,
      })
    : [];
  const payments = paymentIds.length
    ? await prisma.payment.findMany({
        relationLoadStrategy: "join",
        where: { id: { in: paymentIds } },
        select: {
          id: true,
          user: PERSON,
          appointment: { select: BOOKING_TITLE_SELECT },
        },
      })
    : [];
  const appointments = appointmentIds.length
    ? await prisma.appointment.findMany({
        relationLoadStrategy: "join",
        where: { id: { in: appointmentIds } },
        select: BOOKING_TITLE_SELECT,
      })
    : [];
  const occurrences = occurrenceIds.length
    ? await prisma.appointmentOccurrence.findMany({
        relationLoadStrategy: "join",
        where: { id: { in: occurrenceIds } },
        select: { id: true, appointment: { select: BOOKING_TITLE_SELECT } },
      })
    : [];

  const refs = new Map<string, TargetRef>();
  for (const u of users) {
    refs.set(targetKey("User", u.id), { person: u, booking: null });
  }
  for (const p of payments) {
    refs.set(targetKey("Payment", p.id), {
      person: p.user,
      booking: bookingRefOf(p.appointment),
    });
  }
  for (const a of appointments) {
    refs.set(targetKey("Appointment", a.id), {
      person: null,
      booking: bookingRefOf(a),
    });
  }
  for (const o of occurrences) {
    refs.set(targetKey("AppointmentOccurrence", o.id), {
      person: null,
      booking: bookingRefOf(o.appointment),
    });
  }
  return refs;
}
