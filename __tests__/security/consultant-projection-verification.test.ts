/**
 * @jest-environment node
 */

/**
 * Verification group: the admin detail GET and the back-office queue reader
 * select an explicit consultantProfile projection, never a whole row.
 */

import { allKeys, readSource as read } from "../fixtures/consultant-projection";
import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { GET } from "../../app/api/admin/verification/[verificationId]/route";
import { getVerificationQueue } from "../../lib/api/operators/verification";
import {
  CONSULTANT_PII_FIELDS,
  consultantPublicScalars,
} from "../../lib/data/consultant-public";

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/auth-helpers", () => ({
  __esModule: true,
  requireBackofficeSurface: jest.fn(),
}));
jest.mock("../../lib/verification/review-route", () => ({
  __esModule: true,
  reviewVerificationDoor: jest.fn(),
  withDownloadUrls: <T>(docs: T[]) => docs,
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consultantProfileVerification: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      groupBy: jest.fn(),
    },
  },
}));

const verificationDb = (
  prisma as unknown as {
    consultantProfileVerification: {
      findUnique: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      groupBy: jest.Mock;
    };
  }
).consultantProfileVerification;
const mockedAuth = requireBackofficeSurface as unknown as jest.Mock;
const QUEUE_ARGS = {
  status: "PENDING" as const,
  paging: { page: 1, limit: 20, skip: 0 },
};

const user = {
  id: "u-1",
  name: "Ada",
  email: "ada@example.com",
  image: null,
  linkedinUrl: null,
  bio: null,
  workExperiences: [],
  certifications: [],
  education: [],
};

describe("GET /api/admin/verification/[verificationId]", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedAuth.mockResolvedValue({ session: { user: { id: "admin-1" } } });
    verificationDb.findUnique.mockResolvedValue({
      id: "v-1",
      status: "PENDING",
      consultantProfile: { id: "cp-1", userId: "u-1", user },
      documents: [],
    });
  });

  it("selects the public scalars plus nested user, domain and subDomains", async () => {
    const res = await GET(
      new NextRequest("http://localhost/api/admin/verification/v-1"),
      { params: Promise.resolve({ verificationId: "v-1" }) },
    );
    expect(res.status).toBe(200);

    const args = verificationDb.findUnique.mock.calls[0][0];
    const profile = args.include.consultantProfile;
    expect(profile).not.toHaveProperty("include");
    expect(profile.select).toEqual({
      ...consultantPublicScalars,
      user: expect.objectContaining({ select: expect.any(Object) }),
      domain: { select: { id: true, name: true } },
      subDomains: { select: { id: true, name: true } },
    });
    expect(
      CONSULTANT_PII_FIELDS.filter((f) => allKeys(profile).includes(f)),
    ).toEqual([]);
  });

  it("keeps each document's storage key on the server", async () => {
    await GET(new NextRequest("http://localhost/api/admin/verification/v-1"), {
      params: Promise.resolve({ verificationId: "v-1" }),
    });
    const args = verificationDb.findUnique.mock.calls[0][0];
    expect(args.include.documents.select).toMatchObject({ fileUrl: true });
    expect(args.include.documents.select).not.toHaveProperty("storagePath");
  });

  it("returns a verification object", async () => {
    const res = await GET(
      new NextRequest("http://localhost/api/admin/verification/v-1"),
      { params: Promise.resolve({ verificationId: "v-1" }) },
    );
    const body = await res.json();
    expect(Object.keys(body)).toEqual(["verification"]);
    expect(Object.keys(body.verification.consultantProfile).sort()).toEqual([
      "id",
      "user",
      "userId",
    ]);
  });
});

describe("getVerificationQueue", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    verificationDb.findMany.mockResolvedValue([
      {
        id: "v-1",
        status: "PENDING",
        submittedAt: new Date("2026-01-01T00:00:00.000Z"),
        notes: null,
        rejectionReason: null,
        feedbackDetails: null,
        reviewedAt: null,
        reviewedById: null,
        reviewNotes: null,
        documents: [],
        consultantProfile: {
          id: "cp-1",
          userId: "u-1",
          description: "d",
          experience: 3,
          headline: "h",
          user,
          domain: { id: "d-1", name: "Data" },
          subDomains: [],
        },
      },
    ]);
    verificationDb.count.mockResolvedValue(1);
    verificationDb.groupBy.mockResolvedValue([]);
  });

  it("reads exactly the review-modal columns from the profile", async () => {
    await getVerificationQueue(QUEUE_ARGS);
    const args = verificationDb.findMany.mock.calls[0][0];
    const profile = args.include.consultantProfile;
    expect(profile).not.toHaveProperty("include");
    expect(Object.keys(profile.select).sort()).toEqual([
      "description",
      "domain",
      "experience",
      "headline",
      "id",
      "subDomains",
      "user",
      "userId",
    ]);
    expect(profile.select.domain).toEqual({ select: { id: true, name: true } });
    expect(
      CONSULTANT_PII_FIELDS.filter((f) => allKeys(profile).includes(f)),
    ).toEqual([]);
  });

  it("flattens the row into the queue shape without profile columns", async () => {
    const result = await getVerificationQueue(QUEUE_ARGS);
    const [row] = result.verifications;
    expect(Object.keys(row.consultant).sort()).toEqual(
      [
        "bio",
        "certifications",
        "description",
        "domain",
        "education",
        "email",
        "experience",
        "headline",
        "image",
        "isVerified",
        "linkedinUrl",
        "name",
        "profileId",
        "subDomains",
        "userId",
        "verificationStatus",
        "workExperiences",
      ].sort(),
    );
  });
});

describe("verification sources use explicit projections", () => {
  const files = [
    "app/api/admin/verification/[verificationId]/route.ts",
    "lib/api/operators/verification.ts",
  ];

  it.each(files)("%s has no bare consultantProfile fetch", (rel) => {
    const src = read(rel);
    expect(src).not.toMatch(/consultantProfile:\s*true/);
    expect(src).not.toMatch(/consultantProfile:\s*\{\s*include/);
    expect(src).not.toMatch(/consultantProfile:\s*\{[^}]*user:\s*true/);
    expect(src).not.toMatch(/\buser:\s*true/);
    expect(src).toMatch(/consultantProfile:\s*\{\s*select:/);
  });

  it("the admin detail route spreads consultantPublicScalars", () => {
    const src = read("app/api/admin/verification/[verificationId]/route.ts");
    expect(src).toContain("...consultantPublicScalars");
    expect(src).toMatch(/domain:\s*\{\s*select:/);
    expect(src).toMatch(/subDomains:\s*\{\s*select:/);
  });

  it("the queue reader names its profile columns explicitly", () => {
    const src = read("lib/api/operators/verification.ts");
    const start = src.indexOf("consultantProfile: {");
    const block = src.slice(start, src.indexOf("user: {", start));
    for (const column of [
      "id: true",
      "userId: true",
      "description: true",
      "experience: true",
      "headline: true",
    ]) {
      expect(block).toContain(column);
    }
    expect(CONSULTANT_PII_FIELDS.filter((f) => block.includes(f))).toEqual([]);
  });

  it("consultantPublicScalars contains no statutory PII column", () => {
    const keys = allKeys(consultantPublicScalars);
    expect(CONSULTANT_PII_FIELDS.filter((f) => keys.includes(f))).toEqual([]);
  });
});
