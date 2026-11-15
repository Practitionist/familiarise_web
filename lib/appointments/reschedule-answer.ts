/**
 * What a reschedule answer sends and who may send it, shared by the detail
 * page's buttons and pinned against the respond and withdraw routes.
 */

import type { z } from "zod";
import type { RescheduleRespondSchema } from "@/schemas/appointments";

export type RescheduleAnswer = "accept" | "decline" | "withdraw";
export type RescheduleSide = "CONSULTANT" | "CONSULTEE";

export interface RescheduleAnswerRequest {
  url: string;
  /** Parsed by `RescheduleRespondSchema`; the withdraw route takes no body. */
  body: z.infer<typeof RescheduleRespondSchema> | null;
}

export function rescheduleAnswerRequest(
  appointmentId: string,
  kind: RescheduleAnswer,
): RescheduleAnswerRequest {
  const base = `/api/appointments/${appointmentId}/reschedule`;
  return kind === "withdraw"
    ? { url: `${base}/withdraw`, body: null }
    : { url: `${base}/respond`, body: { action: kind } };
}

/**
 * The answers the routes accept from this viewer: the proposer may withdraw,
 * the other party may decline (and accept when times were named), anyone else
 * — an operator, a suspended member — nothing.
 */
export function rescheduleAnswersFor(args: {
  viewerId: string | null | undefined;
  viewerSide: RescheduleSide | null;
  proposal: {
    initiatedById: string;
    initiatorRole: string;
    proposedTimes: readonly unknown[];
  };
  readOnly?: boolean;
}): RescheduleAnswer[] {
  const { viewerId, viewerSide, proposal } = args;
  if (!viewerId || !viewerSide || args.readOnly) return [];
  if (viewerId === proposal.initiatedById) {
    return viewerSide === proposal.initiatorRole ? ["withdraw"] : [];
  }
  const counterparty: RescheduleSide =
    proposal.initiatorRole === "CONSULTANT" ? "CONSULTEE" : "CONSULTANT";
  if (viewerSide !== counterparty) return [];
  return proposal.proposedTimes.length > 0
    ? ["accept", "decline"]
    : ["decline"];
}
