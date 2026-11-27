/** @jest-environment node */

// Invariant: a booking's support page shows a case only to a viewer the case
// read policy still admits. A person who filed an organisation-owned case reads
// it while they hold that organisation's support permission, and not after.

jest.mock("../../lib/prisma", () => {
  const { memTable } = jest.requireActual("../fixtures/mem-db");
  return {
    __esModule: true,
    default: {
      supportCase: memTable([], "case"),
      membership: memTable([], "mem"),
    },
  };
});

import prisma from "@/lib/prisma";
import {
  readOpenSessionReports,
  readShownThread,
} from "@/lib/support/shown-thread";
import type { memTable, Row } from "../fixtures/mem-db";

type Table = ReturnType<typeof memTable>;
const { supportCase: cases, membership: memberships } =
  prisma as unknown as Record<string, Table>;

const filedBy = (id: string, over: Row = {}): Row => ({
  id,
  appointmentId: "apt-1",
  appointment: null,
  requesterUserId: "operator",
  submitterUserId: "operator",
  deletedAt: null,
  externalRequesterEmail: null,
  ownershipScope: "ORG_OPERATIONS",
  organizationId: "org-1",
  category: "NO_SHOW",
  issueType: null,
  status: "OPEN",
  appointmentOccurrenceId: "occ-1",
  occurrence: { startsAt: new Date("2026-11-20T10:00:00Z") },
  createdAt: new Date("2026-11-21T10:00:00Z"),
  messages: [],
  ...over,
});

const member = (role: string, status = "ACTIVE"): Row => ({
  id: "mem-1",
  userId: "operator",
  organizationId: "org-1",
  role,
  status,
});

beforeEach(() => {
  cases.rows.splice(0, cases.rows.length);
  memberships.rows.splice(0, memberships.rows.length);
});

const read = async () => ({
  thread: (
    await readShownThread("apt-1", "operator", { occurrenceId: "occ-1" })
  )?.id,
  named: (
    await readShownThread("apt-1", "operator", {
      occurrenceId: "occ-1",
      caseId: "org-case",
    })
  )?.id,
  reports: (await readOpenSessionReports("apt-1", "operator")).map(
    (r) => r.caseId,
  ),
});

it("shows an organisation-owned case to the operator who filed it while they hold the organisation's support permission", async () => {
  cases.rows.push(filedBy("org-case"));
  memberships.rows.push(member("OWNER"));

  expect(await read()).toEqual({
    thread: "org-case",
    named: "org-case",
    reports: ["org-case"],
  });
});

it.each([
  ["their membership ended", () => member("OWNER", "REMOVED")],
  ["they left the organisation", () => null],
])(
  "stops showing it once %s, by name or by session, while their own personal case still shows",
  async (_label, membership) => {
    cases.rows.push(
      filedBy("org-case"),
      filedBy("own-case", {
        ownershipScope: "PERSONAL",
        organizationId: null,
        createdAt: new Date("2026-11-20T10:00:00Z"),
      }),
    );
    const row = membership();
    if (row) memberships.rows.push(row);

    expect(await read()).toEqual({
      // The newest case the policy admits, not the newest case.
      thread: "own-case",
      named: "own-case",
      reports: ["own-case"],
    });
  },
);
