/**
 * The platform trial-price floor (PlatformPricingConfig singleton).
 *
 * GET   — the current minTrialPriceInPaise, gated on `trialPricing.manage`.
 * PATCH — an audited door (`trialPricing.update`, reason required) that sets
 *         it, CAS on the floor it read; 0 keeps free trials allowed.
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import {
  getMinTrialPriceInPaise,
  PRICING_CONFIG_ID,
} from "@/lib/trials/pricing-config";

export async function GET() {
  const auth = await requireBackofficeSurface("trialPricing.manage");
  if (auth.error) return auth.error;

  try {
    const minTrialPriceInPaise = await getMinTrialPriceInPaise();
    return NextResponse.json({ minTrialPriceInPaise });
  } catch (error) {
    Sentry.captureException(error);
    return NextResponse.json(
      { error: "Failed to read trial pricing config" },
      { status: 500 },
    );
  }
}

export const PATCH = withOpsAction(
  "trialPricing.manage",
  "trialPricing.update",
  { minTrialPriceInPaise: z.number().int().min(0) },
  {
    mode: "tx",
    run: async (tx, { body }) => {
      const before = await getMinTrialPriceInPaise(tx);
      const next = body.minTrialPriceInPaise;
      const { count } = await tx.platformPricingConfig.updateMany({
        where: { id: PRICING_CONFIG_ID, minTrialPriceInPaise: before },
        data: { minTrialPriceInPaise: next },
      });
      if (count === 0) {
        throw new OpsRefusal(
          "FLOOR_CHANGED",
          "The trial-price floor changed while you were editing — reload and try again.",
          409,
        );
      }
      return {
        target: { kind: "PlatformPricingConfig", id: PRICING_CONFIG_ID },
        before: { minTrialPriceInPaise: before },
        after: { minTrialPriceInPaise: next },
        response: { minTrialPriceInPaise: next },
      };
    },
  },
);
