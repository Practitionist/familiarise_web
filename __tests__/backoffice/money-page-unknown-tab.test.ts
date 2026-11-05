/**
 * An unknown money section (a retired one such as class-series included)
 * 404s; a known section outside the viewer's surfaces lands on their first.
 */

const mockNotFound = jest.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});
const mockRedirect = jest.fn((href: string) => {
  throw new Error(`NEXT_REDIRECT ${href}`);
});
jest.mock("next/navigation", () => ({
  notFound: () => mockNotFound(),
  redirect: (href: string) => mockRedirect(href),
}));
let mockRole = "ADMIN";
jest.mock("@/lib/auth-guard", () => ({
  requireUserRole: async () => ({ user: { id: "op1", role: mockRole } }),
}));
jest.mock("@/components/dashboard/backoffice/money/MoneyTabBody", () => ({
  MoneyTabBody: () => null,
}));

import { renderMoneyTab } from "@/components/dashboard/backoffice/money/money-page";

describe("renderMoneyTab", () => {
  it.each(["class-series", "nope"])(
    "404s the unknown section %s",
    async (tab) => {
      mockRole = "ADMIN";
      await expect(
        renderMoneyTab({ tab, tree: "admin", searchParams: {} }),
      ).rejects.toThrow("NEXT_NOT_FOUND");
      expect(mockRedirect).not.toHaveBeenCalled();
    },
  );

  it("sends staff on an admin-only section to their first section", async () => {
    mockRole = "STAFF";
    await expect(
      renderMoneyTab({ tab: "earnings", tree: "staff", searchParams: {} }),
    ).rejects.toThrow("NEXT_REDIRECT /dashboard/staff/money/payments");
  });

  it("renders a section the viewer holds", async () => {
    mockRole = "ADMIN";
    await expect(
      renderMoneyTab({ tab: "payments", tree: "admin", searchParams: {} }),
    ).resolves.toBeTruthy();
  });
});
