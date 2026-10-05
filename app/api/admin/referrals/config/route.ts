/**
 * GET   /api/admin/referrals/config — the referral programme economics (STAFF + ADMIN).
 * PATCH /api/admin/referrals/config — ADMIN edit with a reason; bumps `version` by CAS.
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal";
import { isUniqueViolationOn } from "@/lib/db/unique-violation";
import {
  configSnapshot,
  readReferralProgramConfig,
  REFERRAL_CONFIG_ID,
  referralProgramConfigPatchSchema,
} from "@/lib/referrals/program-config";

export async function GET() {
  const auth = await requireBackofficeSurface("referrals.read");
  if (auth.error) return auth.error;
  return NextResponse.json({ config: await readReferralProgramConfig() });
}

export const PATCH = withOpsAction(
  "referrals.manage",
  "referrals.config.update",
  {
    ...referralProgramConfigPatchSchema.shape,
    expectedVersion: z.number().int().positive().optional(),
  },
  {
    mode: "tx",
    run: async (tx, ctx) => {
      const patch = referralProgramConfigPatchSchema.parse(ctx.body);
      if (Object.keys(patch).length === 0) {
        throw new OpsRefusal("EMPTY_PATCH", "Change at least one value.", 400);
      }
      const before = await readReferralProgramConfig(tx);
      if (!before) {
        const created = await tx.referralProgramConfig
          .create({ data: { id: REFERRAL_CONFIG_ID, ...patch } })
          .catch((err: unknown) => {
            if (isUniqueViolationOn(err, "id")) {
              throw new OpsRefusal(
                "CONFIG_CHANGED",
                "The programme was edited by someone else; refresh and retry.",
                409,
              );
            }
            throw err;
          });
        return {
          target: { kind: "ReferralProgramConfig", id: REFERRAL_CONFIG_ID },
          response: { config: created },
          after: configSnapshot(created),
        };
      }
      // An edit must name the version the admin saw, or it could overwrite a concurrent one.
      if (ctx.body.expectedVersion === undefined) {
        throw new OpsRefusal(
          "VERSION_REQUIRED",
          "Send the expectedVersion you loaded.",
          400,
        );
      }
      const moved = await tx.referralProgramConfig.updateMany({
        where: { id: REFERRAL_CONFIG_ID, version: ctx.body.expectedVersion },
        data: { ...patch, version: { increment: 1 } },
      });
      if (moved.count !== 1) {
        throw new OpsRefusal(
          "CONFIG_CHANGED",
          "The programme was edited by someone else; refresh and retry.",
          409,
        );
      }
      const after = await readReferralProgramConfig(tx);
      return {
        target: { kind: "ReferralProgramConfig", id: REFERRAL_CONFIG_ID },
        response: { config: after },
        before: configSnapshot(before),
        after: after ? configSnapshot(after) : undefined,
      };
    },
  },
);
