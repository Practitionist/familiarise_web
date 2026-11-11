/**
 * @jest-environment node
 */
import {
  NULLED_PAYER_SIGNALS,
  NULLED_REFERRAL_SIGNALS,
  PAYER_SIGNAL_RETENTION_YEARS,
  REFERRAL_SIGNAL_RETENTION_DAYS,
  paymentSignalPruneWhere,
  referralSignalPruneWhere,
} from "../../lib/compliance/signal-retention";

const NOW = Date.parse("2026-11-09T12:00:00Z");

describe("fraud-signal retention windows", () => {
  it("keeps the owner's windows: 180 days for referral signals, 2 years for payer hashes", () => {
    expect(REFERRAL_SIGNAL_RETENTION_DAYS).toBe(180);
    expect(PAYER_SIGNAL_RETENTION_YEARS).toBe(2);
  });

  it("selects a terminal referral 180 days after the transition, an unsettled one 180 days after creation", () => {
    const where = referralSignalPruneWhere(NOW);
    expect(where).toEqual({
      AND: [
        { OR: [{ ipHash: { not: null } }, { userAgent: { not: null } }] },
        {
          OR: [
            {
              status: "VESTED",
              vestedAt: { lt: new Date("2026-05-13T12:00:00Z") },
            },
            {
              status: { in: ["VOID", "REWARDED", "EXPIRED", "FRAUDULENT"] },
              updatedAt: { lt: new Date("2026-05-13T12:00:00Z") },
            },
            {
              status: { in: ["SIGNED_UP", "QUALIFIED", "QUALIFYING", "HELD"] },
              createdAt: { lt: new Date("2026-05-13T12:00:00Z") },
            },
          ],
        },
      ],
    });
  });

  it("selects a payment two years after capture, falling back to createdAt when capturedAt is null", () => {
    const cutoff = new Date("2024-11-09T12:00:00Z");
    expect(paymentSignalPruneWhere(NOW)).toEqual({
      AND: [
        {
          OR: [
            { payerVpaHash: { not: null } },
            { payerPhoneHash: { not: null } },
          ],
        },
        {
          OR: [
            { capturedAt: { lt: cutoff } },
            { capturedAt: null, createdAt: { lt: cutoff } },
          ],
        },
      ],
    });
  });

  it("writes null over exactly the signal columns", () => {
    expect(NULLED_REFERRAL_SIGNALS).toEqual({ ipHash: null, userAgent: null });
    expect(NULLED_PAYER_SIGNALS).toEqual({
      payerVpaHash: null,
      payerPhoneHash: null,
    });
  });
});
