/**
 * POST /api/admin/ops-proposals/[id]/approve — a second ADMIN approves a held
 * money door: PROPOSED → APPROVED, then the stored body replays through the same
 * door as the approver and the row goes EXECUTED. A failed replay stays APPROVED.
 */
import prisma from "@/lib/prisma";
import {
  withOpsAction,
  type ProposableOpsDoor,
} from "@/lib/backoffice/ops-action-log";
import { OpsRefusal, refusalCode } from "@/lib/backoffice/ops-refusal";
import {
  decideProposal,
  noteProposalFailure,
} from "@/lib/backoffice/ops-proposals";
import { reportSentryError } from "@/lib/observability/report";
import { POST as refundIssue } from "@/app/api/admin/refunds/issue/route";
import { POST as legacyRefund } from "@/app/api/admin/refunds/route";
import { POST as invoiceVoid } from "@/app/api/admin/organizations/[orgId]/invoices/[invoiceId]/void/route";
import { POST as invoiceIssue } from "@/app/api/admin/organizations/[orgId]/invoices/[invoiceId]/issue/route";
import { POST as invoiceBankTransfer } from "@/app/api/admin/organizations/[orgId]/invoices/[invoiceId]/payments/route";
import { POST as overageSettleToOrg } from "@/app/api/admin/organizations/[orgId]/overages/[overageEventId]/settle-to-org/route";
import { PATCH as billingAccount } from "@/app/api/admin/organizations/[orgId]/billing-account/route";
import { POST as orgPayoutApprove } from "@/app/api/admin/org-payouts/[id]/approve/route";

const PROPOSABLE_DOORS: ReadonlyMap<string, ProposableOpsDoor> = new Map(
  [
    refundIssue,
    legacyRefund,
    invoiceVoid,
    invoiceIssue,
    invoiceBankTransfer,
    overageSettleToOrg,
    billingAccount,
    orgPayoutApprove,
  ].map((door) => [door.proposalRoute, door]),
);

export const POST = withOpsAction(
  "payments.manage",
  "ops-proposal.approve",
  {},
  {
    mode: "gateway",
    target: ({ params }) => ({ kind: "OpsActionProposal", id: params.id }),
    run: async ({ params, body, actor }) => {
      const proposal = await prisma.$transaction((tx) =>
        decideProposal(tx, {
          id: params.id,
          deciderId: actor.userId,
          decision: "APPROVED",
          reason: body.reason,
          now: new Date(),
        }),
      );
      try {
        const door = PROPOSABLE_DOORS.get(proposal.surface);
        if (!door) {
          throw new OpsRefusal(
            "PROPOSAL_DOOR_UNKNOWN",
            "This proposal names a door that no longer takes approvals.",
          );
        }
        const executed = await door.executeApproved({ proposal, actor });
        return {
          target: { kind: "OpsActionProposal", id: proposal.id },
          before: { status: "PROPOSED" },
          after: {
            proposalStatus: "EXECUTED",
            executedOpsActionLogId: executed.opsActionId,
          },
          response: {
            proposalId: proposal.id,
            status: "EXECUTED",
            executedOpsActionId: executed.opsActionId,
            result: executed.response,
          },
        };
      } catch (err) {
        await noteProposalFailure(
          proposal.id,
          body.reason,
          refusalCode(err),
        ).catch((noteErr: unknown) =>
          reportSentryError(noteErr, {
            subsystem: "admin",
            op: "ops-proposal",
          }),
        );
        throw err;
      }
    },
  },
  { stepUp: true },
);
