/**
 * POST /api/admin/referrals/held/[referralId] — ADMIN decides a held referral with a reason:
 * RELEASE returns it to QUALIFYING for the next vest run, VOID voids it and its PENDING credit.
 */
import { z } from "zod";

import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal";
import { releaseHeldReferral, voidHeldReferral } from "@/lib/referrals/review";

const decisionSchema = z.enum(["RELEASE", "VOID"]);

export const POST = withOpsAction(
  "referrals.manage",
  (body) =>
    body.decision === "RELEASE"
      ? "referrals.review.release"
      : "referrals.review.void",
  { decision: decisionSchema },
  {
    mode: "tx",
    run: async (tx, ctx) => {
      const referralId = ctx.params.referralId;
      const now = new Date();
      const release = ctx.body.decision === "RELEASE";
      const decide = release ? releaseHeldReferral : voidHeldReferral;
      if (!referralId || (await decide(tx, referralId, now)) === "NOT_HELD") {
        throw new OpsRefusal(
          "REFERRAL_NOT_HELD",
          "This referral is no longer held for review; refresh and retry.",
          409,
        );
      }
      const after = release
        ? { status: "QUALIFYING", reviewReleasedAt: now.toISOString() }
        : { status: "VOID", voidReason: "REVIEW_REJECTED" };
      return {
        target: { kind: "Referral", id: referralId },
        response: { referralId, status: after.status },
        before: { status: "HELD" },
        after,
      };
    },
  },
);
