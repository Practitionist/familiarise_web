/**
 * @jest-environment node
 */

/**
 * #1775 PR-B — Remind on an awaiting-payment request: once per 24 h per
 * appointment, only while an open pay order is live, and the outbox row
 * carries the MANUAL email type so the sweep's automatic half-window
 * reminder never dedupes against it (nor the other way round).
 */

const findUnique = jest.fn();
// The last manual reminder's outbox row — the 24 h clock (state-as-outbox).
const lastManualReminder = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consultation: { findUnique: (...a: unknown[]) => findUnique(...a) },
    subscription: { findUnique: (...a: unknown[]) => findUnique(...a) },
    failedEmail: { findFirst: (...a: unknown[]) => lastManualReminder(...a) },
  },
}));

const limit = jest.fn();
jest.mock("../../lib/rate-limit", () => ({
  remindLimiter: { limit: (...a: unknown[]) => limit(...a) },
  applyRateLimit: async () => null,
  eventMutationLimiter: {},
}));

const deliver = jest.fn().mockResolvedValue({ success: true, staged: true });
jest.mock("../../lib/email", () => ({
  deliver: (...a: unknown[]) => deliver(...a),
  EMAIL_BUDGET_MS: { REQUEST: 5_000 },
  SENDERS: { payments: "payments@test" },
  // The sweep's automatic type, as the real module defines it; the pin below
  // asserts the manual type differs from it.
  PAYMENT_LINK_REMINDER_EMAIL_TYPE: "PAYMENT_LINK_REMINDER",
}));
// react-email's render() does not run under jest; the template is not the pin.
jest.mock("../../lib/email/render", () => ({
  renderEmail: async () => ({ html: "<p/>", text: "" }),
}));
jest.mock("../../emails/payments/PaymentLinkEmail", () => ({
  PaymentLinkEmail: (props: unknown) => props,
}));

const session = {
  user: {
    id: "u-consultant",
    role: "CONSULTANT",
    consultantProfileId: "cp-1",
    consulteeProfileId: null,
  },
};
jest.mock("../../lib/auth-helpers", () => ({
  requireApiAuth: async () => ({ session }),
  isPrivileged: (role: string) => role === "ADMIN" || role === "STAFF",
}));

import { NextRequest } from "next/server";
import { POST as remindConsultation } from "../../app/api/bookings/consultations/[consultationId]/remind/route";
import { PAYMENT_LINK_MANUAL_REMINDER_EMAIL_TYPE } from "../../lib/booking/remind-payment";
import { PAYMENT_LINK_REMINDER_EMAIL_TYPE } from "../../lib/email";

const C_ID = "clzzzzzzz000consultation1";
const IN_20H = new Date(Date.now() + 20 * 3_600_000);

const awaiting = (over: Record<string, unknown> = {}) => ({
  id: C_ID,
  status: "APPROVED_PENDING_PAYMENT",
  pendingPaymentUrl: "https://rzp.io/l/abc",
  requestedBy: {
    user: { id: "u-buyer", name: "Buyer", email: "buyer@test" },
  },
  consultationPlan: {
    consultantProfileId: "cp-1",
    consultantProfile: { user: { name: "Ethan" } },
  },
  appointment: {
    id: "a-1",
    payment: [
      { id: "pay-1", amount: 708_000, currency: "INR", expiresAt: IN_20H },
    ],
  },
  ...over,
});

const post = () =>
  remindConsultation(
    new NextRequest("http://localhost/x", { method: "POST" }),
    { params: Promise.resolve({ consultationId: C_ID }) },
  );

const HOUR = 3_600_000;
const hoursFromNow = (iso: string) => (Date.parse(iso) - Date.now()) / HOUR;

beforeEach(() => {
  jest.clearAllMocks();
  lastManualReminder.mockResolvedValue(null);
  limit.mockResolvedValue({ success: true, reset: IN_20H.getTime() });
});

describe("POST …/remind (B-3)", () => {
  it("re-sends the live link under the MANUAL outbox type, keyed by appointment, and answers nextAllowedAt", async () => {
    findUnique.mockResolvedValue(awaiting());
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    // A sliding 24 h from THIS send, not the limiter's UTC-day bucket.
    const { nextAllowedAt } = await res.json();
    expect(hoursFromNow(nextAllowedAt)).toBeCloseTo(24, 1);
    expect(limit).toHaveBeenCalledWith("a-1");
    const [message, emailType, opts] = deliver.mock.calls[0];
    expect(emailType).toBe(PAYMENT_LINK_MANUAL_REMINDER_EMAIL_TYPE);
    expect(PAYMENT_LINK_REMINDER_EMAIL_TYPE).toBe("PAYMENT_LINK_REMINDER");
    expect(emailType).not.toBe(PAYMENT_LINK_REMINDER_EMAIL_TYPE);
    expect(opts).toEqual({ entityRef: "payment:pay-1", budgetMs: 5_000 });
    expect(message.to).toBe("buyer@test");
  });

  it("a second call inside 24 h → 429, nextAllowedAt = the last send + 24 h, nothing sent", async () => {
    findUnique.mockResolvedValue(awaiting());
    // Sent 4 h ago: the window closes 20 h from now, whatever the UTC day
    // bucket says; the limiter is not even consulted.
    lastManualReminder.mockResolvedValue({
      createdAt: new Date(Date.now() - 4 * HOUR),
    });
    const res = await post();
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.code).toBe("REMIND_RATE_LIMITED");
    expect(hoursFromNow(body.nextAllowedAt)).toBeCloseTo(20, 1);
    expect(res.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(limit).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });

  it("two clicks in the same second: the limiter refuses the second with a full 24 h", async () => {
    findUnique.mockResolvedValue(awaiting());
    limit.mockResolvedValue({ success: false, reset: IN_20H.getTime() });
    const res = await post();
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(hoursFromNow(body.nextAllowedAt)).toBeCloseTo(24, 1);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("no open PENDING payment → 409 NOT_AWAITING_PAYMENT before the limiter", async () => {
    findUnique.mockResolvedValue(
      awaiting({ appointment: { id: "a-1", payment: [] } }),
    );
    const res = await post();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "NOT_AWAITING_PAYMENT" });
    expect(limit).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });
});
