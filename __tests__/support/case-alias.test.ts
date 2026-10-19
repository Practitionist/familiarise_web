/** @jest-environment node */
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { supportCaseLegacyAlias: { findUnique: jest.fn() } },
}));
jest.mock("../../lib/observability/sentry-issues", () => ({
  findUserIssues: jest.fn(),
}));
import { resolveSupportCaseId } from "../../lib/support/case-workspace";
const alias = jest.requireMock<{
  default: { supportCaseLegacyAlias: { findUnique: jest.Mock } };
}>("../../lib/prisma").default.supportCaseLegacyAlias.findUnique;
beforeEach(() => jest.clearAllMocks());
it("resolves old ticket and conversation links through explicit aliases", async () => {
  alias.mockResolvedValue({ caseId: "unified-1" });
  expect(await resolveSupportCaseId({ kind: "ticket", id: "old-ticket" })).toBe(
    "unified-1",
  );
  expect(alias).toHaveBeenCalledWith({
    where: {
      legacyKind_legacyId: { legacyKind: "ticket", legacyId: "old-ticket" },
    },
    select: { caseId: true },
  });
  await resolveSupportCaseId({ kind: "thread", id: "old-thread" });
  expect(alias).toHaveBeenLastCalledWith({
    where: {
      legacyKind_legacyId: { legacyKind: "thread", legacyId: "old-thread" },
    },
    select: { caseId: true },
  });
});
it("does not create cases for booking links or guess an unmapped legacy ID", async () => {
  expect(
    await resolveSupportCaseId({ kind: "booking", id: "booking-1" }),
  ).toBeNull();
  expect(alias).not.toHaveBeenCalled();
  alias.mockResolvedValue(null);
  expect(
    await resolveSupportCaseId({ kind: "ticket", id: "old-ticket" }),
  ).toBeNull();
  expect(await resolveSupportCaseId({ kind: "case", id: "canonical" })).toBe(
    "canonical",
  );
});
