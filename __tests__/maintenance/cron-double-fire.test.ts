/**
 * @jest-environment node
 */

/**
 * #1859 M-P0-11 — the cron double-fire drill.
 *
 * The ticker (5-min) + Actions + dispatch re-runs can run the same money row
 * twice. The fleet collapses that to a single CAS win plus a single notice:
 * `updateMany({ where: { id, status: { in: fromIn } } })`, notice only on
 * `count === 1`, staged outbox rows relayed post-commit by the win owner.
 *
 * This pins the shared gate (`lib/cron/cas-notice.ts`) and the two lock-mode
 * residuals: `cleanup-tentative-occurrences` runs fail-closed (it releases
 * holds and blocks rebooking), while `alert-orphaned-payments` stays
 * fail-open (read-only — an unlocked re-read costs nothing).
 *
 * Source is read as text, never imported: job modules connect to Prisma and
 * Redis at import time, and a lock-mode pin must not need either.
 */

jest.mock("../../lib/novu/outbox", () => ({
  attemptTrigger: jest.fn(async () => ({ success: true, outcome: "SENT" })),
}));

import fs from "node:fs";
import path from "node:path";

import { attemptTrigger } from "../../lib/novu/outbox";
import { claimAndNotifyOnce } from "../../lib/cron/cas-notice";

const ROOT = path.join(__dirname, "..", "..");
const attemptMock = attemptTrigger as jest.Mock;

const STAGED_ROW = {
  id: "outbox-row-1",
  workflowId: "refund-processed",
  kind: "SINGLE" as const,
  recipients: ["user-1"],
  payload: {},
  transactionId: "refund-processed:abc",
  attempts: 0,
  status: "PENDING",
  notBefore: null,
};

beforeEach(() => jest.clearAllMocks());

describe("M-P0-11 double-fire drill (ticker twin + dispatch re-run)", () => {
  it("collapses concurrent claims to one CAS win and one notice", async () => {
    // One row, two runners: the first claim to land wins, exactly like two
    // updateMany writers racing on { id, status: { in: fromIn } }.
    let claimed = false;
    const claim = async () => {
      await new Promise((r) => setTimeout(r, 0));
      if (claimed) return { count: 0 };
      claimed = true;
      return { count: 1 };
    };
    const notify = jest.fn(async () => ({
      success: true,
      staged: { ...STAGED_ROW },
    }));

    const [first, second] = await Promise.all([
      claimAndNotifyOnce({ claim, notify }),
      claimAndNotifyOnce({ claim, notify }),
    ]);

    // Exactly one winner, one notice, one post-commit relay of the staged row.
    expect([first, second].sort()).toEqual([false, true]);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(attemptMock).toHaveBeenCalledTimes(1);
    expect(attemptMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "outbox-row-1" }),
    );
  });

  it("relays only staged-never-attempted rows, never re-sends inline attempts", async () => {
    const won = await claimAndNotifyOnce({
      claim: async () => ({ count: 1 }),
      // A notify fn that attempted inline carries outcome: the row is already
      // SENT, so the relay must leave it alone instead of sending twice.
      notify: async () => ({
        success: true,
        staged: { ...STAGED_ROW },
        outcome: "SENT" as const,
      }),
    });

    expect(won).toBe(true);
    expect(attemptMock).not.toHaveBeenCalled();
  });

  it("notifies nothing when the claim loses, and tolerates a void notify", async () => {
    const notify = jest.fn();
    const won = await claimAndNotifyOnce({
      claim: async () => ({ count: 0 }),
      notify,
    });

    expect(won).toBe(false);
    expect(notify).not.toHaveBeenCalled();
    expect(attemptMock).not.toHaveBeenCalled();

    const voidWon = await claimAndNotifyOnce({
      claim: async () => ({ count: 1 }),
      notify: async () => {},
    });
    expect(voidWon).toBe(true);
    expect(attemptMock).not.toHaveBeenCalled();
  });
});

describe("M-P0-11 lock-mode residuals", () => {
  function read(rel: string): string {
    return fs.readFileSync(path.join(ROOT, rel), "utf8");
  }

  it("holds cleanup-tentative-occurrences fail-closed with a long TTL", () => {
    const src = read("scripts/appointments/cleanup-tentative-occurrences.ts");
    expect(src).toContain('failMode: "closed"');
    expect(src).toContain("LONG_JOB_TTL_MS");
    expect(src).not.toContain('failMode: "open"');
  });

  it("leaves alert-orphaned-payments fail-open (read-only, correct)", () => {
    const src = read("scripts/alerts/alert-orphaned-payments.ts");
    expect(src).toContain('failMode: "open"');
    expect(src).not.toContain('failMode: "closed"');
  });
});
