/**
 * @jest-environment node
 */

/**
 * An admin-processed erasure runs the live-booking check the self-serve delete
 * runs: a learner who still holds a plan, a consultation, a trial or a class or
 * webinar seat is refused with ERASURE_BLOCKED_ACTIVE_BOOKINGS, naming what is
 * live, and is never scrubbed. Erasure never cancels a booking itself.
 */

const mockScrub = jest.fn(async () => ({
  scrubbed: true,
  pseudonymousId: "pseudo-000000000000",
  affectedOrganizationIds: [] as string[],
  vendorFailures: [] as string[],
}));
jest.mock("../../lib/compliance/erasure/mail-footprint", () => ({
  scrubMailFootprintTx: jest.fn(),
}));
jest.mock("../../lib/digital-products/erasure", () => ({
  scrubDigitalProductsTx: jest.fn(async () => []),
  purgeErasedCreatorFiles: jest.fn(async () => []),
}));
jest.mock("../../lib/documents/document-erasure", () => ({
  eraseUserSessionDocuments: jest.fn(async () => []),
}));
jest.mock("../../lib/enterprise/outbound-webhooks/dispatch", () => ({
  dispatchWebhookEvent: jest.fn(async () => undefined),
}));
jest.mock("../../lib/api/organizations/seat-count", () => ({
  releaseSeatsForTerminatedAssignments: jest.fn(async () => undefined),
}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));
jest.mock("../../lib/collaborators/ending", () => ({
  endCollaborationsForUser: jest.fn(async () => []),
}));
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/auth-helpers", () => ({
  requireBackofficeSurface: jest.fn(async () => ({
    session: { user: { id: "admin_1" } },
  })),
}));
// The scrub itself has its own suites; this one pins the gate in front of it.
jest.mock("../../lib/compliance/erasure/scrub-user", () => ({
  ...jest.requireActual("../../lib/compliance/erasure/scrub-user"),
  scrubUser: () => mockScrub(),
}));

const live = { consultations: 0, plans: 0, trials: 0, seats: 0 };
/** What the user hosts as an expert; no expert profile unless `profile` is set. */
const hosted = { profile: false, trials: 0 };
type CountArgs = { where: Record<string, unknown> };
const mockSeatCount = jest.fn(async (_args: { where: unknown }) => live.seats);
jest.mock("../../lib/prisma", () => {
  const zero = { count: jest.fn(async () => 0) };
  return {
    __esModule: true,
    default: {
      erasureRequest: {
        findUnique: jest.fn(async () => ({
          id: "er_1",
          userId: "learner-1",
          status: "PENDING",
        })),
        update: jest.fn(async () => ({})),
      },
      membership: { findMany: jest.fn(async () => []) },
      consultantPayout: zero,
      consultantEarnings: zero,
      dispute: zero,
      organizationInvoice: zero,
      // The learner's own bookings name the requester; the hosted ones name the plan or the expert.
      consultation: {
        count: jest.fn(async ({ where }: CountArgs) =>
          "consultationPlan" in where ? 0 : live.consultations,
        ),
      },
      subscription: {
        count: jest.fn(async ({ where }: CountArgs) =>
          "subscriptionPlan" in where ? 0 : live.plans,
        ),
      },
      trial: {
        count: jest.fn(async ({ where }: CountArgs) =>
          "consultantProfileId" in where ? hosted.trials : live.trials,
        ),
      },
      consultantProfile: {
        findFirst: jest.fn(async () =>
          hosted.profile ? { id: "expert-profile" } : null,
        ),
      },
      webinar: zero,
      class: zero,
      rescheduleRequest: zero,
      collaborator: zero,
      appointment: {
        count: (args: { where: unknown }) => mockSeatCount(args),
      },
    },
  };
});

import { NextRequest } from "next/server";
import { POST } from "../../app/api/admin/erasure-requests/[id]/process/route";

const process = () =>
  POST(
    new NextRequest(
      "http://localhost/api/admin/erasure-requests/er_1/process",
      { method: "POST" },
    ),
    { params: Promise.resolve({ id: "er_1" }) },
  );

beforeEach(() => {
  jest.clearAllMocks();
  Object.assign(live, { consultations: 0, plans: 0, trials: 0, seats: 0 });
  Object.assign(hosted, { profile: false, trials: 0 });
});

it("refuses an expert who still hosts a scheduled free trial, names it, and never scrubs", async () => {
  Object.assign(hosted, { profile: true, trials: 1 });

  const res = await process();

  expect(res.status).toBe(409);
  const body = await res.json();
  expect(body.code).toBe("ERASURE_BLOCKED_ACTIVE_APPOINTMENTS");
  expect(body.breakdown).toMatchObject({ trials: 1, consultations: 0 });
  expect(body.error).toContain("1 active trial");
  expect(body.error).toMatch(/cancel/i);
  expect(mockScrub).not.toHaveBeenCalled();
});

it("refuses a learner with a live plan, names it and the cancel door, and never scrubs", async () => {
  live.plans = 1;

  const res = await process();

  expect(res.status).toBe(409);
  const body = await res.json();
  expect(body.code).toBe("ERASURE_BLOCKED_ACTIVE_BOOKINGS");
  expect(body.counts).toEqual({
    activeConsultations: 0,
    activeSubscriptions: 1,
    activeTrials: 0,
    activeEventSeats: 0,
  });
  expect(body.error).toContain("1 plan");
  expect(body.error).toMatch(/cancel/i);
  expect(mockScrub).not.toHaveBeenCalled();
});

it("refuses a learner who still holds a seat on a class or webinar until its last session ends", async () => {
  live.seats = 1;

  const res = await process();

  expect(res.status).toBe(409);
  const body = await res.json();
  expect(body.counts.activeEventSeats).toBe(1);
  expect(body.error).toContain("1 class or webinar seat");
  expect(mockScrub).not.toHaveBeenCalled();
  // A fulfilled learner seat on an event with a session ahead or under way.
  expect(mockSeatCount).toHaveBeenCalledWith({
    where: expect.objectContaining({
      OR: [{ webinarId: { not: null } }, { classId: { not: null } }],
      participants: {
        some: expect.objectContaining({
          userId: "learner-1",
          role: "CONSULTEE",
        }),
      },
      occurrences: {
        some: {
          deletedAt: null,
          completionStatus: { in: ["SCHEDULED", "RESCHEDULED"] },
          endsAt: { gt: expect.any(Date) },
        },
      },
    }),
  });
});

it("scrubs a learner with nothing live", async () => {
  const res = await process();

  expect(res.status).toBe(200);
  expect(mockScrub).toHaveBeenCalledTimes(1);
});
