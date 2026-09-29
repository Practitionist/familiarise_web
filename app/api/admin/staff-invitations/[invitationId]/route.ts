import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";

/**
 * #1927 — DELETE /api/admin/staff-invitations/{invitationId} — pull a pending
 * invitation.
 *
 * ## What revocation does and does not do
 *
 * It marks the row REVOKED. That is the whole effect, and the boundary matters:
 * a revoked invitation can never be redeemed again (the accept route refuses
 * on `status !== PENDING`), but it does NOT un-invite anyone who already
 * accepted it. Revoking an ACCEPTED invitation is refused with a 409 that
 * names the real door, because the caller is asking the wrong question — the
 * person they mean already has an account, and what they want is
 * `POST /api/admin/users/{id}/suspend` (or the Team page's Suspend, which
 * runs the same `lib/moderation/side-effects.ts` path). Letting the row flip
 * to REVOKED would suggest the access went away while the account kept it.
 *
 * This is also the per-USER half of the revocation story. There is deliberately
 * no "revoke every operator at example.com": staff addresses are a mix of
 * personal and company mail, and a domain-wide action is a foot-gun that
 * would take out exactly the people a domain-based mental model says are
 * safest. See the model doc in prisma/schema.prisma.
 *
 * ## Why the row is kept
 *
 * The Team page shows a revoked invite rather than dropping it, because
 * "invited then pulled" is the question an auditor asks and an empty list
 * cannot answer. The OpsActionLog row is written by the same transaction and
 * carries the reason.
 */
export const DELETE = withOpsAction(
  "users.moderate",
  "staff.invite.revoke",
  {},
  {
    mode: "tx",
    run: async (tx, { params }) => {
      const invitationId = params.invitationId;
      if (!invitationId) {
        throw new OpsRefusal("INVALID_BODY", "Missing invitation id.", 400);
      }

      const invitation = await tx.staffInvitation.findUnique({
        where: { id: invitationId },
        select: {
          id: true,
          email: true,
          status: true,
          role: true,
          acceptedUserId: true,
        },
      });
      if (!invitation) {
        // 404, not 403: the surface gate above already established that this
        // operator may act on invitations, so there is nothing here to hide
        // from them.
        throw new OpsRefusal(
          "NOT_FOUND",
          "That invitation no longer exists.",
          404,
        );
      }

      if (invitation.status === "ACCEPTED" || invitation.acceptedUserId) {
        throw new OpsRefusal(
          "ALREADY_ACCEPTED",
          "This invitation was already accepted, so the account exists. Suspend the operator from the Team page to remove their access.",
          409,
        );
      }
      if (invitation.status === "REVOKED") {
        // Idempotent rather than an error: a double-click on a row that is
        // about to disappear from the list is not a mistake worth a red toast.
        return {
          target: { kind: "StaffInvitation", id: invitationId },
          after: { status: "REVOKED", alreadyRevoked: true },
          response: { invitationId, status: "REVOKED", alreadyRevoked: true },
        };
      }
      if (invitation.status === "EXPIRED") {
        throw new OpsRefusal(
          "ALREADY_EXPIRED",
          "This invitation expired on its own — there is nothing to revoke.",
          409,
        );
      }

      // CAS in the WHERE rather than trusting the read above: an admin who
      // revokes while another admin accepts must not resurrect the row.
      const revoked = await tx.staffInvitation.updateMany({
        where: { id: invitationId, status: "PENDING" },
        data: { status: "REVOKED", revokedAt: new Date() },
      });
      if (revoked.count === 0) {
        throw new OpsRefusal(
          "ALREADY_ACCEPTED",
          "That invitation was redeemed while you were looking at it.",
          409,
        );
      }

      return {
        target: { kind: "StaffInvitation", id: invitationId },
        correlationId: `staff-invitation:${invitationId}`,
        before: { status: "PENDING", email: invitation.email },
        after: { status: "REVOKED", role: invitation.role },
        response: { invitationId, status: "REVOKED", alreadyRevoked: false },
      };
    },
  },
);
