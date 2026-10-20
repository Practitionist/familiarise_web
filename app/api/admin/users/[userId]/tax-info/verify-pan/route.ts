/**
 * POST /api/admin/users/[userId]/tax-info/verify-pan — an admin verifies or
 * rejects a consultant's PAN. ADMIN, step-up, a reason and an ops log row.
 */

import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal";
import {
  personNamesMatch,
  verifiedPayoutHolderName,
} from "@/lib/payments/tax/pan-verification";

export const POST = withOpsAction(
  "payouts.manage",
  (body) =>
    body.decision === "VERIFY" ? "taxInfo.pan.verify" : "taxInfo.pan.reject",
  {
    decision: z.enum(["VERIFY", "REJECT"]),
    overrideNameMismatch: z.boolean().optional(),
  },
  {
    mode: "tx",
    run: async (tx, { body, params }) => {
      const profile = await tx.consultantProfile.findUnique({
        where: { userId: params.userId },
        select: {
          id: true,
          // The 26Q return files the PAN under this name, so it stands in for the PAN holder.
          user: { select: { name: true } },
          taxInfo: {
            select: {
              id: true,
              panEncrypted: true,
              panLast4: true,
              panVerified: true,
            },
          },
        },
      });
      if (!profile) {
        throw new OpsRefusal(
          "NOT_FOUND",
          "This user is not a consultant.",
          404,
        );
      }
      const taxInfo = profile.taxInfo;
      if (!taxInfo?.panEncrypted) {
        throw new OpsRefusal("NO_PAN", "This consultant has no PAN on file.");
      }

      const verify = body.decision === "VERIFY";
      // An unverified PAN already takes the no-PAN rate, so rejecting it would change nothing.
      if (!verify && !taxInfo.panVerified) {
        throw new OpsRefusal(
          "PAN_NOT_VERIFIED",
          "This PAN is not verified, so there is nothing to reject.",
        );
      }
      let nameCheck: Prisma.InputJsonObject = {};
      if (verify) {
        const payoutHolderName = await verifiedPayoutHolderName(tx, profile.id);
        const namesMatch = personNamesMatch(
          profile.user.name,
          payoutHolderName,
        );
        if (!namesMatch && body.overrideNameMismatch !== true) {
          throw new OpsRefusal(
            "PAN_NAME_MISMATCH",
            "The consultant's name does not match the verified payout account holder. Tick the override to verify anyway.",
          );
        }
        nameCheck = {
          namesMatch,
          overrideNameMismatch: !namesMatch,
          consultantName: profile.user.name,
          payoutHolderName,
        };
      }

      // The PAN read above must still be the one on file, so a concurrent change is never verified.
      const updated = await tx.consultantTaxInfo.updateMany({
        where: {
          id: taxInfo.id,
          panEncrypted: { equals: taxInfo.panEncrypted },
        },
        data: { panVerified: verify },
      });
      if (updated.count === 0) {
        throw new OpsRefusal(
          "PAN_CHANGED",
          "The PAN changed while you were reviewing it. Reload and check the new one.",
        );
      }

      return {
        target: { kind: "ConsultantProfile", id: profile.id },
        before: {
          panLast4: taxInfo.panLast4,
          panVerified: taxInfo.panVerified,
        },
        after: {
          panLast4: taxInfo.panLast4,
          panVerified: verify,
          ...nameCheck,
        },
        response: { panVerified: verify },
      };
    },
  },
  { stepUp: true },
);
