/**
 * The subscription editor's notice that a terms edit spares existing buyers:
 * the plan GET tells the author how many live clients the plan has.
 */
import { z } from "zod";
import type { OfferingManifest } from "./manifest";

const ActiveClientsSchema = z.object({
  subscriptionPlan: z.object({ activeClients: z.number().int().nonnegative() }),
});

/** Live buyers of the plan being edited; the GET tells only its author. */
export function activeClientsOf(event: unknown): number {
  const parsed = ActiveClientsSchema.safeParse(event);
  return parsed.success ? parsed.data.subscriptionPlan.activeClients : 0;
}

/** Says on the pricing section that a terms edit spares existing buyers. */
export function withPricingNotice(
  manifest: OfferingManifest,
  notice: string,
): OfferingManifest {
  return {
    ...manifest,
    sections: manifest.sections.map((section) =>
      section.id === "pricing" ? { ...section, description: notice } : section,
    ),
  };
}
