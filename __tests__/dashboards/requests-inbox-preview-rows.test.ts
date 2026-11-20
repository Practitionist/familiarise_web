/**
 * Home's Requests card keeps the requests Home counts, five at most: a checkout
 * the learner is paying for is left out, and a row whose payload carries no
 * `checkoutHold` key at all (an older cached payload) is still listed.
 */
jest.mock("next/navigation", () => ({ useParams: () => ({}) }));
jest.mock("../../lib/auth-client", () => ({
  useSession: () => ({ data: null }),
}));

import {
  homePreviewRows,
  ownMoveWaitingLine,
} from "../../components/dashboard/shared/requests/RequestsInboxPreview";

const pending = (id: string) => ({
  id,
  kind: "consultation" as const,
  presentation: { request: { status: "PENDING" } },
  proposal: null,
});

describe("homePreviewRows", () => {
  it("keeps a row without the checkoutHold key and drops a held checkout", () => {
    const rows = [
      pending("no-key"),
      { ...pending("null-hold"), checkoutHold: null },
      {
        ...pending("paying"),
        checkoutHold: { expiresAt: "2026-09-24T08:45:00.000Z" },
      },
    ];
    expect(homePreviewRows(rows).map((row) => row.id)).toEqual([
      "no-key",
      "null-hold",
    ]);
  });

  it("shows at most five", () => {
    const rows = Array.from({ length: 7 }, (_, i) => pending(`r${i}`));
    expect(homePreviewRows(rows)).toHaveLength(5);
  });
});

describe("the expert's own open move", () => {
  const row = (initiatorRole: string, status = "PENDING_REVIEW") => ({
    requester: { name: "Charlotte" },
    proposal: { status, initiatorRole },
  });

  it("reads as waiting on the client, not as a request", () => {
    expect(ownMoveWaitingLine(row("CONSULTANT"))).toBe(
      "You proposed a new time · waiting on Charlotte",
    );
  });

  it("a learner's move or a closed proposal is not one", () => {
    expect(ownMoveWaitingLine(row("CONSULTEE"))).toBeNull();
    expect(ownMoveWaitingLine(row("CONSULTANT", "WITHDRAWN"))).toBeNull();
  });
});
