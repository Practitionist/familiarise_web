/**
 * Referral credits and Platform fees are two pages: credits, fee waivers,
 * held referrals and the program economics on `referrals.read`; the take-rate
 * schedules on `payments.read`, written on `payments.manage`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen } from "@testing-library/react";

const mockPageGate = jest.fn();
jest.mock("@/lib/auth-guard", () => ({
  requireBackofficePage: (...args: unknown[]) => mockPageGate(...args),
}));
jest.mock(
  "@/components/dashboard/backoffice/referrals/ReferralCreditsPageClient",
  () => ({ __esModule: true, default: () => <p>referral credits</p> }),
);
jest.mock(
  "@/components/dashboard/backoffice/fees/PlatformFeesPageClient",
  () => ({
    PlatformFeesPageClient: () => <p>platform fees</p>,
  }),
);

import ReferralCreditsPage from "@/app/dashboard/(backoffice)/[tree]/referral-credits/page";
import PlatformFeesPage from "@/app/dashboard/(backoffice)/[tree]/platform-fees/page";
import { hasBackofficePermission } from "@/lib/auth/backoffice-permissions";

const params = Promise.resolve({ tree: "staff" });
const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

beforeEach(() => mockPageGate.mockClear());

it("gates Referral credits on referrals.read", async () => {
  render(await ReferralCreditsPage({ params }));
  expect(mockPageGate).toHaveBeenCalledWith("referrals.read", "staff");
  expect(screen.getByText("referral credits")).toBeTruthy();
});

it("gates Platform fees on payments.read, which STAFF hold and only ADMIN writes", async () => {
  render(await PlatformFeesPage({ params }));
  expect(mockPageGate).toHaveBeenCalledWith("payments.read", "staff");
  expect(hasBackofficePermission("STAFF", "payments.read")).toBe(true);
  expect(hasBackofficePermission("STAFF", "payments.manage")).toBe(false);
  expect(hasBackofficePermission("ADMIN", "payments.manage")).toBe(true);
});

it("keeps fee waivers on Referral credits and the fee schedules on Platform fees only", () => {
  const referrals = read(
    "components/dashboard/backoffice/referrals/ReferralCreditsPageClient.tsx",
  );
  const fees = read(
    "components/dashboard/backoffice/fees/PlatformFeesPageClient.tsx",
  );
  expect(referrals).toContain("/api/admin/referrals/waivers");
  expect(referrals).not.toContain("/api/admin/fee-schedules");
  expect(fees).toContain("/api/admin/fee-schedules");
  expect(fees).toContain('can("payments.manage")');
});

it("lists Platform fees in the back-office nav on payments.read", () => {
  const nav = read("lib/dashboard/backoffice-nav.ts");
  expect(nav).toMatch(
    /name: "Platform fees",\s+icon: Percent,\s+path: "platform-fees",\s+surface: "payments.read"/,
  );
});
