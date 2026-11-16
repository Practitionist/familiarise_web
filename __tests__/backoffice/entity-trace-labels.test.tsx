/**
 * @jest-environment jsdom
 */

/**
 * The trace speaks words: the gateway, the ledger accounts and the stored
 * reasons are labelled, the customer is named, the lookup form shows what is
 * being traced and the summary names the booking once.
 */

import { render, screen, within } from "@testing-library/react";

const mockAt = new Date("2026-11-01T04:30:00Z");
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    payment: {
      findUnique: jest.fn(async () => ({
        id: "pay_1",
        amount: 150_000,
        currency: "INR",
        paymentStatus: "SUCCEEDED",
        paymentGateway: "DODO_PAYMENTS",
        paymentIntent: "order_1",
        gatewayPaymentId: null,
        userId: "user_1",
        appointmentId: null,
        organizationId: null,
        hostOrganizationId: null,
        billableToOrgInvoiceId: null,
        parentPaymentId: null,
        refundOwedPaise: null,
        refundOwedReason: null,
        refundOwedAt: null,
        capturedAt: null,
        lastReconciledAt: null,
        deletedAt: null,
        createdAt: mockAt,
        updatedAt: mockAt,
        user: {
          id: "user_1",
          name: "Priya Anderson",
          email: "priya@example.test",
        },
        childPayments: [],
      })),
    },
    refund: {
      findMany: jest.fn(async () => [
        {
          id: "r1",
          amountPaise: 50_000,
          currency: "INR",
          status: "SUCCEEDED",
          reason: "OTHER",
          refundId: "rfnd_1",
          failureReason: null,
          failedAt: null,
          cascadedAt: null,
          deletedAt: null,
          createdAt: mockAt,
          updatedAt: mockAt,
        },
      ]),
    },
    consultantEarnings: {
      findMany: jest.fn(async () => [
        {
          id: "earn_1",
          role: "OWNER",
          payoutId: null,
          status: "PENDING",
          consultantSharePaise: 120_000,
          platformFeePaise: 30_000,
          refundedShareAmount: 0,
          currency: "INR",
          holdUntil: null,
          paidAt: null,
          createdAt: mockAt,
          updatedAt: mockAt,
          consultantProfile: { user: { name: "Arjun Anderson" } },
          holds: [],
        },
      ]),
    },
    systemEvent: {
      findMany: jest.fn(async () => [
        {
          id: "ev_1",
          category: "PAYMENT",
          severity: "INFO",
          message: "Captured",
          correlationId: "pay_1",
          createdAt: mockAt,
        },
      ]),
    },
    ledgerTransaction: {
      findMany: jest.fn(async () => [
        {
          id: "txn_1",
          kind: "BOOKING",
          description: null,
          postedAt: mockAt,
          entries: [
            {
              direction: "DEBIT",
              amountPaise: 150_000,
              account: { kind: "CASH" },
            },
            {
              direction: "CREDIT",
              amountPaise: 30_000,
              account: { kind: "PLATFORM_FEE" },
            },
            {
              direction: "CREDIT",
              amountPaise: 120_000,
              account: { kind: "CONSULTANT_PAYABLE" },
            },
          ],
        },
      ]),
    },
  },
}));

const mockCapability = {
  tree: "admin",
  basePath: "/dashboard/admin",
  role: "ADMIN",
};
jest.mock(
  "../../components/dashboard/backoffice/BackofficeCapabilityProvider",
  () => ({ useBackofficeCapability: () => mockCapability }),
);

import {
  EntityTraceView,
  lookupDefaults,
} from "../../components/dashboard/backoffice/EntityTraceView";
import { readFileSync } from "fs";
import { join } from "path";
import {
  readEntityTrace,
  traceReason,
} from "../../lib/backoffice/entity-trace";
import type { EntityTrace } from "../../lib/backoffice/entity-trace-types";

it("labels the gateway, the ledger accounts and the reasons", async () => {
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
  const trace = await readEntityTrace({
    kind: "payment",
    id: "pay_1",
    viewer: { userId: "admin_1", role: "ADMIN", seesSystemEvents: false },
  });
  const detail = (key: string) =>
    trace?.rows.find((r) => r.key === key)?.detail;
  expect(detail("payment:pay_1:created")).toBe("Dodo Payments · order order_1");
  expect(detail("ledger:txn_1:posted")).toBe(
    "3 entries · Debit Cash · Credit Platform fee, Owed to expert",
  );
  expect(detail("refund:r1:created")).toBe(
    "gateway rfnd_1 · A reason the other party did not specify",
  );
  expect(trace?.customer).toEqual({
    id: "user_1",
    name: "Priya Anderson",
    email: "priya@example.test",
  });
});

it("words the earnings role and the system event", async () => {
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
  const trace = await readEntityTrace({
    kind: "payment",
    id: "pay_1",
    viewer: { userId: "admin_1", role: "ADMIN", seesSystemEvents: true },
  });
  const text = JSON.stringify(trace?.rows.map((r) => [r.status, r.detail]));
  expect(text).toContain("Expert share for Arjun Anderson");
  expect(text).toContain("Payment event (info)");
  expect(text).not.toMatch(/OWNER|PAYMENT INFO/);
});

it("words the booking history's reason codes and keeps free text", () => {
  // The code the host's one-session cancel writes; read from source, the module is heavy.
  expect(
    readFileSync(join(process.cwd(), "lib/booking/class-sessions.ts"), "utf8"),
  ).toContain('HOST_CANCELLED_SESSION_REASON = "HOST_CANCELLED_SESSION"');
  expect(traceReason("HOST_CANCELLED_SESSION")).toBe(
    "Host cancelled the session",
  );
  expect(traceReason("OTHER")).toBe("A reason the other party did not specify");
  expect(traceReason("NO_SHOW_SWEEP")).toBe("No show sweep");
  expect(traceReason("Learner asked to move it")).toBe(
    "Learner asked to move it",
  );
  expect(traceReason(null)).toBeNull();
});

const bookingTrace: EntityTrace = {
  kind: "appointment",
  id: "appt_1",
  paymentIds: ["pay_1"],
  appointmentId: "appt_1",
  userId: "user_1",
  customer: {
    id: "user_1",
    name: "Priya Anderson",
    email: "priya@example.test",
  },
  sentryHref: null,
  rows: [],
  sources: [],
};

it("prefills the lookup form from what is being traced", () => {
  expect(
    lookupDefaults({
      mode: "trace",
      trace: bookingTrace,
      seesSystemEvents: false,
    }),
  ).toEqual({ kind: "appointment", id: "appt_1" });
  expect(lookupDefaults({ mode: "missing", kind: "user", id: "u_9" })).toEqual({
    kind: "user",
    id: "u_9",
  });
  expect(lookupDefaults({ mode: "lookup", invalid: false })).toEqual({
    kind: "payment",
    id: "",
  });

  render(
    <EntityTraceView
      mode="trace"
      trace={bookingTrace}
      seesSystemEvents={false}
    />,
  );
  expect(screen.getByLabelText("Id")).toHaveValue("appt_1");
  expect(screen.getByRole("combobox")).toHaveTextContent("Booking id");
  // The form posts the kind through the shared Select's hidden native control.
  expect(document.querySelector('select[name="kind"]')).toHaveValue(
    "appointment",
  );
});

it("names the booking once and the customer by name", () => {
  render(
    <EntityTraceView
      mode="trace"
      trace={bookingTrace}
      seesSystemEvents={false}
    />,
  );
  expect(screen.getAllByText("Booking")).toHaveLength(1);
  const customer = screen.getByText("Priya Anderson").closest("a");
  expect(customer).toHaveAttribute("href", "/dashboard/admin/users/user_1");
  expect(
    within(customer as HTMLElement).getByText("priya@example.test"),
  ).toBeTruthy();
  expect(screen.queryByText("Open User 360")).toBeNull();
});
