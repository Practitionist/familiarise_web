/**
 * @jest-environment node
 */

/**
 * A participant row written for a collaborator stays behind when the
 * collaboration ends. These readers answer "does this user hold a seat here"
 * to list, open or notify, so every seat predicate they build must leave such
 * a row out. A current collaborator is reached through the team instead.
 */

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    recording: { findMany: jest.fn(), count: jest.fn() },
    $transaction: jest.fn(async (reads: unknown[]) => Promise.all(reads)),
  },
}));

import prisma from "@/lib/prisma";
import { buildWhere } from "@/lib/api/scope/list-appointments";
import { buildUserAppointmentAccessOr } from "@/lib/api/scope/list-documents";
import { listRecordingsScoped } from "@/lib/api/scope/list-recordings";
import { suspendedMemberAttendeeWhere } from "@/lib/enterprise/suspended-member-sessions";
import { bookingPartyWhere } from "@/lib/moderation/report-case";

/** Every `participants: { some }` predicate anywhere in a WHERE. */
function seatPredicates(where: unknown): Record<string, unknown>[] {
  if (Array.isArray(where)) return where.flatMap(seatPredicates);
  if (!where || typeof where !== "object") return [];
  return Object.entries(where).flatMap(([key, value]) =>
    key === "participants" &&
    value &&
    typeof value === "object" &&
    "some" in value
      ? [value.some as Record<string, unknown>]
      : seatPredicates(value),
  );
}

const recordingFindMany = prisma.recording.findMany as jest.Mock;

describe("a former collaborator's participant row", () => {
  it.each([
    [
      "the personal appointments list",
      () => buildWhere({ scope: { kind: "personal" }, userId: "u-1" }),
    ],
    [
      "the documents and recordings access arms",
      () => buildUserAppointmentAccessOr("u-1"),
    ],
    ["a report's booking parties", () => bookingPartyWhere("u-1")],
    [
      "a suspended member's sessions",
      () => suspendedMemberAttendeeWhere("org-1"),
    ],
  ])("is no seat in %s", (_reader, build) => {
    const predicates = seatPredicates(build());
    expect(predicates.length).toBeGreaterThan(0);
    for (const predicate of predicates) {
      expect(predicate).toMatchObject({ role: { not: "COLLABORATOR" } });
    }
  });

  it("is no seat in the shared-recordings arm of the recordings list", async () => {
    recordingFindMany.mockResolvedValue([]);
    (prisma.recording.count as jest.Mock).mockResolvedValue(0);
    await listRecordingsScoped({
      scope: { kind: "personal" },
      userId: "u-1",
      page: 1,
      perPage: 10,
    });
    const predicates = seatPredicates(recordingFindMany.mock.calls[0][0].where);
    expect(predicates).toHaveLength(2);
    for (const predicate of predicates) {
      expect(predicate).toMatchObject({ role: { not: "COLLABORATOR" } });
    }
  });
});
