/**
 * @jest-environment node
 */

/**
 * Cross-tenant child ids: an OWNER of org A who sends a child id that lives
 * in org B gets a 404 and nothing is written. The fake client models the
 * database: a query scoped to org A finds nothing, while an unscoped id
 * lookup finds org B's row — so a handler that reads or writes by id alone
 * either acts on the foreign row (a recorded write) or answers non-404.
 */

import { NextRequest } from "next/server";

jest.mock("../../lib/prisma", () => {
  const ORG_A = "org-A";
  const writes: Array<{ model: string; op: string; args: unknown }> = [];
  const scopedToA = (args: unknown) =>
    JSON.stringify(args ?? {}).includes(ORG_A);
  const foreignRow = () => ({
    id: "child-B",
    organizationId: "org-B",
    ownerOrgId: "org-B",
    userId: "user-B",
    status: "ACTIVE",
    role: "LEARNER",
    contract: { organizationId: "org-B" },
    endpoint: { organizationId: "org-B" },
    billingAccount: { ownerOrgId: "org-B" },
    createdAt: new Date(0),
    effectiveFrom: new Date(0),
  });
  const READS: Record<string, (args: unknown) => unknown> = {
    findUnique: (a) => (scopedToA(a) ? null : foreignRow()),
    findFirst: (a) => (scopedToA(a) ? null : foreignRow()),
    findMany: (a) => (scopedToA(a) ? [] : [foreignRow()]),
    count: () => 0,
    aggregate: () => ({ _sum: {}, _count: 0, _max: {}, _min: {} }),
    groupBy: () => [],
  };
  const model = (name: string) =>
    new Proxy(
      {},
      {
        get: (_t, op: string) => async (args: unknown) => {
          if (op === "findUniqueOrThrow" || op === "findFirstOrThrow") {
            if (scopedToA(args)) throw new Error("No record found");
            return foreignRow();
          }
          const read = READS[op];
          if (read) return read(args);
          if ((op === "updateMany" || op === "deleteMany") && scopedToA(args)) {
            return { count: 0 };
          }
          writes.push({ model: name, op, args });
          return op.endsWith("Many") ? { count: 1 } : foreignRow();
        },
      },
    );
  const client: Record<string, unknown> = new Proxy(
    {},
    {
      get: (_t, key: string) => {
        if (key === "__esModule") return true;
        if (key === "__writes") return writes;
        if (key === "$transaction") {
          return async (arg: unknown) =>
            typeof arg === "function"
              ? (arg as (tx: unknown) => unknown)(client)
              : Promise.all(arg as unknown[]);
        }
        if (key === "$queryRaw" || key === "$queryRawUnsafe") {
          return async () => [];
        }
        if (key === "$executeRaw" || key === "$executeRawUnsafe") {
          return async (...args: unknown[]) => {
            writes.push({ model: "$raw", op: key, args });
            return 1;
          };
        }
        if (key === "then") return undefined;
        return model(key);
      },
    },
  );
  return { __esModule: true, default: client, prisma: client };
});

jest.mock("../../lib/auth-helpers", () => ({
  requireOrgAccess: jest.fn(),
  requireBackofficeSurface: jest.fn(),
  requirePrivilegedAuth: jest.fn(),
  requireApiAuth: jest.fn(),
}));

jest.mock("../../lib/rate-limit", () => ({
  __esModule: true,
  applyRateLimit: jest.fn().mockResolvedValue(null),
}));

import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";

const ORG_A = "org-A";
const CHILD = "00000000-0000-4000-8000-0000000000b1";
const writes = (prisma as unknown as { __writes: unknown[] }).__writes;

// `never` params accept every route's own params shape without a cast per route.
type Handler = (
  req: NextRequest,
  ctx: { params: Promise<never> },
) => Promise<Response>;

const PARAMS = Object.fromEntries(
  [
    "memberId",
    "invitationId",
    "invoiceId",
    "poId",
    "contractId",
    "payoutId",
    "programId",
    "assignmentId",
    "cardId",
    "endpointId",
    "providerId",
    "exportId",
  ].map((k) => [k, CHILD]),
);

const CASES: Array<
  [name: string, load: () => Promise<Handler>, body?: unknown]
> = [
  [
    "members/[memberId] PATCH",
    async () =>
      (await import("@/app/api/organizations/[orgId]/members/[memberId]/route"))
        .PATCH,
    { departmentLabel: "Ops" },
  ],
  [
    "members/[memberId] DELETE",
    async () =>
      (await import("@/app/api/organizations/[orgId]/members/[memberId]/route"))
        .DELETE,
  ],
  [
    "invitations/[invitationId] DELETE",
    async () =>
      (
        await import("@/app/api/organizations/[orgId]/invitations/[invitationId]/route")
      ).DELETE,
  ],
  [
    "billing-account/invoices/[invoiceId] PATCH",
    async () =>
      (
        await import("@/app/api/organizations/[orgId]/billing-account/invoices/[invoiceId]/route")
      ).PATCH,
    { status: "VOID" },
  ],
  [
    "billing-account/purchase-orders/[poId] PATCH",
    async () =>
      (
        await import("@/app/api/organizations/[orgId]/billing-account/purchase-orders/[poId]/route")
      ).PATCH,
    { status: "CLOSED" },
  ],
  [
    "billing-account/purchase-orders/[poId] DELETE",
    async () =>
      (
        await import("@/app/api/organizations/[orgId]/billing-account/purchase-orders/[poId]/route")
      ).DELETE,
  ],
  [
    "contracts/[contractId] PATCH",
    async () =>
      (
        await import("@/app/api/organizations/[orgId]/contracts/[contractId]/route")
      ).PATCH,
    { autoRenew: true },
  ],
  [
    "payouts/[payoutId] PATCH",
    async () =>
      (await import("@/app/api/organizations/[orgId]/payouts/[payoutId]/route"))
        .PATCH,
    { notes: "x" },
  ],
  [
    "programs/[programId] PATCH",
    async () =>
      (
        await import("@/app/api/organizations/[orgId]/programs/[programId]/route")
      ).PATCH,
    { name: "Renamed" },
  ],
  [
    "programs/[programId] DELETE",
    async () =>
      (
        await import("@/app/api/organizations/[orgId]/programs/[programId]/route")
      ).DELETE,
  ],
  [
    "programs/[programId]/assignments/[assignmentId] PATCH",
    async () =>
      (
        await import("@/app/api/organizations/[orgId]/programs/[programId]/assignments/[assignmentId]/route")
      ).PATCH,
    { cancel: true },
  ],
  [
    "rate-cards/[cardId] PATCH",
    async () =>
      (
        await import("@/app/api/organizations/[orgId]/rate-cards/[cardId]/route")
      ).PATCH,
    { minGrossPaise: 1 },
  ],
  [
    "webhooks/[endpointId] PATCH",
    async () =>
      (
        await import("@/app/api/organizations/[orgId]/webhooks/[endpointId]/route")
      ).PATCH,
    { status: "PAUSED" },
  ],
  [
    "webhooks/[endpointId] DELETE",
    async () =>
      (
        await import("@/app/api/organizations/[orgId]/webhooks/[endpointId]/route")
      ).DELETE,
  ],
  [
    "sso/providers/[providerId] DELETE",
    async () =>
      (
        await import("@/app/api/organizations/[orgId]/sso/providers/[providerId]/route")
      ).DELETE,
  ],
  [
    "data-exports/[exportId]/download GET",
    async () =>
      (
        await import("@/app/api/organizations/[orgId]/data-exports/[exportId]/download/route")
      ).GET,
  ],
];

// Each case imports a fresh route graph on first use.
jest.setTimeout(120_000);

describe("an org-A OWNER cannot reach org B's child resources", () => {
  beforeEach(() => {
    writes.length = 0;
    (requireOrgAccess as jest.Mock).mockResolvedValue({
      session: {
        user: { id: "user-A", email: "owner@a.test", role: "USER" },
        session: { createdAt: new Date(), reauthenticatedAt: null },
      },
      member: {
        id: "member-A",
        userId: "user-A",
        organizationId: ORG_A,
        role: "OWNER",
        status: "ACTIVE",
      },
      org: {
        id: ORG_A,
        name: "Org A",
        slug: "org-a",
        status: "ACTIVE",
        canSponsor: true,
        canHost: true,
        billingAccount: { id: "ba-A", fundingSource: "INVOICE" },
      },
    });
  });

  // Three entries per row, so jest never reads a short row's third argument as `done`.
  const rows = CASES.map(
    ([name, load, body]) => [name, load, body ?? null] as const,
  );

  it.each(rows)("%s → 404, no writes", async (name, load, body) => {
    const handler = await load();
    const method = name.split(" ").pop() ?? "GET";
    const req = new NextRequest(
      `https://app.test/api/organizations/${ORG_A}/x`,
      {
        method,
        ...(body !== null && {
          body: JSON.stringify(body),
          headers: { "Content-Type": "application/json" },
        }),
      },
    );
    const res = await handler(req, {
      params: Promise.resolve({ orgId: ORG_A, ...PARAMS }) as Promise<never>,
    });
    expect(res.status).toBe(404);
    expect(writes).toEqual([]);
  });
});
