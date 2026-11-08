/**
 * @jest-environment node
 */

import {
  FIRST_RUN_PROFILE_SELECT,
  readFirstRunSteps,
  type FirstRunRow,
} from "@/lib/data/consultant-first-run";
import {
  eventPlanDiscoverableWhere,
  oneOnOnePlanDiscoverableWhere,
} from "@/lib/api/plans/visibility";

const row = (patch: Partial<FirstRunRow> = {}): FirstRunRow => ({
  description: "A".repeat(40),
  headline: "Senior engineer and mentor",
  experience: 8,
  verificationStatus: "VERIFIED",
  scheduleType: "WEEKLY",
  taxInfo: {
    panLast4: "1234",
    gstin: null,
    taxEntityType: "INDIVIDUAL",
    isIndianResident: true,
  },
  payoutAccounts: [{ isVerified: true }],
  _count: {
    subDomains: 1,
    tags: 0,
    availabilityWindowsWeekly: 3,
    availabilityWindowsCustom: 0,
    consultationPlans: 1,
    subscriptionPlans: 0,
    webinarPlans: 0,
    classPlans: 0,
    digitalProducts: 0,
  },
  user: {
    image: "x.png",
    profileDisplayImage: null,
    _count: { workExperiences: 1 },
  },
  ...patch,
});

const open = (r: FirstRunRow) =>
  (readFirstRunSteps(r, "c1") ?? []).filter((s) => !s.done).map((s) => s.key);

const counts = (
  patch: Partial<FirstRunRow["_count"]>,
): FirstRunRow["_count"] => ({
  ...row()._count,
  ...patch,
});

describe("readFirstRunSteps", () => {
  it("returns null once every step is done", () => {
    expect(readFirstRunSteps(row(), "c1")).toBeNull();
  });

  it("opens the offering step when no discoverable plan or product exists", () => {
    expect(open(row({ _count: counts({ consultationPlans: 0 }) }))).toEqual([
      "offering",
    ]);
  });

  it("counts a published digital product as the first offering", () => {
    const r = row({
      _count: counts({ consultationPlans: 0, digitalProducts: 1 }),
      verificationStatus: "PENDING_VERIFICATION",
    });
    expect(open(r)).toEqual(["verify"]);
  });

  it("reads the availability rows of the live schedule type only", () => {
    const weeklyOnly = counts({
      availabilityWindowsWeekly: 2,
      availabilityWindowsCustom: 0,
    });
    expect(open(row({ scheduleType: "WEEKLY", _count: weeklyOnly }))).toEqual(
      [],
    );
    expect(open(row({ scheduleType: "CUSTOM", _count: weeklyOnly }))).toEqual([
      "hours",
    ]);
  });

  it("keeps the payout step open without a default account", () => {
    expect(open(row({ payoutAccounts: [] }))).toEqual(["payout"]);
  });

  it("treats a profile without tax info as an Indian resident missing PAN", () => {
    expect(open(row({ taxInfo: null }))).toEqual(["payout"]);
  });

  it("credits an image on either user column and any work experience", () => {
    const r = row({
      user: {
        image: null,
        profileDisplayImage: "p.png",
        _count: { workExperiences: 2 },
      },
    });
    expect(open(r)).toEqual([]);
  });
});

describe("FIRST_RUN_PROFILE_SELECT", () => {
  const c = FIRST_RUN_PROFILE_SELECT._count.select;

  it("counts only discoverable 1:1 and subscription plans, so a draft stays out", () => {
    expect(c.consultationPlans.where).toEqual(oneOnOnePlanDiscoverableWhere());
    expect(c.subscriptionPlans.where).toEqual(oneOnOnePlanDiscoverableWhere());
    expect(oneOnOnePlanDiscoverableWhere().status).toBe("PUBLISHED");
  });

  it("counts only discoverable webinar and class plans", () => {
    expect(c.webinarPlans.where).toEqual(eventPlanDiscoverableWhere());
    expect(c.classPlans.where).toEqual(eventPlanDiscoverableWhere());
  });

  it("counts only published digital products", () => {
    expect(c.digitalProducts.where).toEqual({ status: "PUBLISHED" });
  });

  it("reads only the default payout account", () => {
    expect(FIRST_RUN_PROFILE_SELECT.payoutAccounts.where).toEqual({
      isDefault: true,
    });
  });
});
