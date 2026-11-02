/**
 * @jest-environment node
 */
import {
  MAX_CONSULTEE_RESCHEDULES,
  consulteeCapReached,
  priorReschedules,
} from "@/lib/booking/reschedule-caps";

type Row = {
  id: string;
  status: string;
  createdAt: Date;
  releasedSessions: unknown;
  restoredAt: Date | null;
};

/** A fake tx that applies the counted-requests filter the way Postgres would. */
function fakeTx(rows: Row[]) {
  return {
    rescheduleRequest: {
      findMany: jest.fn(
        async ({
          where,
        }: {
          where: { status: { not: string }; restoredAt: null };
        }) =>
          rows.filter(
            (r) => r.status !== where.status.not && r.restoredAt === null,
          ),
      ),
    },
  } as never;
}

const row = (
  id: string,
  status: string,
  ordinal: number,
  restoredAt: Date | null = null,
): Row => ({
  id,
  status,
  createdAt: new Date("2026-11-01T00:00:00Z"),
  releasedSessions: [{ ordinal, startsAt: "2026-11-20T10:00:00.000Z" }],
  restoredAt,
});

const RESTORED = new Date("2026-11-02T00:00:00Z");

describe("reschedule caps per session", () => {
  it("counts each session on its own: two moves of session 1 leave session 2 free", async () => {
    const prior = await priorReschedules(
      fakeTx([row("a", "ACCEPTED", 1), row("b", "AUTO_ACCEPTED", 1)]),
      { appointmentId: "appt", role: "CONSULTEE" },
    );
    expect(prior.byOrdinal.get(1)).toBe(MAX_CONSULTEE_RESCHEDULES);
    expect(consulteeCapReached(prior, [1])).toBe(true);
    expect(consulteeCapReached(prior, [2])).toBe(false);
  });

  it("forgives withdrawn requests and any request whose ending restored the booking", async () => {
    const prior = await priorReschedules(
      fakeTx([
        row("w", "WITHDRAWN", 1, RESTORED),
        row("e", "EXPIRED", 1, RESTORED),
        row("d", "DECLINED", 1, RESTORED),
      ]),
      { appointmentId: "appt", role: "CONSULTEE" },
    );
    expect(prior.total).toBe(0);
    expect(consulteeCapReached(prior, [1])).toBe(false);
  });

  it("stays forgiven after the restored session is delivered or moved again", async () => {
    // The restore is recorded on the request, so what later happens to the
    // session (completed, re-released and replaced) cannot charge it again.
    const prior = await priorReschedules(
      fakeTx([
        row("d1", "DECLINED", 1, RESTORED),
        row("d2", "EXPIRED", 2, RESTORED),
        row("a", "ACCEPTED", 1),
      ]),
      { appointmentId: "appt", role: "CONSULTANT" },
    );
    expect(prior.total).toBe(1);
  });

  it("charges a declined request whose original time was lost (no restore)", async () => {
    const prior = await priorReschedules(
      fakeTx([row("d", "DECLINED", 1), row("a", "ACCEPTED", 1)]),
      { appointmentId: "appt", role: "CONSULTEE" },
    );
    expect(prior.total).toBe(2);
    expect(consulteeCapReached(prior, [1])).toBe(true);
  });
});
