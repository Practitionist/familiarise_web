/**
 * POST /api/admin/organizations/[orgId]/verify
 *
 * Platform-admin action: flip an Organization from PENDING_VERIFICATION
 * to ACTIVE. This is the last-mile gate before an org can create
 * contracts, invite members, or initiate payouts — an admin has reviewed
 * the verification docs (GSTIN, PAN, PO sample) and signed off.
 *
 * Admins can also SUSPEND an active org or REACTIVATE a suspended one.
 * DEACTIVATED is terminal and not reversible from this endpoint.
 */

import { z } from "zod";
import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import { purgeOrgSurfaces } from "@/lib/data/public-cache";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { ORG_STATUS_LABEL } from "@/lib/labels/org-labels";
import {
  IllegalTransitionError,
  transitionOrganization,
} from "@/lib/enterprise/transitions";
import {
  releaseSponsorTrustPark,
  type TrustParkRelease,
} from "@/lib/payments/payouts/trust-park";

// #779 §A — `REJECT` added (admin bounces a PENDING org back with a reason;
// stays PENDING_VERIFICATION). Action is upper-cased + defaults to VERIFY so
// the legacy `{}`/missing-action callers keep their verify behavior.
const ActionSchema = z.enum([
  "VERIFY",
  "REJECT",
  "SUSPEND",
  "REACTIVATE",
  "DEACTIVATE",
]);

const ACTION_PAST: Record<z.infer<typeof ActionSchema>, string> = {
  VERIFY: "verified",
  REJECT: "rejected",
  SUSPEND: "suspended",
  REACTIVATE: "reactivated",
  DEACTIVATE: "deactivated",
};

/** An org lifecycle door: ADMIN, step-up, a reason (the owner sees it on REJECT) and an ops log row. */
export const POST = withOpsAction(
  "organizations.manage",
  (body) => `organization.${body.action.toLowerCase()}`,
  {
    action: z
      .preprocess(
        (v) => (typeof v === "string" ? v.toUpperCase() : v),
        ActionSchema,
      )
      .default("VERIFY"),
  },
  {
    mode: "tx",
    run: async (tx, { params, body, actor }) => {
      const orgId = params.orgId;
      const current = await tx.organization.findUnique({
        where: { id: orgId },
      });
      if (!current) {
        throw new OpsRefusal("ORG_NOT_FOUND", "Organization not found", 404);
      }

      // Friendly pre-check only — names the offending action/state in the
      // error. Enforcement is the CAS WHERE below: a concurrent admin action
      // landing between this read and the update matches zero rows and 409s
      // instead of resurrecting a terminal state.
      const allowedFrom: Record<string, string[]> = {
        // #779 §A — REJECT keeps the org PENDING (a sub-state, not a status move).
        PENDING_VERIFICATION: ["VERIFY", "REJECT", "DEACTIVATE"],
        ACTIVE: ["SUSPEND", "DEACTIVATE"],
        SUSPENDED: ["REACTIVATE", "DEACTIVATE"],
        DEACTIVATED: [],
      };
      const allowed = allowedFrom[current.status] ?? [];
      if (!allowed.includes(body.action)) {
        throw new OpsRefusal(
          "ORG_ACTION_NOT_ALLOWED",
          `Cannot ${body.action} an organization in ${current.status} state`,
        );
      }

      const actionKey =
        body.action === "VERIFY"
          ? AUDIT_ACTIONS.SYSTEM.VERIFIED
          : body.action === "REJECT"
            ? AUDIT_ACTIONS.SYSTEM.VERIFICATION_REJECTED
            : body.action === "SUSPEND"
              ? AUDIT_ACTIONS.SYSTEM.SUSPENDED
              : body.action === "REACTIVATE"
                ? AUDIT_ACTIONS.SYSTEM.REACTIVATED
                : AUDIT_ACTIONS.SYSTEM.DEACTIVATED;

      let nextStatus = current.status;
      let released: TrustParkRelease | null = null;
      if (body.action === "REJECT") {
        // #779 §A — REJECT stamps the resubmit sub-state, not a status move.
        // Guarded on still-PENDING so a concurrent VERIFY can't be overwritten
        // back into rejection.
        const res = await tx.organization.updateMany({
          where: { id: orgId, status: "PENDING_VERIFICATION" },
          data: {
            verificationReason: body.reason,
            verificationRejectedAt: new Date(),
          },
        });
        if (res.count === 0) {
          throw new IllegalTransitionError("Organization", "REJECT");
        }
        await tx.orgAuditLog.create({
          data: {
            organizationId: orgId,
            actorMembershipId: null,
            category: "SYSTEM",
            action: actionKey,
            description: `Admin rejected the verification: stays ${ORG_STATUS_LABEL[current.status]}`,
            details: {
              adminUserId: actor.userId,
              from: current.status,
              to: current.status,
              reason: body.reason,
            },
          },
        });
      } else {
        nextStatus =
          body.action === "VERIFY" || body.action === "REACTIVATE"
            ? "ACTIVE"
            : body.action === "SUSPEND"
              ? "SUSPENDED"
              : "DEACTIVATED";

        await transitionOrganization(tx, {
          where: { id: orgId },
          to: nextStatus,
          // #779 §A — VERIFY clears the resubmit-loop sub-state.
          data:
            body.action === "VERIFY"
              ? {
                  verificationReason: null,
                  verificationSubmittedAt: null,
                  verificationRejectedAt: null,
                }
              : undefined,
          audit: {
            organizationId: orgId,
            actorMembershipId: null,
            category: "SYSTEM",
            action: actionKey,
            description: `Admin ${ACTION_PAST[body.action]} the organization: ${ORG_STATUS_LABEL[current.status]} → ${ORG_STATUS_LABEL[nextStatus]}`,
            details: {
              adminUserId: actor.userId,
              from: current.status,
              to: nextStatus,
              reason: body.reason,
            },
          },
        });

        // The trust park is keyed on the payment's sponsor, not the earner.
        if (body.action === "VERIFY") {
          released = await releaseSponsorTrustPark(tx, orgId);
        }
      }

      // updateMany returns no row — re-read in-tx for the response body.
      const updated = await tx.organization.findUniqueOrThrow({
        where: { id: orgId },
      });
      return {
        target: { kind: "Organization", id: orgId },
        before: { status: current.status },
        after: {
          status: nextStatus,
          ...(released && { trustParkReleased: { ...released } }),
        },
        response: { organization: updated },
        // ACTIVE is half the public gate: VERIFY/REACTIVATE put the org into
        // the directory, SUSPEND/DEACTIVATE take it out.
        afterCommit: () => purgeOrgSurfaces(updated.slug),
      };
    },
  },
  { stepUp: true },
);
