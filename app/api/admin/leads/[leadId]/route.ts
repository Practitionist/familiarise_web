/**
 * PATCH /api/admin/leads/[leadId]
 *
 * Status transition on the enterprise pipeline, one audited `lead.transition`
 * row per move. The prior status is read in the transaction and the write is
 * CAS on it, so two operators cannot double-advance past each other (409).
 *
 * Allowed flow (authoritative): NEW → CONTACTED → QUALIFIED → CLOSED_WON |
 * CLOSED_LOST. NEW and CONTACTED may also be lost directly. QUALIFIED cannot
 * be skipped on the way to WON, and terminal states accept no further moves.
 */

import { type NextRequest } from "next/server";
import { LeadStatus } from "@prisma/client";
import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { leadTransitionShape } from "@/lib/backoffice/lead-transition";
import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import { applyRateLimit, adminMutationLimiter } from "@/lib/rate-limit";

const ALLOWED_FROM: Record<LeadStatus, LeadStatus[]> = {
  [LeadStatus.CONTACTED]: [LeadStatus.NEW],
  [LeadStatus.QUALIFIED]: [LeadStatus.CONTACTED],
  [LeadStatus.CLOSED_WON]: [LeadStatus.QUALIFIED],
  [LeadStatus.CLOSED_LOST]: [
    LeadStatus.NEW,
    LeadStatus.CONTACTED,
    LeadStatus.QUALIFIED,
  ],
  [LeadStatus.NEW]: [],
};

const NOT_CLAIMABLE = () =>
  new OpsRefusal(
    "LEAD_NOT_CLAIMABLE",
    "Lead is terminal or was advanced concurrently — reload the list.",
    409,
  );

const transition = withOpsAction(
  "leads.manage",
  "lead.transition",
  leadTransitionShape,
  {
    mode: "tx",
    run: async (tx, { params, body }) => {
      const leadId = params.leadId;
      const to = body.status;
      const prior = await tx.lead.findUnique({
        where: { id: leadId },
        select: { status: true },
      });
      if (!prior) throw new OpsRefusal("NOT_FOUND", "Lead not found.", 404);
      // A confirmation made against a status another operator has since moved is stale.
      if (body.from !== prior.status) throw NOT_CLAIMABLE();
      if (!ALLOWED_FROM[to].includes(prior.status)) throw NOT_CLAIMABLE();
      const claim = await tx.lead.updateMany({
        where: { id: leadId, status: prior.status },
        data: { status: to },
      });
      if (claim.count === 0) throw NOT_CLAIMABLE();
      const lead = await tx.lead.findUniqueOrThrow({ where: { id: leadId } });
      return {
        target: { kind: "Lead", id: leadId },
        before: { status: prior.status },
        after: { status: to },
        response: { lead },
      };
    },
  },
);

export async function PATCH(
  req: NextRequest,
  route: { params: Promise<{ leadId: string }> },
) {
  const auth = await requireBackofficeSurface("leads.manage");
  if (auth.error) return auth.error;
  const limited = await applyRateLimit(
    adminMutationLimiter,
    auth.session.user.id,
  );
  if (limited) return limited;
  return transition(req, route);
}
