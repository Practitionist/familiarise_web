/**
 * A draft invoice's generation row reaches only a role that manages billing,
 * on every org audit reader; issued-invoice rows stay under the audit grants.
 */
import { randomUUID } from "node:crypto";
import type { MemberRole } from "@prisma/client";
import { NextRequest } from "next/server";

import prisma from "../../lib/prisma";
import { getOrgActivityFeed } from "../../lib/data/org-activity";
import { AUDIT_ACTIONS } from "../../lib/enterprise/audit-actions";
import { GET as getAudit } from "../../app/api/organizations/[orgId]/audit/route";
import { GET as exportAudit } from "../../app/api/organizations/[orgId]/audit/export/route";
import { GET as getActivity } from "../../app/api/organizations/[orgId]/activity/route";

let mockRole: MemberRole = "MAINTAINER";
jest.mock("../../lib/auth-helpers", () => ({
  requireOrgAccess: jest.fn(async () => ({
    session: { user: { id: "u-1", timezone: "Asia/Kolkata" } },
    member: { id: "m-1", role: mockRole },
    org: { id: "org" },
  })),
}));

const { INVOICE } = AUDIT_ACTIONS;
let orgId = "";
const marker = randomUUID().slice(0, 8);
const DRAFT = `INV-DRAFT-${marker}`;
const VISIBLE = [
  `INV-ISSUED-${marker}`,
  `INV-LATER-${marker}`,
  `INV-PAID-${marker}`,
];

beforeAll(async () => {
  const id = randomUUID();
  orgId = (
    await prisma.organization.create({
      data: { name: `Org ${id.slice(0, 6)}`, slug: `org-${id}` },
    })
  ).id;
  const row = (action: string, number: string, status: string | null) => ({
    organizationId: orgId,
    category: "INVOICE" as const,
    action,
    description: `Invoice ${number}`,
    details: status
      ? { invoiceId: number, invoiceNumber: number, totalPaise: 1, status }
      : undefined,
  });
  await prisma.orgAuditLog.createMany({
    data: [
      row(INVOICE.INVOICE_GENERATED, DRAFT, "DRAFT"),
      row(INVOICE.INVOICE_GENERATED, VISIBLE[0], "ISSUED"),
      row(INVOICE.INVOICE_ISSUED, VISIBLE[1], "ISSUED"),
      // A money row without details stays visible to every money reader.
      row(INVOICE.INVOICE_PAID, VISIBLE[2], null),
    ],
  });
});

const req = () => new NextRequest("http://localhost/x?limit=100");
const params = () => ({ params: Promise.resolve({ orgId }) });

const READERS: Record<string, () => Promise<string>> = {
  "the Audit page": async () =>
    JSON.stringify(await (await getAudit(req(), params())).json()),
  "the audit CSV": async () => (await exportAudit(req(), params())).text(),
  "the Activity route": async () =>
    JSON.stringify(await (await getActivity(req(), params())).json()),
  "Home Activity": async () =>
    JSON.stringify(
      await getOrgActivityFeed(orgId, mockRole, "Asia/Kolkata", 50),
    ),
};

describe.each<[string, MemberRole, boolean]>([
  ["the Audit page", "MAINTAINER", false],
  ["the Audit page", "BILLING_ADMIN", true],
  ["the audit CSV", "MAINTAINER", false],
  ["the audit CSV", "OWNER", true],
  ["the Activity route", "MAINTAINER", false],
  ["the Activity route", "OWNER", true],
  ["Home Activity", "MAINTAINER", false],
  ["Home Activity", "OWNER", true],
])("%s for a %s", (reader, role, seesDraft) => {
  it(`${seesDraft ? "shows" : "hides"} the draft row and shows the issued rows`, async () => {
    mockRole = role;
    const out = await READERS[reader]();
    expect(out.includes(DRAFT)).toBe(seesDraft);
    for (const number of VISIBLE) expect(out).toContain(number);
  });
});
