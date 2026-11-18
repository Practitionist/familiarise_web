/**
 * @jest-environment node
 */

/**
 * Every org audit reader prints rows in words: names for ids, rupees for paise,
 * viewer-zone dates for timestamps and labels for enum codes, for rows written
 * before the writers used prose as well as for current ones.
 */

const ORG = "org-wipro";
const MEMBER_A = "3a3ed839-6cc2-4117-a63a-d4ffe954a284";
const MEMBER_B = "71580fce-2672-4e88-95e0-3258bb75170b";
const CONTRACT = "af7844b6-4d8d-4b45-9e58-35f28e19f361";
const PROGRAM = "90dbcbd0-553a-43d6-a225-2800cc5c7cdb";
const SEAT = "4b2b90f1-d5c7-4ddd-b83a-bfc192f11668";
const INVOICE_PAID = "02c5e4ca-5f1c-429a-b90e-30f30949de4a";
const INVOICE_VOID = "42515ad7-7a00-4406-abaf-efc3944dfec6";

const at = new Date("2026-11-01T10:00:00Z");
const row = (
  id: string,
  category: string,
  action: string,
  description: string,
  details: unknown,
  targetMembershipId: string | null = null,
) => ({
  id,
  organizationId: ORG,
  actorMembershipId: null,
  targetMembershipId,
  category,
  action,
  description,
  details,
  createdAt: at,
});

/** Stored rows as the shared database holds them. */
const AUDIT_ROWS = [
  row(
    "r1",
    "CONSENT",
    "CONSENT_GRANTED",
    `Consent granted for member ${MEMBER_A}`,
    { membershipId: MEMBER_A, version: 1 },
    MEMBER_A,
  ),
  row(
    "r2",
    "CONTRACT",
    "CONTRACT_EXPIRED",
    `Contract ${CONTRACT} auto-expired (effectiveTo=2026-10-19T20:08:36.260Z)`,
    { contractId: CONTRACT, effectiveTo: "2026-10-19T20:08:36.260Z" },
  ),
  row(
    "r3",
    "PROGRAM",
    "ASSIGNMENT_CLOSED_BY_CONTRACT",
    `Seat ${SEAT} closed: contract ${CONTRACT} expired`,
    {
      programId: PROGRAM,
      contractId: CONTRACT,
      assignmentId: SEAT,
      membershipId: MEMBER_B,
      contractStatus: "EXPIRED",
    },
  ),
  row(
    "r4",
    "INVOICE",
    "INVOICE_RECEIPT_RECORDED",
    "Bank transfer QA2240UTR2 of 70800 paise recorded against invoice WIPRO-2026-0005",
    { utr: "QA2240UTR2", invoiceId: INVOICE_PAID, amountPaise: 70800 },
  ),
  row(
    "r5",
    "INVOICE",
    "INVOICE_VOIDED",
    "Invoice WIPRO-2026-0007: ISSUED → VOID (FORGIVE)",
    { to: "VOID", from: "ISSUED", mode: "FORGIVE", invoiceId: INVOICE_VOID },
  ),
  row("r6", "INVOICE", "BILLING_ACCOUNT_UPDATED", "BillingAccount updated", {
    from: {
      currency: "INR",
      creditLimit: 1030000000,
      fundingSource: "INVOICE",
      minBalancePaise: null,
    },
    to: {
      currency: "INR",
      creditLimit: 1000000000,
      fundingSource: "INVOICE",
      minBalancePaise: null,
    },
  }),
  row("r7", "SETTINGS", "SETTINGS_CHANGED", "Organization record updated", {
    patch: { expectedVersion: 9, streamRecordingRetentionDays: null },
  }),
  row("r8", "MEMBER", "ROLE_CHANGE", "Role: Manager → Billing admin", {
    from: { role: "MANAGER" },
    to: { role: "BILLING_ADMIN" },
  }),
];

const EXPECTED = [
  "Consent granted for Aarav Anderson",
  "The contract starting 1 Oct 2026 expired on 20 Oct 2026",
  `Ravi Kumar's seat on program "Engineer Leadership" closed: the contract expired`,
  "Bank transfer QA2240UTR2 of ₹708.00 recorded against invoice WIPRO-2026-0005",
  "Invoice WIPRO-2026-0007 for ₹1,180.00 voided and written off",
  "Billing settings changed: credit limit ₹1,03,00,000.00 → ₹1,00,00,000.00",
  "Organisation settings changed: recording retention",
  "Role: Manager → Billing admin",
];

const RAW = [
  /[0-9a-f]{8}-[0-9a-f]{4}-/,
  /\d{4}-\d{2}-\d{2}T/,
  /\bpaise\b/,
  /\b[A-Z]{2,}_[A-Z]+\b/,
  /\b(ISSUED|VOID|FORGIVE|EXPIRED)\b/,
  /BillingAccount|Organization record/,
];

type Where = { where?: Record<string, unknown> };
const idsIn = (args: Where): string[] => {
  const id = args.where?.id;
  if (id && typeof id === "object" && "in" in id && Array.isArray(id.in)) {
    return id.in.filter((v): v is string => typeof v === "string");
  }
  return [];
};

const PEOPLE = new Map([
  [MEMBER_A, "Aarav Anderson"],
  [MEMBER_B, "Ravi Kumar"],
]);

const mockAuditFindMany = jest.fn(async (_args: unknown) => AUDIT_ROWS);

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    orgAuditLog: { findMany: (args: unknown) => mockAuditFindMany(args) },
    membership: {
      findMany: async (args: Where) => {
        if (args.where?.role === "OWNER") {
          return [
            {
              organizationId: ORG,
              organization: { id: ORG, name: "Wipro Limited", slug: "wipro" },
            },
          ];
        }
        return idsIn(args)
          .filter((id) => PEOPLE.has(id))
          .map((id) => ({
            id,
            role: "LEARNER",
            user: { name: PEOPLE.get(id), email: `${id}@x.test` },
          }));
      },
    },
    contract: {
      findMany: async (args: Where) =>
        idsIn(args).includes(CONTRACT)
          ? [{ id: CONTRACT, effectiveFrom: new Date("2026-10-01T00:00:00Z") }]
          : [],
    },
    program: {
      findMany: async (args: Where) =>
        idsIn(args).includes(PROGRAM)
          ? [
              {
                id: PROGRAM,
                name: "Engineer Leadership",
                type: "LICENSED_SEAT",
              },
            ]
          : [],
    },
    organizationInvoice: {
      findMany: async (args: Where) =>
        [
          {
            id: INVOICE_PAID,
            invoiceNumber: "WIPRO-2026-0005",
            totalPaise: BigInt(118000),
          },
          {
            id: INVOICE_VOID,
            invoiceNumber: "WIPRO-2026-0007",
            totalPaise: BigInt(118000),
          },
        ].filter((i) => idsIn(args).includes(i.id)),
    },
  },
}));

const access = {
  session: { user: { id: "u-owner", timezone: "Asia/Kolkata" } },
  member: { id: "m-owner", role: "OWNER" },
  org: { id: ORG },
};
jest.mock("../../lib/auth-helpers", () => ({
  requireOrgAccess: async () => access,
}));

import { NextRequest } from "next/server";
import { getWorkspaceActivity } from "../../lib/data/org-workspace";
import { getOrgActivityFeed } from "../../lib/data/org-activity";
import { GET as auditGET } from "../../app/api/organizations/[orgId]/audit/route";
import { GET as activityGET } from "../../app/api/organizations/[orgId]/activity/route";

const params = { params: Promise.resolve({ orgId: ORG }) };

/** Every raw shape a stored description can carry that a printed one must not. */
const rawCodesIn = (descriptions: string[]) =>
  descriptions.flatMap((text) =>
    RAW.filter((raw) => raw.test(text)).map((raw) => `${raw}: ${text}`),
  );

describe("org audit readers describe rows in words", () => {
  it("workspace Activity", async () => {
    const page = await getWorkspaceActivity("u-owner", "Asia/Kolkata", null);
    const printed = page.data.map((r) => r.description);
    expect(printed).toEqual(EXPECTED);
    expect(rawCodesIn(printed)).toEqual([]);
  });

  it("operator Audit page", async () => {
    const res = await auditGET(
      new NextRequest(`http://x.test/api/organizations/${ORG}/audit`),
      params,
    );
    const body = (await res.json()) as { rows: { description: string }[] };
    const printed = body.rows.map((r) => r.description);
    expect(printed).toEqual(EXPECTED);
    expect(rawCodesIn(printed)).toEqual([]);
  });

  it("operator Home activity, SSR seed and client fetch alike", async () => {
    const seeded = await getOrgActivityFeed(ORG, "OWNER", "Asia/Kolkata", 50);
    expect(seeded.map((r) => r.description)).toEqual(EXPECTED);

    const res = await activityGET(
      new NextRequest(`http://x.test/api/organizations/${ORG}/activity`),
      params,
    );
    const body = (await res.json()) as { data: { description: string }[] };
    const printed = body.data.map((r) => r.description);
    expect(printed).toEqual(EXPECTED);
    expect(rawCodesIn(printed)).toEqual([]);
  });

  it("prints dates in the viewer's zone", async () => {
    const page = await getWorkspaceActivity(
      "u-owner",
      "America/New_York",
      null,
    );
    expect(page.data[1]?.description).toBe(
      "The contract starting 30 Sep 2026 expired on 19 Oct 2026",
    );
  });
});
