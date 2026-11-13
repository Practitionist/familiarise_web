/** @jest-environment node */
import type { PlanMaterial } from "@prisma/client";
import {
  handleUploadMaterial,
  type PlanMaterialsConfig,
} from "../../app/api/plans/shared/materials-handler";
import prisma from "../../lib/prisma";
import { verifyDirectUploadedObject } from "../../lib/documents/storage-verify";
import { deletePlanMaterial } from "../../lib/supabase";
import { requireOrgAccess } from "../../lib/auth-helpers";

const mockCreate = jest.fn();
let mockUserId: string | null;
let mockOwnerId: string;
let mockPlanExists: boolean;
let mockRows: PlanMaterial[];
let mockInTransaction: boolean;
let mockMaterialCount: number;
let mockPlanOrgId: string | null;
let mockActiveExpert: boolean;

function mockFindMaterial(query: { where: Record<string, unknown> }) {
  return (
    mockRows.find((row) =>
      Object.entries(query.where).every(([key, value]) =>
        Object.entries(row).some(
          ([field, stored]) => field === key && stored === value,
        ),
      ),
    ) ?? null
  );
}

jest.mock("../../lib/prisma", () => {
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    planMaterial: {
      findFirst: jest.fn(async (query: { where: Record<string, unknown> }) =>
        mockFindMaterial(query),
      ),
      count: jest.fn(async () => mockMaterialCount),
      aggregate: jest.fn(async () => ({ _max: { order: 0 } })),
      create: jest.fn(async (query: unknown) => mockCreate(query)),
    },
  };
  const plan = {
    findFirst: jest.fn(async ({ where }: { where: { id: string } }) =>
      mockPlanExists
        ? {
            id: where.id,
            consultantProfile: { id: "expert-profile", userId: mockOwnerId },
            organizationId: mockPlanOrgId,
          }
        : null,
    ),
  };
  return {
    __esModule: true,
    default: {
      consultationPlan: plan,
      subscriptionPlan: plan,
      webinarPlan: plan,
      classPlan: plan,
      planMaterial: {
        findFirst: jest.fn(
          async (query: { where: Record<string, unknown> }) => {
            if (mockInTransaction)
              throw new Error("Global DB read inside transaction");
            return mockFindMaterial(query);
          },
        ),
        count: jest.fn(async () => mockRows.length),
      },
      membership: { count: jest.fn(async () => (mockActiveExpert ? 1 : 0)) },
      $transaction: jest.fn(
        async (run: (client: typeof tx) => Promise<unknown>) => {
          mockInTransaction = true;
          try {
            return await run(tx);
          } finally {
            mockInTransaction = false;
          }
        },
      ),
    },
  };
});
jest.mock("../../lib/auth-server", () => ({
  getSession: jest.fn(async () =>
    mockUserId ? { user: { id: mockUserId } } : null,
  ),
}));
jest.mock("../../lib/auth-helpers", () => ({
  requireOrgAccess: jest
    .fn()
    .mockRejectedValue(new Error("Unexpected org access")),
}));
jest.mock("../../lib/rate-limit", () => ({
  applyRateLimit: jest.fn().mockResolvedValue(null),
  documentCommitLimiter: {},
  documentUploadLimiter: {},
}));
jest.mock("../../lib/documents/storage-verify", () => ({
  verifyDirectUploadedObject: jest.fn(),
}));
jest.mock("../../lib/supabase", () => ({
  deletePlanMaterial: jest.fn().mockResolvedValue(true),
}));
jest.mock("../../lib/supabase-storage-core", () => ({
  generateStorageFileName: jest.fn(),
  supabaseAdmin: {
    storage: {
      from: jest.fn(() => {
        throw new Error("Unexpected direct storage call");
      }),
    },
  },
}));
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));

const configs: PlanMaterialsConfig[] = [
  {
    planType: "consultation",
    planIdField: "consultationPlanId",
    planModel: "consultationPlan",
  },
  {
    planType: "subscription",
    planIdField: "subscriptionPlanId",
    planModel: "subscriptionPlan",
  },
  {
    planType: "webinar",
    planIdField: "webinarPlanId",
    planModel: "webinarPlan",
  },
  { planType: "class", planIdField: "classPlanId", planModel: "classPlan" },
];
const config = configs[0]!;
const storagePath = (type = config.planType, planId = "plan-1") =>
  `plans/${type}-plans/${planId}/upload.pdf`;
const body = (overrides: Record<string, unknown> = {}) => ({
  storagePath: storagePath(),
  originalName: "Handout.pdf",
  mimeType: "application/pdf",
  fileSize: 100,
  ...overrides,
});
function material(overrides: Partial<PlanMaterial> = {}): PlanMaterial {
  return {
    id: "material-1",
    fileName: "upload.pdf",
    originalName: "Handout.pdf",
    fileSize: 100,
    mimeType: "application/pdf",
    fileUrl: "/files/materials/material-1",
    storagePath: storagePath(),
    description: null,
    order: 0,
    consultationPlanId: "plan-1",
    subscriptionPlanId: null,
    webinarPlanId: null,
    classPlanId: null,
    organizationId: null,
    uploadedAt: new Date("2026-10-24T12:00:00Z"),
    updatedAt: new Date("2026-10-24T12:00:00Z"),
    ...overrides,
  };
}
async function commit(
  input: unknown = body(),
  target: PlanMaterialsConfig = config,
) {
  const response = await handleUploadMaterial(
    new Request("http://localhost/api/plans/materials", {
      method: "POST",
      body: JSON.stringify(input),
    }),
    "plan-1",
    target,
  );
  expect(globalThis.fetch).not.toHaveBeenCalled();
  return response;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUserId = "expert";
  mockOwnerId = "expert";
  mockPlanExists = true;
  mockRows = [];
  mockInTransaction = false;
  mockMaterialCount = 1;
  mockPlanOrgId = null;
  mockActiveExpert = false;
  mockCreate.mockResolvedValue(material());
  jest.mocked(verifyDirectUploadedObject).mockResolvedValue({
    ok: false,
    code: "STORAGE_UNAVAILABLE",
  });
  jest
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("Network denied"));
});
afterEach(() => {
  jest.restoreAllMocks();
});

it.each(configs)(
  "replays $planType material commits without storage or another transaction",
  async (target) => {
    mockRows = [
      material({
        consultationPlanId: null,
        [target.planIdField]: "plan-1",
        storagePath: storagePath(target.planType),
      }),
    ];
    const response = await commit(
      body({ storagePath: storagePath(target.planType) }),
      target,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { id: "material-1" } });
    expect(prisma.planMaterial.findFirst).toHaveBeenCalledWith({
      where: {
        [target.planIdField]: "plan-1",
        storagePath: storagePath(target.planType),
      },
      select: expect.any(Object),
    });
    expect(verifyDirectUploadedObject).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(deletePlanMaterial).not.toHaveBeenCalled();
  },
);

it("replays a committed object even when storage now reports it missing", async () => {
  mockRows = [material()];
  jest
    .mocked(verifyDirectUploadedObject)
    .mockResolvedValue({ ok: false, code: "STORAGE_MISSING" });
  expect((await commit()).status).toBe(200);
  expect(verifyDirectUploadedObject).not.toHaveBeenCalled();
});

it.each([
  ["signed out", null, "expert", true, 401],
  ["different owner", "outsider", "expert", true, 403],
  ["missing plan", "expert", "expert", false, 403],
])(
  "refuses %s before consulting committed material rows",
  async (_label, user, owner, exists, status) => {
    mockUserId = typeof user === "string" ? user : null;
    mockOwnerId = typeof owner === "string" ? owner : "expert";
    mockPlanExists = exists === true;
    mockRows = [material()];
    expect((await commit()).status).toBe(status);
    expect(prisma.planMaterial.findFirst).not.toHaveBeenCalled();
    expect(verifyDirectUploadedObject).not.toHaveBeenCalled();
  },
);

it.each([
  ["bad JSON shape", { originalName: "Handout.pdf" }, 400],
  ["empty file", body({ fileSize: 0 }), 400],
  ["oversized file", body({ fileSize: 11 * 1024 * 1024 }), 413],
  [
    "unsupported type",
    body({ mimeType: "text/html", originalName: "Handout.html" }),
    415,
  ],
])("validates %s before accepting a replay", async (_label, input, status) => {
  mockRows = [material()];
  expect((await commit(input)).status).toBe(status);
  expect(mockCreate).not.toHaveBeenCalled();
  expect(deletePlanMaterial).not.toHaveBeenCalled();
});

it.each([
  ["oversized", body({ fileSize: 11 * 1024 * 1024 }), 413],
  [
    "unsupported",
    body({ mimeType: "text/html", originalName: "Handout.html" }),
    415,
  ],
])(
  "preserves an unreferenced first upload refused as %s",
  async (_label, input, status) => {
    expect((await commit(input)).status).toBe(status);
    expect(deletePlanMaterial).not.toHaveBeenCalled();
    expect(verifyDirectUploadedObject).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  },
);

it("preserves an unreferenced upload when the replay lookup fails", async () => {
  jest
    .mocked(prisma.planMaterial.findFirst)
    .mockRejectedValueOnce(new Error("Database unavailable"));
  expect((await commit()).status).toBe(500);
  expect(deletePlanMaterial).not.toHaveBeenCalled();
  expect(verifyDirectUploadedObject).not.toHaveBeenCalled();
  expect(prisma.$transaction).not.toHaveBeenCalled();
});

it.each([
  ["different plan", { consultationPlanId: "plan-2" }],
  [
    "different plan type",
    { consultationPlanId: null, subscriptionPlanId: "plan-1" },
  ],
  ["different object", { storagePath: storagePath() + ".other" }],
])("does not replay a row for a %s", async (_label, fields) => {
  mockRows = [material(fields)];
  const response = await commit();
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: "STORAGE_UNAVAILABLE" });
  expect(verifyDirectUploadedObject).toHaveBeenCalledTimes(1);
  expect(prisma.$transaction).not.toHaveBeenCalled();
});

it("keeps verifying first attachments before entering a transaction", async () => {
  expect((await commit()).status).toBe(503);
  expect(verifyDirectUploadedObject).toHaveBeenCalledWith({
    bucket: "documents",
    storagePath: storagePath(),
    requiredPrefix: "plans/consultation-plans/plan-1/",
    claimedMimeType: "application/pdf",
  });
  expect(prisma.$transaction).not.toHaveBeenCalled();
});

it("creates a first attachment with verified storage metadata", async () => {
  jest.mocked(verifyDirectUploadedObject).mockResolvedValue({
    ok: true,
    fileName: "upload.pdf",
    fileSize: 99,
    mimeType: "application/pdf",
  });
  expect((await commit()).status).toBe(201);
  expect(mockCreate).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        storagePath: storagePath(),
        consultationPlanId: "plan-1",
        fileSize: 99,
      }),
    }),
  );
  expect(deletePlanMaterial).not.toHaveBeenCalled();
});

it("retains the locked replay check for a concurrent first commit", async () => {
  mockMaterialCount = 25;
  jest.mocked(verifyDirectUploadedObject).mockImplementation(async () => {
    mockRows = [material()];
    return {
      ok: true,
      fileName: "upload.pdf",
      fileSize: 100,
      mimeType: "application/pdf",
    };
  });
  const response = await commit();
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ data: { id: "material-1" } });
  expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  expect(mockCreate).not.toHaveBeenCalled();
  expect(deletePlanMaterial).not.toHaveBeenCalled();
});

it("refuses the expert of an organisation's plan once no longer an active member", async () => {
  mockPlanOrgId = "org-1";
  jest.mocked(requireOrgAccess).mockResolvedValueOnce({
    error: new Response(null, { status: 403 }),
  } as never);
  mockRows = [material()];
  expect((await commit()).status).toBe(403);
  expect(prisma.planMaterial.findFirst).not.toHaveBeenCalled();
});

it("lets an active expert member manage an organisation plan's materials", async () => {
  mockPlanOrgId = "org-1";
  mockActiveExpert = true;
  mockRows = [material()];
  expect((await commit()).status).toBe(200);
  expect(requireOrgAccess).not.toHaveBeenCalled();
});
