/**
 * @jest-environment node
 */

/**
 * The org Library's Everyone view is the org's oversight list, counts only. It
 * must scope by what the org owns (orgOwnedAppointmentWhere) rather than by the
 * `organizationId` tag, which a member's personally paid booking also carries,
 * and it must ignore free text and person filters that would confirm file
 * names or participants the view never shows. Mine keeps both filters.
 */

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    appointment: { count: jest.fn(), findMany: jest.fn() },
    user: { findMany: jest.fn() },
    planMaterial: { findMany: jest.fn() },
    recording: { findMany: jest.fn() },
  },
}));

import prisma from "../../lib/prisma";
import { orgOwnedAppointmentWhere } from "../../lib/api/scope/list-appointments";
import { readDocumentLibrary } from "../../lib/data/document-library";
import { readRecordingLibrary } from "../../lib/data/recording-library";
import { parseLibraryQuery } from "../../lib/library/library-query";

const db = prisma as unknown as {
  appointment: { count: jest.Mock; findMany: jest.Mock };
  user: { findMany: jest.Mock };
  planMaterial: { findMany: jest.Mock };
  recording: { findMany: jest.Mock };
};

const ORG = "org-1";
const EVERYONE = { kind: "org", orgId: ORG, everyone: true } as const;
const MINE = { kind: "org", orgId: ORG, everyone: false } as const;

const query = (qs: string) => {
  const sp = new URLSearchParams(qs);
  return parseLibraryQuery((k) => sp.get(k));
};

const FILTERED = "q=cv&person=u-other&source=expert&status=done";

beforeEach(() => {
  jest.clearAllMocks();
  db.appointment.count.mockResolvedValue(0);
  db.appointment.findMany.mockResolvedValue([]);
  db.user.findMany.mockResolvedValue([]);
  db.planMaterial.findMany.mockResolvedValue([]);
  db.recording.findMany.mockResolvedValue([]);
});

/** The WHERE the first booking read ran with (count, else the page's candidates), as plain JSON. */
const countedWhere = (): { AND: unknown[] } => {
  const call =
    db.appointment.count.mock.calls[0] ?? db.appointment.findMany.mock.calls[0];
  return JSON.parse(JSON.stringify(call[0].where));
};

const READERS = [
  {
    name: "documents",
    read: (owner: typeof EVERYONE | typeof MINE, qs: string) =>
      readDocumentLibrary({ userId: "u1", owner, query: query(qs) }),
  },
  {
    name: "recordings",
    read: (owner: typeof EVERYONE | typeof MINE, qs: string) =>
      readRecordingLibrary({ userId: "u1", owner, query: query(qs) }),
  },
] as const;

describe.each(READERS)("$name library, Everyone", ({ read }) => {
  it("scopes by org-owned bookings, not the organizationId tag", async () => {
    await read(EVERYONE, "");
    const scope = countedWhere().AND[0] as Record<string, unknown>;
    const owned = JSON.parse(JSON.stringify(orgOwnedAppointmentWhere(ORG)));
    expect(scope).toMatchObject(owned);
    expect(scope).not.toHaveProperty("organizationId");
    expect(scope.deletedAt).toBeNull();
  });

  it("excludes a personally paid, org-tagged booking", async () => {
    await read(EVERYONE, "");
    const scope = countedWhere().AND[0] as { OR: Record<string, unknown>[] };
    const tagged = scope.OR.find((arm) => arm.organizationId === ORG);
    // The tagged arm admits only unpaid rows or ones an org rail paid for.
    expect(tagged).toMatchObject({
      OR: [
        { payment: { none: {} } },
        {
          payment: {
            some: {
              organizationId: ORG,
              paymentMethod: { in: ["WALLET", "INVOICE", "LICENSE"] },
            },
          },
        },
      ],
    });
  });

  it("includes a plan the org hosts bought by a B2C buyer", async () => {
    await read(EVERYONE, "");
    const scope = countedWhere().AND[0] as { OR: Record<string, unknown>[] };
    // Hosted-plan arms carry no buyer tag and no payment condition.
    const hosted = scope.OR.filter((arm) => !("organizationId" in arm));
    expect(hosted.length).toBeGreaterThanOrEqual(4);
    expect(hosted[0]).toEqual({
      consultation: {
        consultationPlan: expect.objectContaining({ organizationId: ORG }),
      },
    });
  });

  it("ignores q, person and source", async () => {
    await read(EVERYONE, FILTERED);
    const withFilters = JSON.stringify(countedWhere());
    db.appointment.count.mockClear();
    db.appointment.findMany.mockClear();
    await read(EVERYONE, "status=done");
    expect(withFilters).toBe(JSON.stringify(countedWhere()));
    expect(withFilters).not.toContain("u-other");
    expect(withFilters).not.toContain('"cv"');
  });
});

describe.each(READERS)("$name library, Mine", ({ read }) => {
  it("still applies q and person", async () => {
    await read(MINE, FILTERED);
    const withFilters = JSON.stringify(countedWhere());
    expect(withFilters).toContain("u-other");
    expect(withFilters).toContain('"cv"');
  });
});
