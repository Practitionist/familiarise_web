/**
 * @jest-environment node
 */

/**
 * #1704 item 5 / #1717 triage #14 — a PUT `planId` may only move a request
 * to a plan of the same consultant AND the same funding org. The org is what
 * `bookingOrgId` derives (plan first, then appointment), and null (personal)
 * only swaps for null.
 */

import { refusePlanNotOwned } from "@/lib/booking/request-route-guards";

const request: { consultantProfileId: string; organizationId: string | null } =
  { consultantProfileId: "cp-1", organizationId: null };

async function verdict(
  plan: { consultantProfileId: string; organizationId: string | null } | null,
  req = request,
) {
  const res = await refusePlanNotOwned("plan-x", req, async () => plan);
  if (!res) return { status: 200, code: null };
  const body = await res.json();
  return { status: res.status, code: body.code };
}

describe("refusePlanNotOwned", () => {
  it("passes same consultant + same org, refuses an org change or another consultant", async () => {
    await expect(
      verdict({ consultantProfileId: "cp-1", organizationId: null }),
    ).resolves.toEqual({ status: 200, code: null });
    await expect(
      verdict(
        { consultantProfileId: "cp-1", organizationId: "org-a" },
        { consultantProfileId: "cp-1", organizationId: "org-a" },
      ),
    ).resolves.toEqual({ status: 200, code: null });
    await expect(
      verdict({ consultantProfileId: "cp-1", organizationId: "org-a" }),
    ).resolves.toEqual({ status: 403, code: "PLAN_ORG_MISMATCH" });
    await expect(
      verdict({ consultantProfileId: "cp-2", organizationId: null }),
    ).resolves.toEqual({ status: 403, code: "PLAN_NOT_OWNED" });
    await expect(verdict(null)).resolves.toEqual({
      status: 403,
      code: "PLAN_NOT_OWNED",
    });
    // No planId: nothing to check.
    await expect(
      refusePlanNotOwned(undefined, request, async () => null),
    ).resolves.toBeNull();
  });
});
