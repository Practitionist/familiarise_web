/**
 * @jest-environment node
 */
import { countExpertStrikes } from "@/lib/booking/expert-reliability";

const SINCE = new Date("2026-10-01T00:00:00Z");
const INCIDENT = {
  startsAt: new Date("2026-10-10T10:00:00Z"),
  endsAt: new Date("2026-10-10T12:00:00Z"),
};

/** Sessions of one booking: the voided original inside the incident, the rebook after it. */
const SESSIONS = [
  {
    id: "occ-original",
    appointmentId: "appt-1",
    startsAt: new Date("2026-10-10T10:30:00Z"),
    endsAt: new Date("2026-10-10T11:30:00Z"),
  },
  {
    id: "occ-rebook",
    appointmentId: "appt-1",
    startsAt: new Date("2026-10-14T10:00:00Z"),
    endsAt: new Date("2026-10-14T11:00:00Z"),
  },
];

function fakeDb(contexts: unknown[]) {
  return {
    systemEvent: {
      findMany: jest.fn(async () => contexts.map((context) => ({ context }))),
    },
    platformIncident: { findMany: jest.fn(async () => [INCIDENT]) },
    appointmentOccurrence: {
      findMany: jest.fn(
        async ({
          where,
        }: {
          where: { AND: [{ OR: Record<string, { in: string[] }>[] }, unknown] };
        }) => {
          const named = where.AND[0].OR;
          const ids = named.flatMap((arm) => arm.id?.in ?? []);
          const bookings = named.flatMap((arm) => arm.appointmentId?.in ?? []);
          return SESSIONS.filter(
            (s) =>
              (ids.includes(s.id) || bookings.includes(s.appointmentId)) &&
              s.startsAt < INCIDENT.endsAt &&
              s.endsAt > INCIDENT.startsAt,
          ).map(({ id, appointmentId }) => ({ id, appointmentId }));
        },
      ),
    },
  } as never;
}

describe("expert strikes and declared incidents", () => {
  it("keeps a strike on the rebooked session although the voided original overlaps the incident", async () => {
    const db = fakeDb([
      { appointmentId: "appt-1", occurrenceIds: ["occ-rebook"] },
    ]);
    expect(await countExpertStrikes("cp-1", SINCE, { db })).toBe(1);
  });

  it("drops a strike on a session inside the incident", async () => {
    const db = fakeDb([
      { appointmentId: "appt-1", occurrenceIds: ["occ-original"] },
    ]);
    expect(await countExpertStrikes("cp-1", SINCE, { db })).toBe(0);
  });

  it("judges a strike recorded without its sessions by its whole booking", async () => {
    const db = fakeDb([{ appointmentId: "appt-1" }]);
    expect(await countExpertStrikes("cp-1", SINCE, { db })).toBe(0);
  });

  it("judges a strike naming an empty session list by its whole booking", async () => {
    const db = fakeDb([{ appointmentId: "appt-1", occurrenceIds: [] }]);
    expect(await countExpertStrikes("cp-1", SINCE, { db })).toBe(0);
  });
});
