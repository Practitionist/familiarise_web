/**
 * Home's pending-requests card drops a checkout the learner is paying for and
 * nothing else: a row whose payload carries no `checkoutHold` key at all (an
 * older cached payload) is still a request waiting on the expert.
 */
jest.mock("next/navigation", () => ({ useParams: () => ({}) }));
jest.mock("../../lib/auth-client", () => ({
  useSession: () => ({ data: null }),
}));

import { homePreviewRows } from "../../components/dashboard/shared/requests/RequestsInboxPreview";

describe("homePreviewRows", () => {
  it("keeps a row without the checkoutHold key and drops a held checkout", () => {
    const rows = [
      { id: "no-key" },
      { id: "null-hold", checkoutHold: null },
      { id: "paying", checkoutHold: { expiresAt: "2026-09-24T08:45:00.000Z" } },
    ];
    expect(homePreviewRows(rows).map((row) => row.id)).toEqual([
      "no-key",
      "null-hold",
    ]);
  });

  it("shows at most five", () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({
      id: `r${i}`,
      checkoutHold: null,
    }));
    expect(homePreviewRows(rows)).toHaveLength(5);
  });
});
