/**
 * @jest-environment node
 */

/**
 * Profiles group: the public consultant GET, the owner PUT and the onboarding
 * result hand back only the projected keys.
 */

jest.mock("server-only", () => ({}));
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/verification/notify-admins", () => ({
  attemptBellsAfterResponse: jest.fn(),
}));
jest.mock("../../lib/verification/submit-request", () => ({
  submitVerificationRequest: jest.fn(),
}));
jest.mock("../../lib/profiles/profile-completion", () => ({
  recomputeProfileCompletion: jest.fn(),
}));
jest.mock("../../lib/compliance/dpdp", () => ({
  ensureConsentPurposes: jest.fn(),
}));

const tx = {
  user: { updateMany: jest.fn(), update: jest.fn() },
  consulteeProfile: { upsert: jest.fn() },
};
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn(),
    user: { findUnique: jest.fn() },
    consultantProfile: { findFirst: jest.fn() },
  },
}));

import {
  allKeys,
  consultantProfileValues,
  isBare,
  readSource as read,
} from "../fixtures/consultant-projection";
import { NextRequest } from "next/server";
import prisma from "../../lib/prisma";
import { GET } from "../../app/api/profiles/consultant/route";
import { processOnboardingData } from "../../utils/onboarding-server";
import {
  CONSULTANT_PII_FIELDS,
  consultantPublicScalars,
} from "../../lib/data/consultant-public";

const db = prisma as unknown as {
  $transaction: jest.Mock;
  user: { findUnique: jest.Mock };
  consultantProfile: { findFirst: jest.Mock };
};

const publicRequest = () =>
  new NextRequest("http://localhost/api/profiles/consultant?userId=u-1");

describe("GET /api/profiles/consultant", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("selects the public scalars and a user of id, name, image only", async () => {
    db.consultantProfile.findFirst.mockResolvedValue({
      id: "cp-1",
      userId: "u-1",
      user: { id: "u-1", name: "Ada", image: null },
    });
    const res = await GET(publicRequest());
    expect(res.status).toBe(200);

    const args = db.consultantProfile.findFirst.mock.calls[0][0];
    expect(args.select.user).toEqual({
      select: { id: true, name: true, image: true },
    });
    for (const key of Object.keys(consultantPublicScalars)) {
      expect(args.select).toHaveProperty(key, true);
    }
    expect(consultantProfileValues(args).filter(isBare)).toEqual([]);
    const selectedPii = CONSULTANT_PII_FIELDS.filter((f) =>
      allKeys(args.select).includes(f),
    );
    expect(selectedPii).toEqual([]);
  });

  it("returns the row keys unchanged when clean", async () => {
    db.consultantProfile.findFirst.mockResolvedValue({
      id: "cp-1",
      userId: "u-1",
      headline: "Coach",
      user: { id: "u-1", name: "Ada", image: null },
    });
    const body = await (await GET(publicRequest())).json();
    expect(Object.keys(body).sort()).toEqual(["data", "success"]);
    expect(Object.keys(body.data).sort()).toEqual([
      "headline",
      "id",
      "user",
      "userId",
    ]);
    expect(Object.keys(body.data.user).sort()).toEqual(["id", "image", "name"]);
  });

  it("fails closed when a sensitive column reaches the handler", async () => {
    db.consultantProfile.findFirst.mockResolvedValue({
      id: "cp-1",
      userId: "u-1",
      panNumber: "ABCDE1234F",
      user: { id: "u-1", name: "Ada", image: null },
    });
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await GET(publicRequest());
    const text = await res.text();
    expect(res.status).toBe(500);
    expect(text).not.toContain("ABCDE1234F");
    expect(JSON.parse(text)).not.toHaveProperty("data");
  });
});

describe("processOnboardingData result", () => {
  const consulteeBody = {
    role: "CONSULTEE",
    name: "Ada Lovelace",
    email: "ada@example.com",
    dateOfBirth: "1990-06-15",
    consulteeProfile: { create: {} },
    termsAccepted: true,
    privacyAccepted: true,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    db.$transaction.mockImplementation(async (fn: (t: typeof tx) => unknown) =>
      fn(tx),
    );
    db.user.findUnique.mockResolvedValue({ id: "user-1" });
    tx.user.updateMany.mockResolvedValue({ count: 1 });
    tx.consulteeProfile.upsert.mockResolvedValue({ id: "cee_1" });
    tx.user.update.mockResolvedValue({
      id: "user-1",
      email: "ada@example.com",
      phone: "+910000000000",
      role: "CONSULTEE",
      consultantProfileId: "cp_1",
      consulteeProfileId: "cee_1",
      consultantProfile: { id: "cp_1" },
    });
  });

  it("hands the browser exactly the id and the two profile ids", async () => {
    const result = await processOnboardingData("user-1", consulteeBody);
    expect(result.success).toBe(true);
    expect(result.user).toEqual({
      id: "user-1",
      consultantProfileId: "cp_1",
      consulteeProfileId: "cee_1",
    });
    expect(Object.keys(result.user ?? {}).sort()).toEqual([
      "consultantProfileId",
      "consulteeProfileId",
      "id",
    ]);
  });

  it("reads the consultant profile through an id-only select", async () => {
    await processOnboardingData("user-1", consulteeBody);
    const args = tx.user.update.mock.calls[0][0];
    expect(args.include.consultantProfile).toEqual({ select: { id: true } });
  });
});

describe("profile sources use explicit projections", () => {
  const files = [
    "app/api/profiles/consultant/route.ts",
    "app/api/user/consultants/[id]/route.ts",
    "utils/onboarding-server.ts",
  ];

  it.each(files)("%s has no bare consultantProfile fetch", (rel) => {
    const src = read(rel);
    expect(src).not.toMatch(/consultantProfile:\s*true/);
    expect(src).not.toMatch(/consultantProfile:\s*\{\s*include/);
    expect(src).not.toMatch(/consultantProfile:\s*\{[^}]*user:\s*true/);
  });

  it("the public route spreads consultantPublicScalars and selects no email", () => {
    const src = read("app/api/profiles/consultant/route.ts");
    expect(src).toContain("...consultantPublicScalars");
    expect(src).toContain("consultantPublicApiSchema.parse(");
    const start = src.indexOf("user: {");
    const end = src.indexOf("domain:", start);
    const userSelect = src.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(userSelect).not.toMatch(/\bemail\b/);
    expect(userSelect).toMatch(/id: true,\s*name: true,\s*image: true/);
  });

  it("the owner PUT returns only the id and uncoveredUpcoming", () => {
    const src = read("app/api/user/consultants/[id]/route.ts");
    const put = src.slice(
      src.indexOf("export async function PUT("),
      src.indexOf("export async function PATCH("),
    );
    expect(put).toContain(
      "NextResponse.json({ data: { id }, uncoveredUpcoming })",
    );
    expect(put).not.toMatch(/consultantPublicScalars/);
    expect(put.match(/consultantProfile\.findUnique\(/g)).toHaveLength(1);
  });

  it("onboarding maps the result user to the three keys", () => {
    const src = read("utils/onboarding-server.ts");
    const start = src.indexOf("function onboardingResultUser(");
    const body = src.slice(start, src.indexOf("\n}\n", start));
    expect(start).toBeGreaterThan(-1);
    expect(body.match(/:\s*user\./g)).toHaveLength(3);
    expect(body).toMatch(/consultantProfileId: user\.consultantProfileId/);
    expect(body).toMatch(/consulteeProfileId: user\.consulteeProfileId/);
  });

  it("consultantPublicScalars contains no statutory PII column", () => {
    const keys = allKeys(consultantPublicScalars);
    const leaked = CONSULTANT_PII_FIELDS.filter((f) => keys.includes(f));
    expect(leaked).toEqual([]);
  });
});
