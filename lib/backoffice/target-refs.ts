/**
 * What an audit row, a proposal or a support payment points at, in words: the
 * person and the booking behind a User, Payment, Appointment, session,
 * Organization or Lead id. At most four batched reads a page, one per pair.
 */

import prisma from "@/lib/prisma";
import { BOOKING_TITLE_SELECT, bookingRefOf } from "@/lib/data/booking-title";
import type { TargetRef } from "./money-list-schemas";

export const targetKey = (kind: string, id: string) => `${kind}:${id}`;

type Refs = Map<string, TargetRef>;
type Ids = (kind: string) => string[];

/** One user read that also brings the page's payments, by their buyer. */
async function resolvePeopleAndPayments(idsOf: Ids, refs: Refs) {
  const userIds = idsOf("User");
  const paymentIds = idsOf("Payment");
  if (!userIds.length && !paymentIds.length) return;
  const users = await prisma.user.findMany({
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
        select: { id: true, appointment: { select: BOOKING_TITLE_SELECT } },
      },
    },
  });
  const wanted = new Set(userIds);
  for (const { Payment: payments, ...person } of users) {
    if (wanted.has(person.id)) {
      refs.set(targetKey("User", person.id), { person, booking: null });
    }
    for (const p of payments) {
      refs.set(targetKey("Payment", p.id), {
        person,
        booking: bookingRefOf(p.appointment),
      });
    }
  }
}

/** One booking read that also brings the page's sessions. */
async function resolveBookingsAndSessions(idsOf: Ids, refs: Refs) {
  const appointmentIds = idsOf("Appointment");
  const occurrenceIds = idsOf("AppointmentOccurrence");
  if (!appointmentIds.length && !occurrenceIds.length) return;
  const appointments = await prisma.appointment.findMany({
    relationLoadStrategy: "join",
    where: {
      OR: [
        ...(appointmentIds.length ? [{ id: { in: appointmentIds } }] : []),
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
  });
  const wanted = new Set(appointmentIds);
  for (const { occurrences, ...a } of appointments) {
    const booking = bookingRefOf(a);
    if (wanted.has(a.id)) {
      refs.set(targetKey("Appointment", a.id), { person: null, booking });
    }
    for (const o of occurrences) {
      refs.set(targetKey("AppointmentOccurrence", o.id), {
        person: null,
        booking,
      });
    }
  }
}

async function resolveOrganizations(idsOf: Ids, refs: Refs) {
  const ids = idsOf("Organization");
  if (!ids.length) return;
  const organizations = await prisma.organization.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true },
  });
  for (const o of organizations) {
    refs.set(targetKey("Organization", o.id), {
      person: { id: o.id, name: o.name, email: null },
      booking: null,
    });
  }
}

async function resolveLeads(idsOf: Ids, refs: Refs) {
  const ids = idsOf("Lead");
  if (!ids.length) return;
  const leads = await prisma.lead.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      contactName: true,
      contactEmail: true,
      companyName: true,
    },
  });
  for (const l of leads) {
    const name = l.companyName
      ? `${l.contactName} (${l.companyName})`
      : l.contactName;
    refs.set(targetKey("Lead", l.id), {
      person: { id: l.id, name, email: l.contactEmail },
      booking: null,
    });
  }
}

/** The resolvable targets of a page, keyed by `targetKey`; other kinds are absent. */
export async function resolveTargets(
  targets: readonly { kind: string; id: string }[],
): Promise<Map<string, TargetRef>> {
  const idsOf: Ids = (kind) => [
    ...new Set(targets.filter((t) => t.kind === kind).map((t) => t.id)),
  ];
  const refs: Refs = new Map();
  // In sequence: the pool may hold one connection.
  await resolvePeopleAndPayments(idsOf, refs);
  await resolveBookingsAndSessions(idsOf, refs);
  await resolveOrganizations(idsOf, refs);
  await resolveLeads(idsOf, refs);
  return refs;
}
