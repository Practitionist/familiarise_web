import {
  ContractStatus,
  ContractSupersessionReason,
  OrgInvoiceStatus,
  PayoutRecipient,
  PayoutStatus,
  PoStatus,
} from "@prisma/client";

import {
  CONTRACT_STATUS_LABEL,
  CONTRACT_SUPERSESSION_REASON_LABEL,
  ORG_INVOICE_STATUS_LABEL,
  ORG_PAYOUT_STATUS_LABEL,
  PAYOUT_RECIPIENT_NAME,
  PURCHASE_ORDER_STATUS_LABEL,
  formatAuditDate,
} from "@/lib/labels/org-labels";

// The Record types fail tsc on a new enum value; this fails jest on the same.
describe.each([
  ["contract status", ContractStatus, CONTRACT_STATUS_LABEL],
  [
    "supersession reason",
    ContractSupersessionReason,
    CONTRACT_SUPERSESSION_REASON_LABEL,
  ],
  ["purchase order status", PoStatus, PURCHASE_ORDER_STATUS_LABEL],
  ["org invoice status", OrgInvoiceStatus, ORG_INVOICE_STATUS_LABEL],
  ["org payout status", PayoutStatus, ORG_PAYOUT_STATUS_LABEL],
  ["payout recipient", PayoutRecipient, PAYOUT_RECIPIENT_NAME],
])("%s labels", (_name, enumObject, labels) => {
  it("covers every enum value with prose, not the raw value", () => {
    expect(Object.keys(labels).sort()).toEqual(Object.keys(enumObject).sort());
    for (const [value, label] of Object.entries(labels)) {
      expect(label).not.toBe(value);
      expect(label).not.toMatch(/_/);
    }
  });
});

it("formats an audit date in India time", () => {
  expect(formatAuditDate(new Date("2026-11-07T19:00:00Z"))).toBe("8 Nov 2026");
});
