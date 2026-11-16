/**
 * What an audit row, a proposal or a support payment points at, in words: the
 * person and the booking behind a User, Payment, Appointment, session,
 * Organization or Lead id. At most four batched reads a page, one per pair.
 */

import prisma from "@/lib/prisma";
import { BOOKING_TITLE_SELECT, bookingRefOf } from "@/lib/data/booking-title";
import type { TargetRef } from "./money-list-schemas";

export const targetKey = (kind: string, id: string) => `${kind}:${id}`;

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
  const organizationIds = idsOf("Organization");
  const leadIds = idsOf("Lead");

  // In sequence: the pool may hold one connection. A user read also brings the
  // page's payments by their buyer, and a booking read its sessions.
  const users =
    userIds.length || paymentIds.length
      ? await prisma.user.findMany({
          relationLoadStrategy: "join",
          where: {
            OR: [
              ...(userIds.length ? [{ id: { in: userIds } }] : []),
              ...(paymentIds.length
                ? [{ Payment: { some: { id: { in: paymentIds } } } }]
                : []),
            ],
          },
          select: {
            id: true,
            name: true,
            email: true,
            Payment: {
              where: { id: { in: paymentIds } },
              select: {
                id: true,
                appointment: { select: BOOKING_TITLE_SELECT },
              },
            },
          },
        })
      : [];
  const appointments =
    appointmentIds.length || occurrenceIds.length
      ? await prisma.appointment.findMany({
          relationLoadStrategy: "join",
          where: {
            OR: [
              ...(appointmentIds.length
                ? [{ id: { in: appointmentIds } }]
                : []),
              ...(occurrenceIds.length
                ? [{ occurrences: { some: { id: { in: occurrenceIds } } } }]
                : []),
            ],
          },
          select: {
            ...BOOKING_TITLE_SELECT,
            occurrences: {
              where: { id: { in: occurrenceIds } },
              select: { id: true },
            },
          },
        })
      : [];
  const organizations = organizationIds.length
    ? await prisma.organization.findMany({
        where: { id: { in: organizationIds } },
        select: { id: true, name: true },
      })
    : [];
  const leads = leadIds.length
    ? await prisma.lead.findMany({
        where: { id: { in: leadIds } },
        select: {
          id: true,
          contactName: true,
          contactEmail: true,
          companyName: true,
        },
      })
    : [];

  const refs = new Map<string, TargetRef>();
  const wantedUsers = new Set(userIds);
  for (const { Payment: payments, ...person } of users) {
    if (wantedUsers.has(person.id)) {
      refs.set(targetKey("User", person.id), { person, booking: null });
    }
    for (const p of payments) {
      refs.set(targetKey("Payment", p.id), {
        person,
        booking: bookingRefOf(p.appointment),
      });
    }
  }
  const wantedAppointments = new Set(appointmentIds);
  for (const { occurrences, ...a } of appointments) {
    const booking = bookingRefOf(a);
    if (wantedAppointments.has(a.id)) {
      refs.set(targetKey("Appointment", a.id), { person: null, booking });
    }
    for (const o of occurrences) {
      refs.set(targetKey("AppointmentOccurrence", o.id), {
        person: null,
        booking,
      });
    }
  }
  for (const o of organizations) {
    refs.set(targetKey("Organization", o.id), {
      person: { id: o.id, name: o.name, email: null },
      booking: null,
    });
  }
  for (const l of leads) {
    const name = l.companyName
      ? `${l.contactName} (${l.companyName})`
      : l.contactName;
    refs.set(targetKey("Lead", l.id), {
      person: { id: l.id, name, email: l.contactEmail },
      booking: null,
    });
  }
  return refs;
}
