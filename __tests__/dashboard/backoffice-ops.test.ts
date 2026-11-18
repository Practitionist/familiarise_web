/**
 * @jest-environment node
 */

jest.mock("../../lib/auth-client", () => ({
  useSession: () => ({ data: null }),
}));

import { slaStatusBadge } from "@/lib/support/sla-hint";
import {
  inboxCaseWhere,
  compareCasesBySla,
  parseInboxFilters,
} from "@/lib/support/inbox-query";
import type { SlaState } from "@/lib/support/sla";
import {
  deriveCreditState,
  type ReferralCreditItem,
} from "@/components/dashboard/backoffice/referrals/ReferralCreditsPageClient";

describe("support SLA status badges and sla-at-risk inbox query", () => {
  const baseSla: SlaState = {
    ackBreached: false,
    msToAckDue: 10 * 3_600_000,
    resolutionBreached: false,
    msToResolutionDue: 96 * 3_600_000,
  };

  it("maps SLA states to Breached (critical), Due soon (warning), and On track (neutral)", () => {
    expect(slaStatusBadge({ ...baseSla, ackBreached: true })).toEqual({
      label: "Breached",
      tone: "critical",
    });
    expect(slaStatusBadge({ ...baseSla, resolutionBreached: true })).toEqual({
      label: "Breached",
      tone: "critical",
    });
    expect(slaStatusBadge({ ...baseSla, msToAckDue: 2 * 3_600_000 })).toEqual({
      label: "Due soon",
      tone: "warning",
    });
    expect(slaStatusBadge(baseSla)).toEqual({
      label: "On track",
      tone: "neutral",
    });
  });

  it("defaults sort to sla (ackDueAt ASC) when view is sla-at-risk", () => {
    const f = parseInboxFilters(
      (k) => (k === "view" ? "sla-at-risk" : null),
      "staff-1",
    );
    expect(f.view).toBe("sla-at-risk");
    expect(f.sort).toBe("sla");
    // The at-risk view is deadline-driven: the statutory deadline is
    // absolute, so a user wait cannot push it out, and the effective
    // deadline's pause is shown per row rather than hidden by the filter.
    const atRisk = JSON.stringify(inboxCaseWhere(f));
    expect(atRisk).toContain('"statutoryDueAt"');
    expect(atRisk).toContain('"ackDueAt"');
    expect(atRisk).toContain('"resolutionDueAt"');

    const rows = [
      {
        key: "t_later",
        lastMessageAt: new Date("2026-10-06T05:00:00Z"),
        createdAt: new Date("2026-10-05T00:00:00Z"),
        ackDueAt: new Date("2026-10-06T18:00:00Z"),
      },
      {
        key: "t_sooner",
        lastMessageAt: new Date("2026-10-06T01:00:00Z"),
        createdAt: new Date("2026-10-05T00:00:00Z"),
        ackDueAt: new Date("2026-10-06T08:00:00Z"),
      },
    ].sort(compareCasesBySla);
    expect(rows.map((r) => r.key)).toEqual(["t_sooner", "t_later"]);
  });

  it("narrows only the statutory arm of sla-at-risk by the reader's reopened rule", () => {
    const f = parseInboxFilters(
      (k) => (k === "view" ? "sla-at-risk" : null),
      "viewer_1",
    );
    const binds = {
      OR: [{ reopenedAt: null }, { reopenedAt: { lte: "ref" } }],
    };
    const where = inboxCaseWhere(
      f,
      new Date("2026-11-12T00:00:00Z"),
      binds as never,
    );
    const arms = (
      (where.AND as Record<string, unknown>[]).find((clause) => "OR" in clause)
        ?.OR as Record<string, unknown>[]
    ).filter((arm) => "OR" in arm);
    expect(arms).toHaveLength(1);
    expect(arms[0]).toHaveProperty("statutoryDueAt");
    expect(arms[0].OR).toEqual(binds.OR);
  });

  it("ranks a case reopened after its statutory date by its new target", () => {
    const base = {
      lastMessageAt: null,
      createdAt: new Date("2026-10-01T00:00:00Z"),
      acknowledgedAt: new Date("2026-10-02T00:00:00Z"),
    };
    const rows = [
      {
        ...base,
        key: "reopened_past_statutory",
        statutoryDueAt: new Date("2026-10-30T00:00:00Z"),
        reopenedAt: new Date("2026-11-12T00:00:00Z"),
        resolutionDueAt: new Date("2026-11-19T00:00:00Z"),
      },
      {
        ...base,
        key: "due_this_week",
        statutoryDueAt: new Date("2026-11-14T00:00:00Z"),
        reopenedAt: null,
        resolutionDueAt: new Date("2026-11-14T00:00:00Z"),
      },
      {
        ...base,
        key: "reopened_before_statutory",
        statutoryDueAt: new Date("2026-11-13T00:00:00Z"),
        reopenedAt: new Date("2026-11-10T00:00:00Z"),
        resolutionDueAt: new Date("2026-11-13T00:00:00Z"),
      },
    ].sort(compareCasesBySla);
    expect(rows.map((r) => r.key)).toEqual([
      "reopened_before_statutory",
      "due_this_week",
      "reopened_past_statutory",
    ]);
  });
});

describe("deriveCreditState", () => {
  const makeCredit = (
    overrides: Partial<ReferralCreditItem> = {},
  ): ReferralCreditItem => ({
    id: "rc_1",
    userId: "u_1",
    amount: 30000,
    usedAmount: 0,
    remainingAmount: 30000,
    currency: "INR",
    source: "REFERRAL_BONUS",
    state: "VESTED",
    referralId: "ref_1",
    expiresAt: "2099-01-01T00:00:00.000Z",
    usedAt: null,
    reason: null,
    issuedBy: null,
    reversedAt: null,
    reversedBy: null,
    reversedReason: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    user: {
      id: "u_1",
      name: "Test User",
      email: "test@example.com",
      referralCode: null,
    },
    usages: [],
    ...overrides,
  });

  it("derives PENDING, VESTED, EXPIRED, and VOID states, labelled in words", () => {
    expect(deriveCreditState(makeCredit({ state: "PENDING" }))).toEqual({
      label: "Pending",
      status: "PENDING",
      tone: "warning",
    });
    expect(deriveCreditState(makeCredit({ state: "VESTED" }))).toEqual({
      label: "Available",
      status: "VESTED",
      tone: "success",
    });
    expect(deriveCreditState(makeCredit({ state: "EXPIRED" }))).toEqual({
      label: "Expired",
      status: "EXPIRED",
      tone: "warning",
    });
    expect(deriveCreditState(makeCredit({ state: "VOID" }))).toEqual({
      label: "Void",
      status: "VOID",
      tone: "critical",
    });
    expect(
      deriveCreditState(makeCredit({ reversedAt: "2026-02-01T00:00:00.000Z" })),
    ).toEqual({
      label: "Void",
      status: "VOID",
      tone: "critical",
    });
    expect(
      deriveCreditState(makeCredit({ state: "VESTED", remainingAmount: 0 })),
    ).toEqual({
      label: "Used up",
      status: "EXHAUSTED",
      tone: "neutral",
    });
    expect(
      deriveCreditState(makeCredit({ state: "VESTED", remainingAmount: -100 })),
    ).toEqual({
      label: "Used up",
      status: "EXHAUSTED",
      tone: "neutral",
    });
    expect(
      deriveCreditState(
        makeCredit({
          state: "VESTED",
          remainingAmount: 30000,
          expiresAt: "2020-01-01T00:00:00.000Z",
        }),
      ),
    ).toEqual({
      label: "Expired",
      status: "EXPIRED",
      tone: "warning",
    });
  });
});
