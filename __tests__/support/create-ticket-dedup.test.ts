/**
 * @jest-environment node
 */

/**
 * #support-hub — escalation replay-dedup scoping. A B2C (null-org) replay
 * must filter on organizationId: NULL explicitly; passing `?? undefined`
 * would omit the constraint and let a personal retry dedupe against an
 * organization case for the same issue type.
 *
 * The dedup read now runs against the canonical SupportCase table: a replay
 * matches an open (unsettled, undeleted) case the same requester filed for
 * the same issue type in the same organization scope.
 */

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    supportCase: { findFirst: jest.fn(async () => null) },
  },
}));

import prisma from "../../lib/prisma";
import { findRecentOpenEscalation } from "../../lib/support/create-ticket";

const mockedFind = prisma.supportCase.findFirst as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockedFind.mockClear();
});

describe("findRecentOpenEscalation", () => {
  it("filters organizationId: null for B2C replays (not an omitted filter)", async () => {
    await findRecentOpenEscalation("u1", "BILLING_QUESTION", null);
    expect(mockedFind).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: null }),
      }),
    );
  });

  it("scopes org replays to the attributed organization", async () => {
    await findRecentOpenEscalation("u1", "BILLING_QUESTION", "org-1");
    expect(mockedFind).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: "org-1",
          status: { in: ["OPEN", "IN_PROGRESS", "ESCALATED", "ON_HOLD"] },
        }),
      }),
    );
  });

  it("matches only the same requester's live cases for the same issue type", async () => {
    await findRecentOpenEscalation("u1", "BILLING_QUESTION", null);
    expect(mockedFind).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          requesterUserId: "u1",
          submitterUserId: "u1",
          issueType: "BILLING_QUESTION",
          deletedAt: null,
        }),
      }),
    );
  });
});
