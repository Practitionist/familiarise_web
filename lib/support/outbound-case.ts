import { z } from "zod";

import { caseKeyOf } from "./case-key";

/** What `POST /api/support/cases` answers a staff outbound request with. */
export const OutboundCaseResponse = z.object({
  data: z.object({ id: z.string(), referenceNumber: z.string() }),
  reused: z.boolean().optional(),
  dedupeReason: z.enum(["open_scope", "client_intake_id"]).nullish(),
});
export type OutboundCaseResponse = z.infer<typeof OutboundCaseResponse>;

/** The notice for a request the server added to the customer's open case; null for a new case. */
export function outboundCaseNotice(
  result: OutboundCaseResponse,
  basePath: string,
): { title: string; description: string; href: string } | null {
  if (!result.reused || result.dedupeReason !== "open_scope") return null;
  return {
    title: `Added to ${result.data.referenceNumber} because this customer already has an open case`,
    description:
      "Your message was posted there as a reply the customer can see.",
    href: `${basePath}/support/${caseKeyOf({ kind: "case", id: result.data.id })}`,
  };
}
