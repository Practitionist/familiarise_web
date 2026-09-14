/**
 * @jest-environment node
 */

/**
 * #1080 — the planner's class Join always reported "No joinable session found
 * for this class". `cohortInclude` was `appointment: true`, so the slot rows
 * the component derives the session from never left the database, the `?? []`
 * fallback swallowed the absence, and the message was indistinguishable from
 * the legitimate out-of-window case.
 *
 * The failure was a silently empty array, so asserting a boolean would not
 * have caught it. This drives the real route over a fake Postgres that
 * PROJECTS each row through the include the route hands it — a field the route
 * does not ask for cannot reach the payload — and then runs the real session
 * helpers over the result, which is what the component does.
 */

import { GET } from "../../app/api/dashboard/consultant/[consultantId]/planner/route";
import prisma from "@/lib/prisma";
import { requireApiAuth } from "@/lib/auth-helpers";
import {
  getCurrentOrNextOccurrence,
  getJoinableOccurrence,
  getOccurrenceJoinState,
} from "@/lib/appointments/occurrences";

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/auth-helpers", () => ({
  __esModule: true,
  requireApiAuth: jest.fn(),
  isPrivileged: () => false,
  forbiddenResponse: jest.fn(),
}));
jest.mock("../../lib/api/scope/parse", () => ({
  __esModule: true,
  resolveOrgScope: () => ({ ok: true, scope: { kind: "all" } }),
  scopeOrgId: () => null,
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    webinar: { findMany: jest.fn() },
    cohort: { findMany: jest.fn() },
    collaborator: { findMany: jest.fn() },
    consultantProfile: { findUnique: jest.fn() },
    membership: { findMany: jest.fn() },
    appointmentOccurrence: { groupBy: jest.fn() },
  },
}));

const db = prisma as unknown as {
  webinar: { findMany: jest.Mock };
  cohort: { findMany: jest.Mock };
  collaborator: { findMany: jest.Mock };
  consultantProfile: { findUnique: jest.Mock };
  membership: { findMany: jest.Mock };
  appointmentOccurrence: { groupBy: jest.Mock };
};
const mockedAuth = requireApiAuth as unknown as jest.Mock;

const CONSULTANT_PROFILE_ID = "cp-1";
const NOW = new Date("2026-08-01T10:20:00.000Z");
const hoursFromNow = (h: number) => new Date(NOW.getTime() + h * 3_600_000);

/** A slot row as Postgres holds it, before any select is applied. */
interface StoredSlot {
  id: string;
  startsAt: Date;
  endsAt: Date;
  isTentative: boolean;
  completionStatus: string;
  deletedAt: Date | null;
  meeting: {
    id: string;
    endedAt: Date | null;
    endedReason: string | null;
  } | null;
}

interface StoredAppointment {
  id: string;
  organizationId: string | null;
  occurrences: StoredSlot[];
  /** #1554 — the roster lives on the appointment. */
  participants?: Array<{ userId: string }>;
}

function storedSlot(
  id: string,
  startsAt: Date,
  extra: Partial<StoredSlot> = {},
): StoredSlot {
  return {
    id,
    startsAt,
    endsAt: new Date(startsAt.getTime() + 60 * 60_000),
    isTentative: false,
    completionStatus: "SCHEDULED",
    deletedAt: null,
    meeting: null,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// The fake Postgres: honours the include it is given, so an unasked-for field
// is genuinely absent rather than assumed present.
// ---------------------------------------------------------------------------

interface SlotSpec {
  where?: { startsAt?: { gte?: Date; lte?: Date } };
  select?: Record<string, true | { select: Record<string, true> }>;
}
interface CohortIncludeSpec {
  appointment?: true | { include?: { occurrences?: SlotSpec } };
}

function projectSlots(spec: SlotSpec, slots: StoredSlot[]) {
  const { gte, lte } = spec.where?.startsAt ?? {};
  return slots
    .filter(
      (slot) =>
        (!gte || slot.startsAt >= gte) && (!lte || slot.startsAt <= lte),
    )
    .map((slot) => {
      if (!spec.select) return slot;
      const projected: Record<string, unknown> = {};
      for (const field of Object.keys(spec.select)) {
        projected[field] = slot[field as keyof StoredSlot] ?? null;
      }
      return projected;
    });
}

let cohortRows: Array<{
  id: string;
  cohortPlanId: string;
  cohortPlan: Record<string, unknown>;
  /** #1554 — one wrapper per class carries every sitting. */
  appointment: StoredAppointment | null;
}> = [];

function seedCohort(appointment: StoredAppointment | null) {
  cohortRows = [
    {
      id: "class-1",
      cohortPlanId: "plan-1",
      cohortPlan: {
        id: "plan-1",
        title: "Systems design, eight weeks",
        consultantProfileId: CONSULTANT_PROFILE_ID,
        topics: [{ name: "architecture" }],
        cohortContents: [],
      },
      appointment,
    },
  ];
}

beforeEach(() => {
  // The route bounds its slot window with `cohortInclude(new Date())`, while
  // these rows are anchored to NOW. Without pinning the clock the suite passes
  // only on the day NOW happens to fall on.
  jest.useFakeTimers({ doNotFake: ["performance"] });
  jest.setSystemTime(NOW);
  mockedAuth.mockResolvedValue({
    session: {
      user: {
        id: "user-consultant",
        role: "USER",
        consultantProfileId: CONSULTANT_PROFILE_ID,
      },
    },
  });
  db.webinar.findMany.mockResolvedValue([]);
  db.collaborator.findMany.mockResolvedValue([]);
  db.membership.findMany.mockResolvedValue([]);
  db.consultantProfile.findUnique.mockResolvedValue({
    userId: "user-consultant",
  });

  // #1346 — the unwindowed firstSessionAt lookup; unlike cohortInclude's
  // slot select, this reads every row regardless of the ±24h window.
  // The mock applies the predicates the route actually sends, so a regression
  // that drops the deletedAt or completionStatus filter fails here instead of
  // being masked by a filter the mock invented.
  db.appointmentOccurrence.groupBy.mockImplementation(
    async (args: {
      where: {
        appointmentId: { in: string[] };
        deletedAt?: null;
        completionStatus?: { notIn: string[] };
      };
    }) => {
      const ids = new Set(args.where.appointmentId.in);
      const excludedStatuses = new Set(
        args.where.completionStatus?.notIn ?? [],
      );
      const requiresNotDeleted = "deletedAt" in args.where;
      const results: Array<{
        appointmentId: string;
        _min: { startsAt: Date };
      }> = [];
      for (const row of cohortRows) {
        const appt = row.appointment;
        if (!appt || !ids.has(appt.id)) continue;
        const live = appt.occurrences.filter(
          (slot) =>
            !excludedStatuses.has(slot.completionStatus) &&
            (!requiresNotDeleted || slot.deletedAt === null),
        );
        const earliest = live.reduce<Date | null>(
          (min, slot) => (!min || slot.startsAt < min ? slot.startsAt : min),
          null,
        );
        if (earliest) {
          results.push({
            appointmentId: appt.id,
            _min: { startsAt: earliest },
          });
        }
      }
      return results;
    },
  );

  db.cohort.findMany.mockImplementation(
    async (args: {
      include?: CohortIncludeSpec;
      where?: { cohortPlan?: { consultantProfileId?: string } };
    }) => {
      // No include means the participant-count query, which uses `select`.
      if (!args.include) {
        return cohortRows.map((row) => ({
          id: row.id,
          appointment: row.appointment
            ? {
                participants: row.appointment.participants ?? [
                  { userId: "user-attendee" },
                ],
              }
            : null,
        }));
      }
      // Only the owned-plans query matches; the collaborated one returns none.
      if (
        args.where?.cohortPlan?.consultantProfileId !== CONSULTANT_PROFILE_ID
      ) {
        return [];
      }
      const spec = args.include.appointment;
      const slotSpec = spec === true ? undefined : spec?.include?.occurrences;
      return cohortRows.map((row) => {
        if (!row.appointment) return { ...row, appointment: null };
        const {
          occurrences,
          participants: _seats,
          ...scalars
        } = row.appointment;
        // `appointment: true` — scalars only, and no slots at all. This is
        // the shape the route used to ask for.
        return {
          ...row,
          appointment: slotSpec
            ? {
                ...scalars,
                occurrences: projectSlots(slotSpec, occurrences),
              }
            : scalars,
        };
      });
    },
  );
});

/** A slot row as it survives the route's JSON serialization. */
interface PayloadSlot {
  id: string;
  startsAt: string;
  endsAt: string | null;
  isTentative: boolean;
  completionStatus: string;
  meeting: {
    id: string;
    endedAt: string | null;
    endedReason: string | null;
  } | null;
}

async function plannerCohorts() {
  const res = await GET(
    new Request(
      `http://localhost/api/dashboard/consultant/${CONSULTANT_PROFILE_ID}/planner`,
    ) as never,
    { params: Promise.resolve({ consultantId: CONSULTANT_PROFILE_ID }) },
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  return body.data.cohorts as Array<{
    id: string;
    firstSessionAt: string | null;
    appointment: {
      id: string;
      occurrences?: PayloadSlot[];
    } | null;
  }>;
}

/** The class wrapper with a one-hour sitting live right now (#1554). */
const liveSitting = (
  extra: Partial<StoredSlot> = {},
  more: StoredSlot[] = [],
): StoredAppointment => ({
  id: "appt-class",
  organizationId: null,
  occurrences: [storedSlot("slot-a1", hoursFromNow(-0.5), extra), ...more],
});

describe("the planner payload carries what a class join reads", () => {
  it("returns the slot rows at all, with exactly the join path's fields", async () => {
    seedCohort(liveSitting());

    const [cls] = await plannerCohorts();
    const slots = cls.appointment!.occurrences;

    expect(slots).toHaveLength(1);
    // An exact key set, both ways: the join path's fields are all present, and
    // nothing the route trimmed on purpose has crept back in.
    expect(Object.keys(slots![0]).sort()).toEqual([
      "completionStatus",
      "endsAt",
      "id",
      "isTentative",
      "meeting",
      "startsAt",
    ]);
  });

  it("resolves to the live occurrence", async () => {
    seedCohort(liveSitting());

    const [cls] = await plannerCohorts();
    const run = getJoinableOccurrence(cls.appointment!.occurrences!, {
      joinWindowMs: 10 * 60 * 1000,
      now: NOW,
    });

    expect(run).not.toBeNull();
    // The room is keyed to this id (#1554); before #1080 there were no rows
    // at all, so the class Join could never even get here.
    expect(run!.id).toBe("slot-a1");
  });

  it("sees a host-ended call rather than only the clock", async () => {
    // The `meeting` select is what makes the ended guard reachable:
    // the row is still inside its window, so the clock alone says "joinable".
    seedCohort(
      liveSitting({
        meeting: {
          id: "ms-1",
          endedAt: hoursFromNow(-0.1),
          endedReason: null,
        },
      }),
    );

    const [cls] = await plannerCohorts();
    const slots = cls.appointment!.occurrences!;
    const run = getCurrentOrNextOccurrence(slots, NOW);

    expect(run).not.toBeNull();
    expect(
      getOccurrenceJoinState(run!, { joinWindowMs: 10 * 60 * 1000, now: NOW }),
    ).toBe("ended");
  });

  it("drops rows a day out while keeping the live occurrence", async () => {
    seedCohort(
      liveSitting({}, [storedSlot("slot-far", hoursFromNow(24 * 30))]),
    );

    const [cls] = await plannerCohorts();
    const ids = (cls.appointment!.occurrences ?? []).map(
      (slot) => slot.id as string,
    );

    // The bound has to keep anything currently joinable.
    expect(ids).toEqual(["slot-a1"]);
  });

  it("names the class's first session even when every slot is outside the join window", async () => {
    // #1346 — a class whose only session is 5 days out gets zero slots from
    // cohortInclude's ±24h window, so the card's date must come from the
    // separate, unwindowed firstSessionAt field.
    const farStart = hoursFromNow(24 * 5);
    seedCohort({
      id: "appt-class",
      organizationId: null,
      occurrences: [storedSlot("slot-far", farStart)],
    });

    const [cls] = await plannerCohorts();

    expect(cls.appointment!.occurrences).toHaveLength(0);
    expect(cls.firstSessionAt).toBe(farStart.toISOString());
  });

  it("still counts participants from its own batched query", async () => {
    // The slot select carries no roster, so the count must not have silently
    // moved onto the trimmed rows.
    seedCohort(liveSitting());

    const res = await GET(
      new Request(
        `http://localhost/api/dashboard/consultant/${CONSULTANT_PROFILE_ID}/planner`,
      ) as never,
      { params: Promise.resolve({ consultantId: CONSULTANT_PROFILE_ID }) },
    );
    const body = await res.json();

    expect(body.data.participantCounts["class-1"]).toBe(1);
  });
});

afterEach(() => {
  jest.useRealTimers();
});
