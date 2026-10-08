/**
 * @jest-environment node
 */

const mockPermanentRedirect = jest.fn((path: string) => {
  throw new Error(`NEXT_PERMANENT_REDIRECT:${path}`);
});
const mockNotFound = jest.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});

jest.mock("next/navigation", () => ({
  __esModule: true,
  permanentRedirect: (path: string) => mockPermanentRedirect(path),
  redirect: jest.fn(),
  notFound: () => mockNotFound(),
}));

jest.mock("../../lib/auth-client", () => ({
  useSession: () => ({ data: null }),
}));

import LegacyBackofficeCatchAll from "@/app/dashboard/(backoffice)/[tree]/[...legacy]/page";
import { legacyBackofficeHref } from "@/lib/backoffice/legacy-routes";
import { slaStatusBadge } from "@/lib/support/sla-hint";
import {
  inboxThreadWhere,
  inboxTicketWhere,
  mergeCasePage,
  parseInboxFilters,
} from "@/lib/support/inbox-query";
import type { SlaState } from "@/lib/support/sla";
import {
  deriveCreditState,
  type ReferralCreditItem,
} from "@/components/dashboard/backoffice/referrals/ReferralCreditsPageClient";

describe("folded backoffice money index redirects", () => {
  beforeEach(() => {
    mockPermanentRedirect.mockClear();
    mockNotFound.mockClear();
  });

  it.each([
    [
      "admin",
      ["payments"],
      { status: "SUCCEEDED" },
      "/dashboard/admin/money/payments?status=SUCCEEDED",
    ],
    [
      "staff",
      ["refunds"],
      { page: "2" },
      "/dashboard/staff/money/refunds?page=2",
    ],
    [
      "admin",
      ["payouts"],
      { tab: "batches" },
      "/dashboard/admin/money/payouts?tab=batches",
    ],
    [
      "staff",
      ["disputes"],
      { status: "NEEDS_RESPONSE" },
      "/dashboard/staff/money/disputes?status=NEEDS_RESPONSE",
    ],
  ] as const)(
    "redirects %s /%j with %j → %s",
    async (tree, legacy, query, expected) => {
      expect(legacyBackofficeHref(tree, legacy, query)).toBe(expected);
      await expect(
        LegacyBackofficeCatchAll({
          params: Promise.resolve({ tree, legacy: [...legacy] }),
          searchParams: Promise.resolve(query),
        }),
      ).rejects.toThrow(`NEXT_PERMANENT_REDIRECT:${expected}`);
      expect(mockPermanentRedirect).toHaveBeenCalledWith(expected);
    },
  );

  it("404s unknown legacy segments via notFound()", async () => {
    await expect(
      LegacyBackofficeCatchAll({
        params: Promise.resolve({ tree: "admin", legacy: ["unknown-route"] }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mockNotFound).toHaveBeenCalled();
  });
});

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
    expect(inboxThreadWhere(f)).toBeNull();
    expect(JSON.stringify(inboxTicketWhere(f))).toContain(
      '"awaitingUserSince":null',
    );

    const rows = mergeCasePage(
      [
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
      ],
      [],
      0,
      10,
      f.sort,
    );
    expect(rows.map((r) => r.key)).toEqual(["t_sooner", "t_later"]);
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

  it("derives PENDING, VESTED, EXPIRED, and VOID states accurately", () => {
    expect(deriveCreditState(makeCredit({ state: "PENDING" }))).toEqual({
      label: "PENDING",
      status: "PENDING",
      tone: "warning",
    });
    expect(deriveCreditState(makeCredit({ state: "VESTED" }))).toEqual({
      label: "VESTED",
      status: "VESTED",
      tone: "success",
    });
    expect(deriveCreditState(makeCredit({ state: "EXPIRED" }))).toEqual({
      label: "EXPIRED",
      status: "EXPIRED",
      tone: "warning",
    });
    expect(deriveCreditState(makeCredit({ state: "VOID" }))).toEqual({
      label: "VOID",
      status: "VOID",
      tone: "critical",
    });
    expect(
      deriveCreditState(makeCredit({ reversedAt: "2026-02-01T00:00:00.000Z" })),
    ).toEqual({
      label: "VOID",
      status: "VOID",
      tone: "critical",
    });
    expect(
      deriveCreditState(makeCredit({ state: "VESTED", remainingAmount: 0 })),
    ).toEqual({
      label: "EXHAUSTED",
      status: "EXHAUSTED",
      tone: "neutral",
    });
    expect(
      deriveCreditState(makeCredit({ state: "VESTED", remainingAmount: -100 })),
    ).toEqual({
      label: "EXHAUSTED",
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
      label: "EXPIRED",
      status: "EXPIRED",
      tone: "warning",
    });
  });
});
