/**
 * Platform-wide trial pricing controls (single-row config). The floor sits
 * UNDER every plan's trialPriceInPaise: consultants price their own trials,
 * and admin raises the floor platform-wide. 0 = free trials allowed.
 */

import prisma, { type Tx } from "@/lib/prisma";

export const PRICING_CONFIG_ID = "singleton";

/** The floor in paise, creating the singleton row on first read. */
export async function getMinTrialPriceInPaise(
  db: Pick<Tx, "platformPricingConfig"> = prisma,
): Promise<number> {
  const config = await db.platformPricingConfig.upsert({
    where: { id: PRICING_CONFIG_ID },
    create: { id: PRICING_CONFIG_ID },
    update: {},
    select: { minTrialPriceInPaise: true },
  });
  return config.minTrialPriceInPaise;
}
