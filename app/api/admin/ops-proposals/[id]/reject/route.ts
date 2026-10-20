/**
 * POST /api/admin/ops-proposals/[id]/reject — closes a live proposal without
 * running it; the proposer may withdraw their own. ADMIN, step-up, reason.
 */
import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { decideProposal } from "@/lib/backoffice/ops-proposals";

export const POST = withOpsAction(
  "payments.manage",
  "ops-proposal.reject",
  {},
  {
    mode: "tx",
    run: async (tx, { params, body, actor }) => {
      const proposal = await decideProposal(tx, {
        id: params.id,
        deciderId: actor.userId,
        decision: "REJECTED",
        reason: body.reason,
        now: new Date(),
      });
      return {
        target: { kind: "OpsActionProposal", id: proposal.id },
        before: { status: "PROPOSED" },
        after: {
          status: "REJECTED",
          action: proposal.action,
          targetKind: proposal.targetKind,
          targetId: proposal.targetId,
        },
        response: { proposalId: proposal.id, status: "REJECTED" },
      };
    },
  },
  { stepUp: true },
);
