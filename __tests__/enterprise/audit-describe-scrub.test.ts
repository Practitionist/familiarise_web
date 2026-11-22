/**
 * @jest-environment node
 */

// Invariant: a composed audit sentence takes the same engineering-text scrub as stored text.

jest.mock("@/lib/prisma", () => ({ __esModule: true, default: {} }));

import {
  describeAuditEntry,
  type AuditNameBook,
} from "@/lib/enterprise/audit-describe";

const emptyBook: AuditNameBook = {
  members: new Map(),
  users: new Map(),
  contracts: new Map(),
  programs: new Map(),
  invoices: new Map(),
};

const materialRow = (fileName: string) => ({
  organizationId: "org_1",
  action: "PLAN_MATERIAL_ADDED",
  description: "stored text",
  details: { fileName },
  targetMembershipId: null,
});

it("keeps a plain file name in the composed sentence", () => {
  expect(
    describeAuditEntry(materialRow("week-1 notes.pdf"), emptyBook, "UTC"),
  ).toBe('Plan material "week-1 notes.pdf" added');
});

it("scrubs a composed sentence whose typed name matches an engineering pattern", () => {
  const text = describeAuditEntry(
    materialRow("ProgramWhereInput dump.pdf"),
    emptyBook,
    "UTC",
  );
  expect(text).not.toContain("ProgramWhereInput");
  expect(text).toContain("[redacted");
});
